'use strict';
// Tolerant recursive-descent parser for .proto files: proto2, proto3 and editions (2023, 2024).
// Written for this extension from the protobuf language specification. It never throws: syntax errors are collected
// with protoc-like messages, the parser skips to the next statement and keeps going, so the outline, go to definition
// and the formatter still work on a file that is being edited.

const { tokenize, unquote, intValue } = require('./lexer');

const SCALARS = new Set(['double', 'float', 'int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64', 'fixed32', 'fixed64', 'sfixed32', 'sfixed64', 'bool', 'string', 'bytes']);
const LABELS = new Set(['optional', 'required', 'repeated']);
const MAX_FIELD = 536870911;

function rangeOf(a, b) { b = b || a; return { line: a.line, col: a.col, endLine: b.endLine, endCol: b.endCol }; }

function cleanComment(raw) {
  if (raw.startsWith('//')) return raw.replace(/^\/\/\/?\s?/, '');
  let s = raw.replace(/^\/\*+/, '').replace(/\*+\/$/, '');
  const lines = s.split('\n').map((l) => l.replace(/^\s*\*( |$)/, '').replace(/^\s+/, (m) => m));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)[0].length));
  return lines.map((l) => l.slice(Number.isFinite(ind) ? ind : 0)).join('\n');
}

function parse(text) {
  const { tokens: all, errors: lexErrors } = tokenize(text);
  const sig = [];
  const sigIndexInAll = [];
  all.forEach((t, i) => { if (t.kind !== 'comment') { sig.push(t); sigIndexInAll.push(i); } });

  // leading and trailing comments of significant tokens (protoc rules, simplified)
  function leading(si) {
    const ai = sigIndexInAll[si];
    if (ai === undefined) return '';
    const out = [];
    let gap = all[ai].nlBefore;
    for (let k = ai - 1; k >= 0 && all[k].kind === 'comment'; k--) {
      if (gap > 1) break;
      const c = all[k];
      if (c.nlBefore === 0 && k > 0) break; // trailing comment of the previous token
      out.unshift(cleanComment(c.value));
      gap = c.nlBefore;
    }
    return out.join('\n').trim();
  }
  function trailing(si) {
    const ai = sigIndexInAll[si];
    if (ai === undefined) return '';
    const c = all[ai + 1];
    if (c && c.kind === 'comment' && c.nlBefore === 0) return cleanComment(c.value).trim();
    return '';
  }

  const errors = lexErrors.map((e) => ({ ...e, severity: 'error' }));
  const file = {
    syntax: null, syntaxRange: null, edition: null, package: null, packageRange: null,
    imports: [], options: [], messages: [], enums: [], services: [], extends: [],
    refs: [], optionRefs: [], errors, tokens: all, text,
  };
  let p = 0;
  const EOF = { kind: 'eof', value: '', line: sig.length ? sig[sig.length - 1].endLine : 0, col: sig.length ? sig[sig.length - 1].endCol : 0, endLine: sig.length ? sig[sig.length - 1].endLine : 0, endCol: sig.length ? sig[sig.length - 1].endCol : 0 };
  const peek = (k = 0) => sig[p + k] || EOF;
  const next = () => sig[p++] || EOF;
  const is = (v, k = 0) => { const t = peek(k); return t.kind !== 'eof' && t.kind !== 'string' && t.value === v; };
  const isIdent = (k = 0) => peek(k).kind === 'ident';
  const err = (tok, message, severity = 'error') => {
    errors.push({ message, line: tok.line, col: tok.col, endLine: tok.kind === 'eof' ? tok.line : tok.endLine, endCol: tok.kind === 'eof' ? tok.col : tok.endCol, severity });
  };
  class Stop extends Error {}
  const expect = (v, what) => {
    if (is(v)) return next();
    err(peek(), `Expected ${what || `"${v}"`}.`);
    throw new Stop();
  };
  const expectIdent = (what) => {
    if (isIdent()) return next();
    err(peek(), `Expected ${what}.`);
    throw new Stop();
  };

  // skip to the end of the broken statement: a ";" (eaten) or a balanced block, or the "}" of the parent (left)
  function recover() {
    let depth = 0;
    while (peek().kind !== 'eof') {
      const t = peek();
      if (t.kind === 'sym' && t.value === '{') { depth++; next(); continue; }
      if (t.kind === 'sym' && t.value === '}') {
        if (depth === 0) return;
        depth--; next();
        if (depth === 0) { if (is(';')) next(); return; }
        continue;
      }
      if (t.kind === 'sym' && t.value === ';' && depth === 0) { next(); return; }
      next();
    }
  }

  function fullIdent(allowDot) {
    const first = peek();
    let name = '';
    if (allowDot && is('.')) { next(); name = '.'; }
    const a = expectIdent('a name');
    name += a.value;
    let last = a;
    while (is('.') && peek(1).kind === 'ident') { next(); last = next(); name += '.' + last.value; }
    return { name, range: rangeOf(first, last), first, last };
  }

  // option name: ( ident | "(" ["."] fullIdent ")" ) { "." ( ident | "(" fullIdent ")" ) }
  function optionName() {
    const first = peek();
    let name = '';
    const ext = [];
    let last = first;
    for (;;) {
      if (is('(')) {
        next();
        const f = fullIdent(true);
        last = expect(')', '")"');
        name += `(${f.name})`;
        ext.push({ name: f.name, range: f.range });
      } else {
        last = expectIdent('an option name');
        name += last.value;
      }
      if (is('.')) { next(); name += '.'; continue; }
      break;
    }
    return { name, range: rangeOf(first, last), ext };
  }

  // constant: aggregate { ... }, a list [ ... ] (text format only), signed number, identifier, adjacent strings
  function constant() {
    const first = peek();
    if (is('{')) {
      let depth = 0;
      let last = first;
      do {
        const t = next();
        if (t.kind === 'eof') { err(t, 'Reached end of input in an option value (missing "}").'); throw new Stop(); }
        if (t.kind === 'sym' && t.value === '{') depth++;
        if (t.kind === 'sym' && t.value === '}') depth--;
        last = t;
      } while (depth > 0);
      return { kind: 'aggregate', text: text.slice(first.start, last.end), range: rangeOf(first, last) };
    }
    if (first.kind === 'string') {
      let s = '';
      let last = first;
      while (peek().kind === 'string') { last = next(); s += unquote(last); }
      return { kind: 'string', value: s, text: text.slice(first.start, last.end), range: rangeOf(first, last) };
    }
    let sign = '';
    if (is('-') || is('+')) sign = next().value;
    const t = peek();
    if (t.kind === 'int' || t.kind === 'float') {
      next();
      return { kind: t.kind, value: sign === '-' ? -Number(t.kind === 'int' ? intValue(t) : parseFloat(t.value)) : Number(t.kind === 'int' ? intValue(t) : parseFloat(t.value)), text: sign + t.value, range: rangeOf(first, t) };
    }
    if (t.kind === 'ident') {
      const f = fullIdent(false);
      return { kind: 'ident', value: sign + f.name, text: sign + f.name, range: rangeOf(first, f.last) };
    }
    err(t, 'Expected a constant value.');
    throw new Stop();
  }

  function fieldOptions() {
    const list = [];
    if (!is('[')) return list;
    next();
    for (;;) {
      const nm = optionName();
      for (const e of nm.ext) file.optionRefs.push(e);
      expect('=', '"="');
      const v = constant();
      list.push({ name: nm.name, nameRange: nm.range, value: v });
      if (is(',')) { next(); continue; }
      expect(']', '"]"');
      break;
    }
    return list;
  }

  function optionStatement(owner) {
    const kw = next(); // option
    const nm = optionName();
    for (const e of nm.ext) file.optionRefs.push(e);
    expect('=', '"="');
    const v = constant();
    const end = expect(';', '";"');
    owner.push({ name: nm.name, nameRange: nm.range, value: v, range: rangeOf(kw, end) });
  }

  function typeRef(container, kind) {
    const f = fullIdent(true);
    if (!SCALARS.has(f.name)) file.refs.push({ name: f.name, range: f.range, container, kind });
    return f;
  }

  function ranges(owner, allowNames, kw) {
    // reserved / extensions: int [to (int|max)] {, ...} | string {, string} | ident {, ident} (editions)
    const out = { ranges: [], names: [] };
    for (;;) {
      const t = peek();
      if (t.kind === 'string' && allowNames) { next(); out.names.push({ name: unquote(t), range: rangeOf(t) }); }
      else if (t.kind === 'ident' && allowNames && t.value !== 'max') {
        next();
        out.names.push({ name: t.value, range: rangeOf(t), bare: true });
      } else {
        let neg = false;
        const st = peek();
        if (is('-')) { next(); neg = true; }
        const a = peek();
        if (a.kind !== 'int') { err(a, `Expected ${allowNames ? 'a field number or a name' : 'a field number'}.`); throw new Stop(); }
        next();
        let lo = intValue(a) * (neg ? -1 : 1);
        let hi = lo;
        let endTok = a;
        if (is('to')) {
          next();
          if (is('max')) { endTok = next(); hi = owner === 'enum' ? 2147483647 : MAX_FIELD; }
          else {
            let n2 = false;
            if (is('-')) { next(); n2 = true; }
            const b = peek();
            if (b.kind !== 'int') { err(b, 'Expected an integer.'); throw new Stop(); }
            next();
            endTok = b;
            hi = intValue(b) * (n2 ? -1 : 1);
          }
        }
        if (hi < lo) err(st, 'Reserved range end number must be greater than start number.');
        out.ranges.push({ lo, hi, range: rangeOf(st, endTok), text: text.slice(st.start, endTok.end) });
      }
      if (is(',')) { next(); continue; }
      break;
    }
    void kw;
    return out;
  }

  function newMessage(nameTok, parent, extra) {
    return {
      kind: 'message', name: nameTok.value, nameRange: rangeOf(nameTok), range: null, parent,
      fields: [], oneofs: [], messages: [], enums: [], extends: [], reserved: { ranges: [], names: [] }, extensions: [],
      options: [], comment: '', ...extra,
    };
  }

  function field(msg, oneof, inExtend) {
    const first = peek();
    const startIdx = p;
    let label = null;
    let labelTok = null;
    if (peek().kind === 'ident' && LABELS.has(peek().value) && (isIdent(1) || is('.', 1))) { labelTok = next(); label = labelTok.value; }
    // group: [label] group Name = N [opts] { body }
    if (is('group') && isIdent(1) && is('=', 2)) {
      const gk = next();
      const nameTok = next();
      if (!/^[A-Z]/.test(nameTok.value)) err(nameTok, 'Group names must start with a capital letter.');
      next(); // =
      const numTok = peek();
      if (numTok.kind !== 'int') { err(numTok, 'Expected field number.'); throw new Stop(); }
      next();
      const opts = fieldOptions();
      const g = newMessage(nameTok, msg, { isGroup: true, comment: leading(startIdx) });
      expect('{', '"{"');
      messageBody(g);
      const close = expect('}', '"}"');
      g.range = rangeOf(first, close);
      msg.messages.push(g);
      const f = {
        kind: 'field', label, labelTok: labelTok && rangeOf(labelTok), type: nameTok.value, typeRange: rangeOf(nameTok), name: nameTok.value.toLowerCase(), nameRange: rangeOf(nameTok),
        number: intValue(numTok), numberRange: rangeOf(numTok), options: opts, comment: g.comment, oneof: oneof ? oneof.name : null, group: g, range: rangeOf(first, close), groupTok: rangeOf(gk),
      };
      file.refs.push({ name: nameTok.value, range: rangeOf(nameTok), container: msg, kind: 'field', group: true });
      return f;
    }
    let map = null;
    let type;
    let typeRange;
    if (is('map') && is('<', 1)) {
      const mk = next(); next();
      const k = fullIdent(false);
      expect(',', '","');
      const v = typeRef(msg, 'map');
      const gt = expect('>', '">"');
      map = { key: k.name, keyRange: k.range, value: v.name, valueRange: v.range };
      type = `map<${k.name}, ${v.name}>`;
      typeRange = rangeOf(mk, gt);
    } else {
      const t = typeRef(inExtend ? inExtend.parent : msg, 'field');
      type = t.name;
      typeRange = t.range;
    }
    const nameTok = expectIdent('field name');
    expect('=', '"="');
    let neg = false;
    if (is('-')) { next(); neg = true; }
    const numTok = peek();
    if (numTok.kind !== 'int') { err(numTok, 'Expected field number.'); throw new Stop(); }
    next();
    const opts = fieldOptions();
    const end = expect(';', '";"');
    return {
      kind: 'field', label, labelTok: labelTok && rangeOf(labelTok), type, typeRange, name: nameTok.value, nameRange: rangeOf(nameTok),
      number: intValue(numTok) * (neg ? -1 : 1), numberRange: rangeOf(numTok), options: opts, comment: leading(startIdx), trailing: trailing(p - 1),
      oneof: oneof ? oneof.name : null, map, range: rangeOf(first, end),
    };
  }

  function statement(fn) {
    const save = p;
    try { fn(); } catch (e) {
      if (!(e instanceof Stop)) throw e;
      if (p === save) next();
      recover();
    }
  }

  function messageBody(msg) {
    while (!is('}') && peek().kind !== 'eof') {
      const t = peek();
      if (is(';')) { next(); continue; }
      statement(() => {
        if (is('message') && isIdent(1) && is('{', 2)) return message(msg, msg.messages);
        if (is('enum') && isIdent(1) && is('{', 2)) return enumDef(msg, msg.enums);
        if (is('extend') && (isIdent(1) || is('.', 1))) return extend(msg, msg.extends);
        if (is('option') && (isIdent(1) || is('(', 1))) return optionStatement(msg.options);
        if (is('oneof') && isIdent(1) && is('{', 2)) return oneofDef(msg);
        if (is('reserved') && (peek(1).kind === 'int' || peek(1).kind === 'string' || is('-', 1) || (isIdent(1) && !is('=', 2) && !is('.', 2) && !isIdent(2)))) {
          const kw = next();
          const r = ranges('message', true, kw);
          const end = expect(';', '";"');
          msg.reserved.ranges.push(...r.ranges.map((x) => ({ ...x, stmt: rangeOf(kw, end) })));
          msg.reserved.names.push(...r.names);
          return;
        }
        if (is('extensions') && (peek(1).kind === 'int')) {
          const kw = next();
          const r = ranges('message', false, kw);
          const opts = fieldOptions();
          expect(';', '";"');
          msg.extensions.push(...r.ranges.map((x) => ({ ...x, options: opts, kwRange: rangeOf(kw) })));
          return;
        }
        if (t.kind !== 'ident' && !is('.')) { err(t, 'Expected a field, "message", "enum", "oneof", "option", "reserved" or "}".'); throw new Stop(); }
        msg.fields.push(field(msg, null, null));
      });
    }
  }

  function message(parent, list) {
    const kw = next();
    const startIdx = p - 1;
    const nameTok = next();
    const m = newMessage(nameTok, parent, { comment: leading(startIdx) });
    expect('{', '"{"');
    messageBody(m);
    if (peek().kind === 'eof') { err(peek(), `Reached end of input in message definition (missing "}").`); m.range = rangeOf(kw, peek()); list.push(m); return; }
    const close = next();
    m.range = rangeOf(kw, close);
    list.push(m);
  }

  function oneofDef(msg) {
    const kw = next();
    const startIdx = p - 1;
    const nameTok = next();
    const o = { kind: 'oneof', name: nameTok.value, nameRange: rangeOf(nameTok), options: [], fields: [], comment: leading(startIdx), parent: msg };
    expect('{', '"{"');
    while (!is('}') && peek().kind !== 'eof') {
      if (is(';')) { next(); continue; }
      statement(() => {
        if (is('option') && (isIdent(1) || is('(', 1))) return optionStatement(o.options);
        const f = field(msg, o, null);
        o.fields.push(f);
        msg.fields.push(f);
      });
    }
    const close = expect('}', '"}"');
    o.range = rangeOf(kw, close);
    msg.oneofs.push(o);
  }

  function enumDef(parent, list) {
    const kw = next();
    const startIdx = p - 1;
    const nameTok = next();
    const e = { kind: 'enum', name: nameTok.value, nameRange: rangeOf(nameTok), values: [], reserved: { ranges: [], names: [] }, options: [], comment: leading(startIdx), parent };
    expect('{', '"{"');
    while (!is('}') && peek().kind !== 'eof') {
      if (is(';')) { next(); continue; }
      statement(() => {
        if (is('option') && (isIdent(1) || is('(', 1))) return optionStatement(e.options);
        if (is('reserved') && !is('=', 1)) {
          const kw2 = next();
          const r = ranges('enum', true, kw2);
          expect(';', '";"');
          e.reserved.ranges.push(...r.ranges);
          e.reserved.names.push(...r.names);
          return;
        }
        const vStart = p;
        const nm = expectIdent('an enum value name');
        expect('=', '"="');
        let neg = false;
        if (is('-')) { next(); neg = true; }
        const numTok = peek();
        if (numTok.kind !== 'int') { err(numTok, 'Expected integer.'); throw new Stop(); }
        next();
        const opts = fieldOptions();
        expect(';', '";"');
        e.values.push({ kind: 'enumValue', name: nm.value, nameRange: rangeOf(nm), number: intValue(numTok) * (neg ? -1 : 1), numberRange: rangeOf(numTok), options: opts, comment: leading(vStart), trailing: trailing(p - 1), parent: e });
      });
    }
    if (peek().kind === 'eof') { err(peek(), 'Reached end of input in enum definition (missing "}").'); e.range = rangeOf(kw, peek()); list.push(e); return; }
    const close = next();
    e.range = rangeOf(kw, close);
    list.push(e);
  }

  function extend(parent, list) {
    const kw = next();
    const startIdx = p - 1;
    const scope = parent;
    const t = typeRef(scope, 'extend');
    const x = { kind: 'extend', extendee: t.name, extendeeRange: t.range, fields: [], parent, comment: leading(startIdx) };
    expect('{', '"{"');
    while (!is('}') && peek().kind !== 'eof') {
      if (is(';')) { next(); continue; }
      statement(() => {
        const holder = parent && parent.kind === 'message' ? parent : { kind: 'file-scope', messages: [] };
        const f = field(holder, null, x);
        if (f.group && holder.kind === 'file-scope') file.messages.push(...holder.messages.map((g) => ({ ...g, parent: null })));
        x.fields.push(f);
      });
    }
    const close = expect('}', '"}"');
    x.range = rangeOf(kw, close);
    list.push(x);
  }

  function service() {
    const kw = next();
    const startIdx = p - 1;
    const nameTok = expectIdent('service name');
    const s = { kind: 'service', name: nameTok.value, nameRange: rangeOf(nameTok), rpcs: [], options: [], comment: leading(startIdx) };
    expect('{', '"{"');
    while (!is('}') && peek().kind !== 'eof') {
      if (is(';')) { next(); continue; }
      statement(() => {
        if (is('option') && (isIdent(1) || is('(', 1))) return optionStatement(s.options);
        if (!is('rpc')) { err(peek(), 'Expected "rpc", "option" or "}".'); throw new Stop(); }
        const rk = next();
        const rStart = p - 1;
        const rn = expectIdent('method name');
        expect('(', '"("');
        let inStream = false;
        if (is('stream') && !is(')', 1)) { next(); inStream = true; }
        const it = typeRef(s, 'rpc');
        expect(')', '")"');
        expect('returns', '"returns"');
        expect('(', '"("');
        let outStream = false;
        if (is('stream') && !is(')', 1)) { next(); outStream = true; }
        const ot = typeRef(s, 'rpc');
        expect(')', '")"');
        const rpc = { kind: 'rpc', name: rn.value, nameRange: rangeOf(rn), input: it.name, inputRange: it.range, inputStream: inStream, output: ot.name, outputRange: ot.range, outputStream: outStream, options: [], comment: leading(rStart), parent: s };
        let end;
        if (is('{')) {
          next();
          while (!is('}') && peek().kind !== 'eof') {
            if (is(';')) { next(); continue; }
            statement(() => {
              if (is('option')) return optionStatement(rpc.options);
              err(peek(), 'Expected "option" or "}".');
              throw new Stop();
            });
          }
          end = expect('}', '"}"');
          if (is(';')) end = next();
        } else end = expect(';', '";" or "{"');
        rpc.range = rangeOf(rk, end);
        s.rpcs.push(rpc);
      });
    }
    if (peek().kind === 'eof') { err(peek(), 'Reached end of input in service definition (missing "}").'); s.range = rangeOf(kw, peek()); file.services.push(s); return; }
    const close = next();
    s.range = rangeOf(kw, close);
    file.services.push(s);
  }

  // ----- top level -----
  let first = true;
  while (peek().kind !== 'eof') {
    if (is(';')) { next(); continue; }
    const t = peek();
    statement(() => {
      if ((is('syntax') || is('edition')) && is('=', 1)) {
        const kw = next(); next();
        const v = peek();
        if (v.kind !== 'string') { err(v, 'Expected a string naming the syntax or edition.'); throw new Stop(); }
        next();
        let val = unquote(v);
        while (peek().kind === 'string') val += unquote(next());
        const end = expect(';', '";"');
        if (!first) err(kw, `"${kw.value}" must be the first statement of the file.`);
        if (kw.value === 'syntax') {
          file.syntax = val;
          if (val !== 'proto2' && val !== 'proto3') err(v, `Unrecognized syntax identifier "${val}".  This parser only recognizes "proto2" and "proto3".`);
        } else {
          file.syntax = 'editions';
          file.edition = val;
          if (!/^20\d\d$/.test(val)) err(v, `Unknown edition "${val}".`);
        }
        file.syntaxRange = rangeOf(kw, end);
        return;
      }
      first = false;
      if (is('package') && (isIdent(1))) {
        const kw = next();
        const f = fullIdent(false);
        const end = expect(';', '";"');
        if (file.package !== null) err(kw, 'Multiple package definitions.');
        else { file.package = f.name; file.packageRange = f.range; file.packageStmt = rangeOf(kw, end); }
        return;
      }
      if (is('import')) {
        const kw = next();
        let kind = '';
        if (is('public') || is('weak') || is('option')) kind = next().value;
        const s = peek();
        if (s.kind !== 'string') { err(s, 'Expected a string naming the file to import.'); throw new Stop(); }
        next();
        let path = unquote(s);
        let last = s;
        while (peek().kind === 'string') { last = next(); path += unquote(last); }
        const end = expect(';', '";"');
        file.imports.push({ path, kind, range: rangeOf(s, last), stmt: rangeOf(kw, end) });
        return;
      }
      if (is('option') && (isIdent(1) || is('(', 1))) return optionStatement(file.options);
      if (is('message') && isIdent(1)) return message(null, file.messages);
      if (is('enum') && isIdent(1)) return enumDef(null, file.enums);
      if (is('service') && isIdent(1)) return service();
      if (is('extend') && (isIdent(1) || is('.', 1))) return extend(null, file.extends);
      err(t, 'Expected top-level statement (e.g. "message").');
      throw new Stop();
    });
    if (first && p > 0) first = false;
  }
  assignNames(file);
  return file;
}

// full names: package + nesting. Adds file.defs, a flat list of { fullName, node, kind }.
function assignNames(file) {
  const pkg = file.package || '';
  const defs = [];
  const join = (a, b) => (a ? `${a}.${b}` : b);
  function walkMsg(m, scope) {
    m.fullName = join(scope, m.name);
    m.scope = scope;
    defs.push({ fullName: m.fullName, node: m, kind: 'message' });
    for (const f of m.fields) { f.fullName = join(m.fullName, f.name); f.scope = m.fullName; }
    for (const o of m.oneofs) { o.fullName = join(m.fullName, o.name); }
    for (const e of m.enums) walkEnum(e, m.fullName);
    for (const c of m.messages) walkMsg(c, m.fullName);
    for (const x of m.extends) walkExt(x, m.fullName);
  }
  function walkEnum(e, scope) {
    e.fullName = join(scope, e.name);
    e.scope = scope;
    defs.push({ fullName: e.fullName, node: e, kind: 'enum' });
    // enum values are siblings of their enum (C++ scoping rules)
    for (const v of e.values) { v.fullName = join(scope, v.name); v.scope = scope; }
  }
  function walkExt(x, scope) {
    x.scope = scope;
    for (const f of x.fields) {
      f.fullName = join(scope, f.name);
      f.scope = scope;
      f.extendee = x.extendee;
      defs.push({ fullName: f.fullName, node: f, kind: 'extension' });
    }
  }
  for (const m of file.messages) walkMsg(m, pkg);
  for (const e of file.enums) walkEnum(e, pkg);
  for (const x of file.extends) walkExt(x, pkg);
  for (const s of file.services) {
    s.fullName = join(pkg, s.name);
    s.scope = pkg;
    defs.push({ fullName: s.fullName, node: s, kind: 'service' });
    for (const r of s.rpcs) { r.fullName = join(s.fullName, r.name); }
  }
  for (const r of file.refs) r.scope = r.container ? (r.container.fullName || pkg) : pkg;
  file.defs = defs;
}

/** Value of an option by name from a list ("allow_alias", "json_name", "deprecated" ...). */
function optionValue(options, name) {
  const o = (options || []).find((x) => x.name === name);
  if (!o) return undefined;
  const v = o.value;
  if (v.kind === 'string') return v.value;
  if (v.kind === 'ident') return v.value === 'true' ? true : v.value === 'false' ? false : v.value;
  if (v.kind === 'int' || v.kind === 'float') return v.value;
  return v.text;
}

module.exports = { parse, optionValue, SCALARS, MAX_FIELD, cleanComment };

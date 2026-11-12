'use strict';
// Diagnostics for one .proto file. The rules and most messages follow protoc, so a red mark here means protoc fails
// too. When something cannot be known (an import that is not in the workspace), the check stays quiet instead of
// guessing: no false red marks.

const { optionValue, SCALARS, MAX_FIELD } = require('./parser');
const { TYPE_KINDS } = require('./index');

const MAP_KEYS = new Set(['int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64', 'fixed32', 'fixed64', 'sfixed32', 'sfixed64', 'bool', 'string']);
const PACKABLE = new Set(['double', 'float', 'int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64', 'fixed32', 'fixed64', 'sfixed32', 'sfixed64', 'bool']);

/**
 * @returns {Array<{ message, severity: 'error'|'warning'|'info'|'hint', range, unnecessary?: boolean, code?: string }>}
 */
function check(index, file, opts = {}) {
  const a = index.get(file);
  if (!a) return [];
  const out = [];
  const add = (range, message, severity = 'error', extra = {}) => { if (range) out.push({ message, severity, range, ...extra }); };
  for (const e of a.errors) add({ line: e.line, col: e.col, endLine: e.endLine, endCol: e.endCol }, e.message, e.severity || 'error', { code: 'syntax' });
  const syntax = a.syntax || 'proto2';
  const editions = syntax === 'editions';
  const firstTok = a.tokens.find((t) => t.kind !== 'comment');
  if (!a.syntax && firstTok) {
    add({ line: firstTok.line, col: firstTok.col, endLine: firstTok.endLine, endCol: firstTok.endCol }, 'No syntax specified for the proto file. Please use \'syntax = "proto2";\' or \'syntax = "proto3";\' to specify a syntax version. (Defaulted to proto2 syntax.)', 'warning', { code: 'no-syntax' });
  }

  // ----- imports -----
  const missing = index.missingImports(file);
  const seenImp = new Map();
  for (const imp of a.imports) {
    if (seenImp.has(imp.path)) add(imp.range, `Import "${imp.path}" was listed twice.`);
    seenImp.set(imp.path, imp);
  }
  for (const { imp } of missing) {
    add(imp.range, `Import "${imp.path}" was not found. Add the folder it is in to the "zovoProto.importPaths" setting (as with protoc -I).`, 'warning', { code: 'import-not-found' });
  }
  const incomplete = missing.length > 0;
  const usedFiles = new Set();
  let unresolvedOption = false;

  // ----- type references -----
  const resolveRef = (r) => {
    const kinds = r.kind === 'extend' ? new Set(['message']) : r.kind === 'rpc' ? new Set(['message']) : TYPE_KINDS;
    const res = index.lookup(file, r.name, r.scope, kinds);
    if (res.def) { if (res.def.file) usedFiles.add(res.def.file); else if (res.def.builtin) usedFiles.add('builtin'); return res.def; }
    if (res.wildcard) { usedFiles.add('builtin'); return null; }
    if (res.notImported) {
      add(r.range, `"${r.name}" seems to be defined in "${relName(res.notImported.file)}", which is not imported by "${relName(file)}".  To use it here, please add the necessary import.`);
      return null;
    }
    if (incomplete) return null;
    if (res.error === 'innermost') add(r.range, `"${r.name}" is resolved to "${res.resolvedTo}", which is not defined. The innermost scope is searched first in name resolution. Consider using a leading '.'(i.e., ".${r.name}") to start from the outermost scope.`);
    else if (res.error === 'kind') add(r.range, r.kind === 'rpc' || r.kind === 'extend' ? `"${r.name}" is not a message type.` : `"${r.name}" is not a type.`);
    else add(r.range, `"${r.name}" is not defined.`);
    return null;
  };
  const relName = (f) => {
    const root = index.rootFor(f);
    return root ? f.slice(root.length + 1).split('\\').join('/') : f.split(/[\\/]/).pop();
  };
  const refDefs = new Map();
  for (const r of a.refs) refDefs.set(r, resolveRef(r));
  for (const r of a.optionRefs) {
    const res = index.lookup(file, r.name, a.package || '', new Set(['extension']));
    if (res.def) { if (res.def.file) usedFiles.add(res.def.file); }
    else if (!res.wildcard) unresolvedOption = true;
  }
  const typeOf = (f) => {
    const r = a.refs.find((x) => x.range === f.typeRange || (f.map && x.range === f.map.valueRange));
    return r ? refDefs.get(r) : null;
  };

  // ----- names in a scope -----
  const scopes = new Map(); // scope full name -> Map(name -> what)
  const define = (scope, name, range, what, owner) => {
    if (!scopes.has(scope)) scopes.set(scope, new Map());
    const m = scopes.get(scope);
    if (m.has(name)) {
      const prev = m.get(name);
      if (what === 'enum value' && prev === 'enum value') {
        add(range, `"${name}" is already defined in "${scope}".  Note that enum values use C++ scoping rules, meaning that enum values are siblings of their type, not children of it.  Therefore, "${name}" must be unique within "${scope}", not just within "${owner || 'the enum'}".`);
      } else add(range, `"${name}" is already defined in "${scope}".`);
      return;
    }
    m.set(name, what);
  };
  const pkg = a.package || '';

  // editions: a feature set on the enum, else on an enclosing message, else on the file
  // (as "option features.enum_type = CLOSED;" or inside "option features = { enum_type: CLOSED };")
  function featureIn(options, name) {
    const v = optionValue(options, `features.${name}`);
    if (v !== undefined) return v;
    const agg = (options || []).find((o) => o.name === 'features' && o.value.kind === 'aggregate');
    if (agg) { const m = new RegExp(`\\b${name}\\s*:\\s*([A-Za-z_][A-Za-z0-9_]*)`).exec(agg.value.text); if (m) return m[1]; }
    return undefined;
  }
  function feature(node, name) {
    for (let n = node; n; n = n.parent) {
      const v = featureIn(n.options, name);
      if (v !== undefined) return v;
    }
    return featureIn(a.options, name);
  }

  function checkEnum(e, scope) {
    define(scope, e.name, e.nameRange, 'enum');
    if (!e.values.length) add(e.nameRange, 'Enums must contain at least one value.');
    const open = syntax === 'proto3' || (editions && feature(e, 'enum_type') !== 'CLOSED');
    if (e.values.length && syntax === 'proto3' && e.values[0].number !== 0) add(e.values[0].numberRange, 'The first enum value must be zero for open enums.');
    else if (e.values.length && editions && open && e.values[0].number !== 0) add(e.values[0].numberRange, 'The first enum value must be zero for open enums.');
    const alias = optionValue(e.options, 'allow_alias') === true;
    const byNum = new Map();
    let aliased = false;
    for (const v of e.values) {
      define(scope, v.name, v.nameRange, 'enum value', e.name);
      if (v.number > 2147483647 || v.number < -2147483648) add(v.numberRange, 'Integer out of range.');
      if (byNum.has(v.number)) {
        aliased = true;
        if (!alias) add(v.nameRange, `"${joinName(scope, v.name)}" uses the same enum value as "${joinName(scope, byNum.get(v.number).name)}". If this is intended, set 'option allow_alias = true;' to the enum definition. The next available enum value is ${Math.max(...e.values.map((x) => x.number)) + 1}.`);
      } else byNum.set(v.number, v);
      for (const r of e.reserved.ranges) if (v.number >= r.lo && v.number <= r.hi) add(v.numberRange, `Enum value "${v.name}" uses reserved number ${v.number}.`);
      if (e.reserved.names.some((n) => n.name === v.name)) add(v.nameRange, `Enum value "${v.name}" is reserved.`);
    }
    if (alias && !aliased && e.values.length) add(e.nameRange, `"${e.fullName}" declares support for enum aliases but no enum values share field numbers. Please remove the unnecessary 'option allow_alias = true;' declaration.`);
  }

  function checkField(f, m, inOneof) {
    if (f.number <= 0) add(f.numberRange, 'Field numbers must be positive integers.');
    else if (f.number > MAX_FIELD) add(f.numberRange, `Field numbers cannot be greater than ${MAX_FIELD}.`);
    else if (f.number >= 19000 && f.number <= 19999) add(f.numberRange, `Field numbers 19000 through 19999 are reserved for the protocol buffer library implementation.`);
    if (inOneof && f.label) add(f.labelTok, 'Fields in oneofs must not have labels (required / optional / repeated).');
    if (f.map) {
      if (f.label) add(f.labelTok, 'Field labels (required/optional/repeated) are not allowed on map fields.');
      if (inOneof) add(f.typeRange, 'Map fields are not allowed in oneofs.');
      if (!MAP_KEYS.has(f.map.key)) add(f.map.keyRange, 'Key in map fields cannot be float/double, bytes or message types.');
    }
    if (!inOneof && !f.map) {
      if (syntax === 'proto2' && !f.label && !(m && m.isExtendHolder)) add(f.typeRange, 'Expected "required", "optional", or "repeated".');
      if (syntax === 'proto3' && f.label === 'required') add(f.labelTok, 'Required fields are not allowed in proto3.');
      if (editions && f.label === 'optional') add(f.labelTok, 'Label "optional" is not supported in editions. By default, all singular fields have presence unless features.field_presence is set.');
      if (editions && f.label === 'required') add(f.labelTok, 'Label "required" is not supported in editions, use features.field_presence = LEGACY_REQUIRED.');
    }
    if (f.group && syntax === 'proto3') add(f.groupTok, 'Groups are not supported in proto3 syntax.');
    if (f.group && editions) add(f.groupTok, 'Group syntax is no longer supported in editions. To get group behavior you can specify features.message_encoding = DELIMITED on a message field.');
    const dflt = (f.options || []).find((o) => o.name === 'default');
    if (dflt && syntax === 'proto3') add(dflt.nameRange, 'Explicit default values are not allowed in proto3.');
    if (dflt && f.label === 'repeated') add(dflt.nameRange, 'Repeated fields can\'t have default values.');
    const packed = (f.options || []).find((o) => o.name === 'packed');
    if (packed && (f.label !== 'repeated' || (SCALARS.has(f.type) && !PACKABLE.has(f.type)))) add(packed.nameRange, '[packed = true] can only be specified for repeated primitive fields.');
    if (packed && editions) add(packed.nameRange, 'Field option packed is not allowed under editions.  Use the repeated_field_encoding feature to control this behavior.');
    if (packed && f.label === 'repeated' && !SCALARS.has(f.type)) {
      const d = typeOf(f);
      if (d && d.kind === 'message') add(packed.nameRange, '[packed = true] can only be specified for repeated primitive fields.');
    }
    if (f.map && !SCALARS.has(f.map.value)) { /* value type checked by the ref pass */ }
  }

  function checkMessage(m, scope) {
    define(scope, m.name, m.nameRange, 'message');
    const full = m.fullName;
    const byNum = new Map();
    for (const f of m.fields) {
      define(full, f.name, f.nameRange, 'field');
      const inOneof = !!f.oneof;
      checkField(f, m, inOneof);
      if (byNum.has(f.number) && f.number > 0) add(f.numberRange, `Field number ${f.number} has already been used in "${full}" by field "${byNum.get(f.number).name}". Next available field number is ${nextFree(m)}.`);
      else byNum.set(f.number, f);
      for (const r of m.reserved.ranges) if (f.number >= r.lo && f.number <= r.hi) add(f.numberRange, `Field "${f.name}" uses reserved number ${f.number}.`);
      if (m.reserved.names.some((n) => n.name === f.name)) add(f.nameRange, `Field name "${f.name}" is reserved.`);
      for (const x of m.extensions) if (f.number >= x.lo && f.number <= x.hi) add(f.numberRange, `Extension range ${x.lo} to ${x.hi} includes field "${f.name}" (${f.number}).`);
    }
    for (const o of m.oneofs) {
      define(full, o.name, o.nameRange, 'oneof');
      if (!o.fields.length) add(o.nameRange, 'Oneof must have at least one field.');
    }
    if (m.extensions.length && syntax === 'proto3') add(m.extensions[0].kwRange, 'Extension ranges are not allowed in proto3.');
    for (const x of m.extensions) {
      if (x.lo <= 0) add(x.range, 'Extension numbers must be positive integers.');
      for (const r of m.reserved.ranges) if (x.lo <= r.hi && r.lo <= x.hi) add(x.range, `Extension range ${x.lo} to ${x.hi} overlaps with reserved range ${r.lo} to ${r.hi}.`);
    }
    const rs = m.reserved.ranges;
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      if (rs[i].lo <= rs[j].hi && rs[j].lo <= rs[i].hi) add(rs[j].range, `Reserved range ${rs[j].lo} to ${rs[j].hi} overlaps with already-defined range ${rs[i].lo} to ${rs[i].hi}.`);
    }
    for (const e of m.enums) checkEnum(e, full);
    for (const c of m.messages) checkMessage(c, full);
    for (const x of m.extends) checkExtend(x, full);
  }

  function checkExtend(x, scope) {
    for (const f of x.fields) {
      define(scope, f.name, f.nameRange, 'extension');
      checkField(f, { isExtendHolder: false }, false);
      if (f.map) add(f.typeRange, 'Map fields are not allowed to be extensions.');
    }
    // the number must be in an extension range of the extended message, when that message is in the workspace
    const r = a.refs.find((q) => q.range === x.extendeeRange);
    const d = r ? refDefs.get(r) : null;
    if (d && d.kind === 'message' && d.node && d.node.extensions && !d.builtin) {
      for (const f of x.fields) {
        if (!d.node.extensions.some((e) => f.number >= e.lo && f.number <= e.hi)) add(f.numberRange, `"${d.fullName}" does not declare ${f.number} as an extension number.`);
      }
    }
  }

  for (const m of a.messages) checkMessage(m, pkg);
  for (const e of a.enums) checkEnum(e, pkg);
  for (const x of a.extends) checkExtend(x, pkg);
  for (const s of a.services) {
    define(pkg, s.name, s.nameRange, 'service');
    const names = new Set();
    for (const r of s.rpcs) {
      if (names.has(r.name)) add(r.nameRange, `"${r.name}" is already defined in "${s.fullName}".`);
      names.add(r.name);
    }
  }

  // ----- unused imports (protoc prints a warning) -----
  if (!unresolvedOption && !incomplete && opts.unusedImports !== false) {
    for (const imp of a.imports) {
      if (imp.kind === 'public' || imp.kind === 'weak') continue;
      const r = index.resolveImport(file, imp.path);
      if (!r) continue;
      if (r.builtin) { if (!usedFiles.has('builtin') && !r.builtin.wildcard) add(imp.stmt, `Import ${imp.path} is unused.`, 'hint', { unnecessary: true, code: 'unused-import' }); continue; }
      // a file counts as used when it, or a file it re-exports with "import public", defines something used here
      const reach = [r.file];
      const seen = new Set();
      let used = false;
      while (reach.length && !used) {
        const f = reach.pop();
        if (seen.has(f)) continue;
        seen.add(f);
        if (usedFiles.has(f)) used = true;
        const fa = index.get(f);
        if (fa) for (const i2 of fa.imports) if (i2.kind === 'public') { const r2 = index.resolveImport(f, i2.path); if (r2 && r2.file) reach.push(r2.file); else if (r2 && r2.builtin && usedFiles.has('builtin')) used = true; }
      }
      if (!used) add(imp.stmt, `Import ${imp.path} is unused.`, 'hint', { unnecessary: true, code: 'unused-import' });
    }
  }
  return out;
}

// the smallest field number above every used one that is not reserved (what protoc suggests)
function nextFree(m) {
  let n = Math.max(0, ...m.fields.map((f) => f.number)) + 1;
  for (let guard = 0; guard < 1000; guard++) {
    const r = [...m.reserved.ranges, ...m.extensions].find((x) => n >= x.lo && n <= x.hi);
    if (!r) break;
    n = r.hi + 1;
  }
  if (n >= 19000 && n <= 19999) n = 20000;
  return n;
}

function joinName(scope, name) { return scope ? `${scope}.${name}` : name; }

module.exports = { check };

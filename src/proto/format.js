'use strict';
// Formatter for .proto files. It works on the token stream, so every token and every comment stays in the file in the
// same order: only spaces, line breaks and indentation change. It refuses to touch a file that does not parse, so a
// valid file is never broken and a broken file is never made worse.
// Style: one statement per line, the indentation of the editor, "{" on the same line, at most one blank line kept where
// the file had one, no blank line after "{" or before "}", single spaces around "=", none inside () [] <>, trailing
// comments after one space. Option values in braces (text format) and option lists in [] stay on one line when they
// were written on one line; otherwise one entry per line.

const { tokenize } = require('./lexer');
const { parse } = require('./parser');

function matchBrackets(sig) {
  const match = new Array(sig.length).fill(-1);
  const stack = [];
  const pairs = { '}': '{', ')': '(', ']': '[' };
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];
    if (t.kind !== 'sym') continue;
    if (t.value === '{' || t.value === '(' || t.value === '[') stack.push(i);
    else if (pairs[t.value]) {
      const j = stack.pop();
      if (j === undefined || sig[j].value !== pairs[t.value]) return null;
      match[i] = j; match[j] = i;
    }
  }
  return stack.length ? null : match;
}

/**
 * @param {string} text
 * @param {{ indent?: string }} opts
 * @returns {{ text: string } | { error: string, line?: number }}
 */
function format(text, opts = {}) {
  const ind = opts.indent || '  ';
  const parsed = parse(text);
  const firstErr = parsed.errors.find((e) => e.severity === 'error');
  if (firstErr) return { error: `Line ${firstErr.line + 1}: ${firstErr.message}`, line: firstErr.line };
  const { tokens: all } = tokenize(text);
  const sig = [];
  const sigPos = new Map();
  all.forEach((t, i) => { if (t.kind !== 'comment') { sigPos.set(i, sig.length); sig.push(t); } });
  const match = matchBrackets(sig);
  if (!match) return { error: 'The brackets in this file do not balance.' };

  const out = [];
  let cur = '';
  let atStart = true;
  let depth = 0;
  let wantNl = false; // a line break is due before the next token
  let afterOpen = false; // the last break followed a "{" (no blank line allowed)
  let prev = null; // previous emitted token (significant or comment)
  let prevSig = null;
  let prevSigIdx = -1;
  const ctx = []; // { type: 'block'|'agg'|'opts'|'list'|'ext'|'paren'|'angle', multi, base }
  const top = () => ctx[ctx.length - 1];
  const inAgg = () => ctx.some((c) => c.type === 'agg');

  function lineBreak(blank) {
    if (!atStart) { out.push(cur.replace(/\s+$/, '')); cur = ''; atStart = true; }
    if (blank && out.length && out[out.length - 1] !== '' && !afterOpen) out.push('');
  }
  let trailCol = -1; // output column of the last trailing comment
  let trailOrigCol = -1;
  let contIndent = 0; // extra indent for the next line start (a wrapped statement)
  function put(str, space, extraIndent = 0, tok = null) {
    if (atStart) {
      const pre = ind.repeat(Math.max(0, depth + extraIndent + contIndent));
      contIndent = 0;
      if (tok && tok.kind === 'comment' && tok.value.startsWith('/*') && tok.value.includes('\n')) str = reindentBlock(tok, pre.length);
      cur = pre + str;
      atStart = false;
    } else cur += (space ? ' ' : '') + str;
    afterOpen = false;
  }
  function reindentBlock(tok, newCol) {
    const lines = tok.value.split('\n');
    const delta = newCol - tok.col;
    return lines.map((l, i) => {
      if (i === 0 || !l.trim()) return l;
      if (delta > 0) return ' '.repeat(delta) + l;
      const lead = /^ */.exec(l)[0].length;
      return l.slice(Math.min(lead, -delta));
    }).join('\n');
  }

  // indent level of the line being written (a wrapped line is deeper than depth)
  function lineLevel() {
    if (atStart) return depth;
    const lead = /^[ \t]*/.exec(cur)[0];
    return ind === '\t' ? lead.length : Math.floor(lead.length / ind.length);
  }

  function needSpace(p, t) {
    if (!p) return false;
    const c = top();
    if (c && c.type === 'ext') return t.start > p.end; // [type.googleapis.com/x.Y] inside text format: keep as written
    const pv = p.value;
    const tv = t.value;
    if (p.kind === 'sym' && (pv === '(' || pv === '[' || pv === '.' || pv === '-' || pv === '+')) return false;
    if (p.kind === 'sym' && pv === '<' && c && c.type === 'angle') return false;
    if (t.kind === 'sym') {
      if (tv === ';' || tv === ',' || tv === ')' || tv === ']' || tv === ':') return false;
      if (tv === '>' && c && c.type === 'angle') return false;
      if (tv === '.') return t.start > p.end; // keep the author's choice: "optional .pkg.Type" needs the space
      if (tv === '<') return !(p.kind === 'ident' && pv === 'map');
      if (tv === '(') return !(p.kind === 'ident' && pv !== 'returns' && pv !== 'option' && pv !== 'stream');
    }
    return true;
  }

  for (let ai = 0; ai < all.length; ai++) {
    const t = all[ai];
    const si = sigPos.has(ai) ? sigPos.get(ai) : -1;
    const blankBefore = t.nlBefore >= 2;

    if (t.kind === 'comment') {
      const isLine = t.value.startsWith('//');
      if (t.nlBefore === 0 && prev) {
        // trailing comment: stays on the line of the token before it, with the spaces the author put before it
        const gapText = text.slice(prev.end, t.start);
        const gap = /^[ ]+$/.test(gapText) && gapText.length <= 40 ? gapText.length : gapText === '' && t.value.startsWith('/*') ? 0 : 1;
        if (atStart) put(t.value, false, 0, t);
        else { trailCol = cur.length + gap; trailOrigCol = t.col; cur += ' '.repeat(gap) + t.value; afterOpen = false; }
      } else {
        lineBreak(blankBefore && prev !== null);
        wantNl = false;
        if (t.nlBefore === 1 && prev && prev.kind === 'comment' && trailCol >= 0 && t.col === trailOrigCol && t.value.startsWith('//')) {
          // a comment that continues the trailing comment above it, aligned under it
          cur = ' '.repeat(trailCol) + t.value; atStart = false; afterOpen = false;
          prev = t; wantNl = true;
          continue;
        }
        trailCol = -1;
        const extra = top() && top().type !== 'block' && !top().multi ? 1 : 0;
        put(t.value, false, extra, t);
      }
      prev = t;
      if (isLine) wantNl = true;
      else {
        const nx = all[ai + 1];
        if (nx && nx.nlBefore > 0 && (t.nlBefore > 0 || !prev)) wantNl = true;
      }
      continue;
    }

    const tv = t.value;
    const isSym = t.kind === 'sym';
    const c = top();

    // "}" of a block followed by ";": keep them together
    if (isSym && tv === ';' && prevSig && prevSig.value === '}' && wantNl && !atStart && prev === prevSig) {
      cur += ';';
      prev = t; prevSig = t; prevSigIdx = si;
      continue;
    }

    // closing brackets
    if (isSym && (tv === '}' || tv === ']' || tv === ')')) {
      const open = c;
      ctx.pop();
      if (open && open.multi) {
        lineBreak(false);
        wantNl = false;
        depth = open.type === 'block' ? open.base : open.level;
        put(tv, false);
        depth = open.base;
        if (open.type === 'block') wantNl = true;
      } else {
        if (wantNl) { lineBreak(false); wantNl = false; }
        const emptyAgg = open && open.type === 'agg' && prevSig && prevSig.value === '{';
        const sp = open && open.type === 'agg' && !emptyAgg;
        if (open && open.type === 'agg') put(tv, sp && !atStart);
        else put(tv, needSpace(prev, t));
      }
      prev = t; prevSig = t; prevSigIdx = si;
      continue;
    }

    // a line break that is due
    if (wantNl) {
      lineBreak(blankBefore);
      wantNl = false;
    } else if (c && c.multi && (c.type === 'agg') && prevSig && !atStart) {
      // new field inside a multi-line text-format value
      const pv = prevSig.value;
      const valueEnd = prevSig.kind === 'string' || prevSig.kind === 'int' || prevSig.kind === 'float' || prevSig.kind === 'ident' || pv === ']' || pv === '}' || pv === '>';
      if ((t.kind === 'ident' || tv === '[') && valueEnd && !(prevSig.kind === 'ident' && (tv === '.'))) lineBreak(blankBefore);
      else if (t.kind === 'string' && prevSig.kind === 'string' && t.nlBefore > 0) { lineBreak(false); contIndent = 2; }
    } else if (!atStart && t.nlBefore > 0 && (!c || c.type !== 'agg' || !c.multi) && !(isSym && (tv === ';' || tv === ',' || tv === ')' || tv === ']' || tv === '>' || tv === '}' || tv === '{' || tv === '.'))) {
      // keep the author's line break inside a statement (wrapped long lines), with a continuation indent
      lineBreak(false);
      contIndent = 2;
    }

    // opening brackets
    if (isSym && tv === '{') {
      const pv = prevSig ? prevSig.value : '';
      const isAgg = inAgg() || pv === '=' || pv === ':';
      const close = sig[match[si]];
      if (isAgg) {
        const multi = close.line > t.line;
        put('{', needSpace(prev, t) && !atStart);
        const lvl = lineLevel();
        ctx.push({ type: 'agg', multi, base: depth, level: lvl });
        if (multi) { depth = lvl + 1; wantNl = true; afterOpen = true; }
      } else if (all[ai + 1] === close) {
        // empty block: "message Empty {}" stays on one line
        put('{}', !atStart);
        ai++;
        wantNl = true;
        prev = close; prevSig = close; prevSigIdx = match[si];
        continue;
      } else {
        put('{', !atStart);
        ctx.push({ type: 'block', multi: true, base: depth });
        depth++;
        wantNl = true;
        afterOpen = true;
      }
      prev = t; prevSig = t; prevSigIdx = si;
      continue;
    }
    if (isSym && tv === '[') {
      const close = sig[match[si]];
      const pv = prevSig ? prevSig.value : '';
      let type = 'opts';
      if (inAgg()) type = pv === ':' || pv === ',' && top() && top().type === 'list' ? 'list' : 'ext';
      const after = all[ai + 1];
      const multi = type === 'opts' && close.line > t.line && after && after.nlBefore > 0; // "[" alone at the end of its line
      put('[', needSpace(prev, t) && !atStart);
      const lvl = lineLevel();
      ctx.push({ type, multi, base: depth, level: lvl });
      if (multi) { depth = lvl + 1; wantNl = true; afterOpen = true; }
      prev = t; prevSig = t; prevSigIdx = si;
      continue;
    }
    if (isSym && tv === '(') {
      put('(', needSpace(prev, t) && !atStart);
      ctx.push({ type: 'paren', multi: false, base: depth });
      prev = t; prevSig = t; prevSigIdx = si;
      continue;
    }
    if (isSym && tv === '<' && prevSig && prevSig.kind === 'ident' && prevSig.value === 'map') {
      put('<', false);
      ctx.push({ type: 'angle', multi: false, base: depth });
      prev = t; prevSig = t; prevSigIdx = si;
      continue;
    }
    if (isSym && tv === '>' && c && c.type === 'angle') {
      ctx.pop();
      put('>', false);
      prev = t; prevSig = t; prevSigIdx = si;
      continue;
    }

    put(tv, !atStart && needSpace(prev, t));
    prev = t; prevSig = t; prevSigIdx = si;

    if (isSym && tv === ';') {
      if (!c || c.type === 'block' || (c.type === 'agg' && c.multi)) wantNl = true;
    } else if (isSym && tv === ',') {
      if (c && c.multi && (c.type === 'opts' || c.type === 'agg')) wantNl = true;
    }
  }
  lineBreak(false);
  while (out.length && out[out.length - 1] === '') out.pop();
  while (out.length && out[0] === '') out.shift();
  const result = out.map((l) => l.replace(/[ \t]+$/, '')).join('\n') + (out.length ? '\n' : '');
  void prevSigIdx;
  return { text: result };
}

/** Smallest single replacement that turns a into b, by whole lines: { startLine, endLine (exclusive), text }. */
function lineDiff(a, b) {
  const A = a.split('\n');
  const B = b.split('\n');
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  if (s === A.length && s === B.length) return null;
  let ea = A.length;
  let eb = B.length;
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  return { startLine: s, endLine: ea, lines: B.slice(s, eb) };
}

/** One replacement { start, end, text } (offsets in a) that turns a into b, or null when they are equal. */
function minimalEdit(a, b) {
  if (a === b) return null;
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  return { start: p, end: a.length - s, text: b.slice(p, b.length - s) };
}

module.exports = { format, lineDiff, minimalEdit };

'use strict';
// Tokenizer for .proto files (proto2, proto3 and editions). Pure JavaScript, no VS Code, no network.
// Every token keeps its offsets and 0-based line and column, so the parser, the formatter and the editor features can
// map back to the text. Comments are tokens too (kind 'comment'); the parser skips them, the formatter keeps them.

const SYMBOLS = new Set(['{', '}', '(', ')', '[', ']', '<', '>', ';', ',', '=', '.', ':', '-', '+', '/', '*']);

/**
 * @returns {{ tokens: Array<{kind:string,value:string,start:number,end:number,line:number,col:number,endLine:number,endCol:number,nlBefore:number}>, errors: Array }}
 * kind: ident | int | float | string | sym | comment. nlBefore = newlines between the previous token and this one.
 */
function tokenize(text) {
  const tokens = [];
  const errors = [];
  let i = 0;
  let line = 0;
  let col = 0;
  let nl = 0;
  const n = text.length;
  const adv = (k) => {
    for (let j = 0; j < k; j++) {
      if (text.charCodeAt(i) === 10) { line++; col = 0; } else col++;
      i++;
    }
  };
  while (i < n) {
    const c = text[i];
    if (c === '\n') { nl++; adv(1); continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '﻿') { adv(1); continue; }
    const start = i;
    const sl = line;
    const sc = col;
    let kind;
    if (c === '/' && text[i + 1] === '/') {
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      adv(j - i);
      kind = 'comment';
    } else if (c === '/' && text[i + 1] === '*') {
      const j = text.indexOf('*/', i + 2);
      if (j < 0) {
        errors.push({ message: 'This block comment is not closed with */.', line: sl, col: sc, endLine: sl, endCol: sc + 2 });
        adv(n - i);
      } else adv(j + 2 - i);
      kind = 'comment';
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(text[j])) j++;
      adv(j - i);
      kind = 'ident';
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] || ''))) {
      let j = i;
      let isFloat = false;
      if (c === '0' && (text[i + 1] === 'x' || text[i + 1] === 'X')) {
        j += 2;
        while (j < n && /[0-9A-Fa-f]/.test(text[j])) j++;
      } else {
        while (j < n && /[0-9]/.test(text[j])) j++;
        if (text[j] === '.') { isFloat = true; j++; while (j < n && /[0-9]/.test(text[j])) j++; }
        if (text[j] === 'e' || text[j] === 'E') {
          let k = j + 1;
          if (text[k] === '+' || text[k] === '-') k++;
          if (/[0-9]/.test(text[k] || '')) { isFloat = true; j = k; while (j < n && /[0-9]/.test(text[j])) j++; }
        }
        // text format allows a trailing f / F on floats ("1.5f"); keep it in the token
        if ((text[j] === 'f' || text[j] === 'F') && isFloat) j++;
      }
      adv(j - i);
      kind = isFloat ? 'float' : 'int';
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const d = text[j];
        if (d === '\\') { j += 2; continue; }
        if (d === c) { closed = true; j++; break; }
        if (d === '\n') break;
        j++;
      }
      if (!closed) errors.push({ message: 'This string is not closed on its line.', line: sl, col: sc, endLine: sl, endCol: sc + (j - i) });
      adv(Math.min(j, n) - i);
      kind = 'string';
    } else if (SYMBOLS.has(c)) {
      adv(1);
      kind = 'sym';
    } else {
      errors.push({ message: `Unexpected character "${c}".`, line: sl, col: sc, endLine: sl, endCol: sc + 1 });
      adv(1);
      kind = 'sym';
    }
    tokens.push({ kind, value: text.slice(start, i), start, end: i, line: sl, col: sc, endLine: line, endCol: col, nlBefore: nl });
    nl = 0;
  }
  return { tokens, errors, trailingNewlines: nl };
}

/** The value of a string literal token, with escapes decoded (\n, \t, \xHH, \ooo, \uXXXX, \", \\). */
function unquote(tok) {
  const s = tok.value;
  const q = s[0];
  const body = s.endsWith(q) && s.length > 1 ? s.slice(1, -1) : s.slice(1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') { out += ch; continue; }
    const e = body[++i];
    if (e === 'n') out += '\n';
    else if (e === 't') out += '\t';
    else if (e === 'r') out += '\r';
    else if (e === 'a') out += '\x07';
    else if (e === 'b') out += '\b';
    else if (e === 'f') out += '\f';
    else if (e === 'v') out += '\v';
    else if (e === 'x' || e === 'X') {
      const m = /^[0-9A-Fa-f]{1,2}/.exec(body.slice(i + 1));
      if (m) { out += String.fromCharCode(parseInt(m[0], 16)); i += m[0].length; }
    } else if (e === 'u' || e === 'U') {
      const len = e === 'u' ? 4 : 8;
      const h = body.slice(i + 1, i + 1 + len);
      if (/^[0-9A-Fa-f]+$/.test(h)) { out += String.fromCodePoint(parseInt(h, 16)); i += len; }
    } else if (/[0-7]/.test(e || '')) {
      const m = /^[0-7]{1,3}/.exec(body.slice(i));
      out += String.fromCharCode(parseInt(m[0], 8));
      i += m[0].length - 1;
    } else if (e !== undefined) out += e;
  }
  return out;
}

/** Integer token value as a Number (hex, octal, decimal). Returns NaN for a bad token. */
function intValue(tok) {
  const v = tok.value;
  if (/^0[xX]/.test(v)) return parseInt(v.slice(2), 16);
  if (/^0[0-7]+$/.test(v)) return parseInt(v, 8);
  if (/^[0-9]+$/.test(v)) return Number(v);
  return NaN;
}

module.exports = { tokenize, unquote, intValue };

'use strict';
// Workspace index of .proto files: parses files, resolves imports like protoc does (import roots), and resolves type
// names with the protobuf scoping rules (innermost scope first, a leading "." for a fully qualified name).
// The host gives file access, so the same code runs in VS Code and in the unit tests. No network.

const path = require('path');
const { parse } = require('./parser');
const { builtinFile } = require('./wkt');

const TYPE_KINDS = new Set(['message', 'enum']);

function createIndex(host) {
  const files = new Map(); // abs path -> { text, ast, open }
  let gen = 0; // bumps on every change, caches compare it
  const cache = new Map(); // key -> { gen, value }
  const cached = (key, fn) => {
    const c = cache.get(key);
    if (c && c.gen === gen) return c.value;
    const value = fn();
    cache.set(key, { gen, value });
    return value;
  };
  const norm = (p) => path.normalize(p);

  function set(file, text, open = false) {
    file = norm(file);
    const old = files.get(file);
    if (old && old.text === text) { old.open = old.open || open; return old.ast; }
    const ast = parse(text);
    ast.file = file;
    files.set(file, { text, ast, open });
    gen++;
    return ast;
  }
  function remove(file) { if (files.delete(norm(file))) gen++; }
  function has(file) { return files.has(norm(file)); }
  function get(file) {
    file = norm(file);
    const e = files.get(file);
    if (e) return e.ast;
    const text = host.readFile(file);
    if (text == null) return null;
    return set(file, text);
  }
  function exists(file) { return files.has(norm(file)) || !!host.fileExists(norm(file)); }
  function allFiles() { return [...files.keys()]; }

  function rootFor(file) {
    const roots = (host.roots() || []).map(norm).filter((r) => file === r || file.startsWith(r + path.sep));
    roots.sort((a, b) => b.length - a.length);
    return roots[0] || null;
  }

  /** protoc-style import resolution. Returns { file } or { builtin } or null. */
  function resolveImport(from, importPath) {
    from = norm(from);
    return cached(`imp:${from}\0${importPath}`, () => {
      const rel = importPath.split('/').join(path.sep);
      const tried = new Set();
      const candidates = [];
      for (const d of host.importPaths ? host.importPaths(from) : []) candidates.push(path.join(d, rel));
      const root = rootFor(from);
      if (root) candidates.push(path.join(root, rel));
      // the folder of the file and its parents, up to the workspace folder (proto roots such as proto/ or api/)
      let dir = path.dirname(from);
      for (let k = 0; k < 30; k++) {
        candidates.push(path.join(dir, rel));
        if (root && dir === root) break;
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
      }
      for (const c of candidates) {
        const n = norm(c);
        if (tried.has(n)) continue;
        tried.add(n);
        if (n !== from && exists(n)) return { file: n };
      }
      // any indexed file whose path ends with the import path
      const suffix = path.sep + rel;
      const hits = allFiles().filter((f) => f.endsWith(suffix) && f !== from).sort((a, b) => a.length - b.length);
      if (hits.length) return { file: hits[0], bySuffix: true };
      const b = builtinFile(importPath);
      if (b) return { builtin: b };
      return null;
    });
  }

  function astOf(entry) { return entry.builtin ? entry.builtin : get(entry.file); }

  /** The files whose symbols this file can use: itself, direct imports and their public imports (transitively). */
  function visible(file) {
    file = norm(file);
    return cached(`vis:${file}`, () => {
      const out = [];
      const seen = new Set();
      const self = get(file);
      if (!self) return out;
      out.push({ file, ast: self });
      seen.add(file);
      const queue = [];
      for (const imp of self.imports) {
        const r = resolveImport(file, imp.path);
        if (r) queue.push(r);
      }
      while (queue.length) {
        const r = queue.shift();
        const key = r.file || `builtin:${r.builtin.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const ast = astOf(r);
        if (!ast) continue;
        out.push({ file: r.file || null, ast, builtin: !!r.builtin });
        if (r.file) for (const imp of ast.imports) if (imp.kind === 'public') { const r2 = resolveImport(r.file, imp.path); if (r2) queue.push(r2); }
      }
      return out;
    });
  }

  function tableOf(list) {
    const defs = new Map();
    const packages = new Set();
    const wildcards = [];
    for (const v of list) {
      const a = v.ast;
      if (a.package) { const parts = a.package.split('.'); for (let i = 1; i <= parts.length; i++) packages.add(parts.slice(0, i).join('.')); }
      if (a.wildcard) wildcards.push(a.package + '.');
      for (const d of a.defs || []) if (!defs.has(d.fullName)) defs.set(d.fullName, { ...d, file: v.file, builtin: !!v.builtin });
    }
    return { defs, packages, wildcards };
  }
  function table(file) { return cached(`tab:${norm(file)}`, () => tableOf(visible(file))); }
  function globalTable() { return cached('global', () => tableOf(allFiles().map((f) => ({ file: f, ast: get(f) })).filter((x) => x.ast))); }

  /**
   * Resolve a type or extension name used in `scope`. kinds: which definition kinds count as a match.
   * Returns { def } or { wildcard: true } or { error: 'undefined'|'innermost', resolvedTo } .
   */
  function lookupIn(t, name, scope, kinds) {
    const isKind = (d) => !kinds || kinds.has(d.kind);
    const wild = (full) => t.wildcards.some((w) => full.startsWith(w));
    if (name.startsWith('.')) {
      const full = name.slice(1);
      const d = t.defs.get(full);
      if (d && isKind(d)) return { def: d };
      if (wild(full)) return { wildcard: true };
      return { error: 'undefined' };
    }
    const first = name.split('.')[0];
    const parts = scope ? scope.split('.') : [];
    for (let i = parts.length; i >= 0; i--) {
      const prefix = parts.slice(0, i).join('.');
      const candFirst = prefix ? `${prefix}.${first}` : first;
      const fd = t.defs.get(candFirst);
      const isAggregate = (fd && (fd.kind === 'message' || fd.kind === 'enum' || fd.kind === 'service')) || t.packages.has(candFirst);
      const full = prefix ? `${prefix}.${name}` : name;
      if (fd && !isAggregate && first === name && isKind(fd)) return { def: fd };
      if (!isAggregate) { if (wild(full)) return { wildcard: true }; continue; }
      const d = t.defs.get(full);
      if (d && isKind(d)) return { def: d };
      if (wild(full)) return { wildcard: true };
      if (d && !isKind(d)) return { error: 'kind', def: d };
      if (name !== first) return { error: 'innermost', resolvedTo: full };
      return { error: 'undefined' };
    }
    return { error: 'undefined' };
  }

  function lookup(file, name, scope, kinds = TYPE_KINDS) {
    const r = lookupIn(table(file), name, scope, kinds);
    if (r.def || r.wildcard) return r;
    // defined somewhere in the workspace, but not imported?
    const g = lookupIn(globalTable(), name, scope, kinds);
    if (g.def && g.def.file && g.def.file !== norm(file)) return { ...r, notImported: g.def };
    return r;
  }

  /** Imports of a file that could not be found (as { imp }). */
  function missingImports(file) {
    const a = get(file);
    if (!a) return [];
    return a.imports.filter((imp) => !resolveImport(file, imp.path)).map((imp) => ({ imp }));
  }

  /** Every place a definition (by full name) is used: [{ file, range, ref }]. */
  function references(fullName) {
    const out = [];
    for (const f of allFiles()) {
      const a = get(f);
      if (!a) continue;
      for (const r of a.refs) {
        const res = lookup(f, r.name, r.scope, r.kind === 'extend' ? new Set(['message']) : TYPE_KINDS);
        if (res.def && res.def.fullName === fullName) out.push({ file: f, range: r.range, ref: r });
      }
      for (const r of a.optionRefs) {
        const res = lookup(f, r.name, a.package || '', new Set(['extension']));
        if (res.def && res.def.fullName === fullName) out.push({ file: f, range: r.range, ref: r });
      }
    }
    return out;
  }

  /** The reference, option name, import or definition name at a 0-based position, or null. */
  function at(file, line, col) {
    const a = get(file);
    if (!a) return null;
    const inR = (r) => r && (line > r.line || (line === r.line && col >= r.col)) && (line < r.endLine || (line === r.endLine && col <= r.endCol));
    for (const imp of a.imports) if (inR(imp.range)) return { kind: 'import', imp };
    for (const r of a.refs) if (inR(r.range)) return { kind: 'ref', ref: r };
    for (const r of a.optionRefs) if (inR(r.range)) return { kind: 'option', ref: r };
    for (const d of a.defs) if (d.node.nameRange && inR(d.node.nameRange)) return { kind: 'def', def: { ...d, file: norm(file) } };
    return null;
  }

  /** Resolve the thing at a position to a definition: { def } (def.file may be null for built-in types). */
  function definitionAt(file, line, col) {
    const hit = at(file, line, col);
    if (!hit) return null;
    if (hit.kind === 'def') return { def: hit.def };
    if (hit.kind === 'import') { const r = resolveImport(file, hit.imp.path); return r && r.file ? { file: r.file } : null; }
    if (hit.kind === 'ref') {
      const r = lookup(file, hit.ref.name, hit.ref.scope, hit.ref.kind === 'extend' ? new Set(['message']) : TYPE_KINDS);
      if (r.def) return { def: r.def, ref: hit.ref };
      if (r.notImported) return { def: r.notImported, ref: hit.ref, notImported: true };
      return null;
    }
    if (hit.kind === 'option') {
      const a = get(file);
      const r = lookup(file, hit.ref.name, a.package || '', new Set(['extension']));
      if (r.def) return { def: r.def, ref: hit.ref };
    }
    return null;
  }

  return { set, remove, get, has, allFiles, resolveImport, visible, table, lookup, missingImports, references, at, definitionAt, rootFor, get generation() { return gen; } };
}

module.exports = { createIndex, TYPE_KINDS };

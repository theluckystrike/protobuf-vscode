'use strict';
// Protobuf & Proto3 Formatter by Zovo. Free: highlighting (TextMate grammar), formatter, outline, go to definition,
// find references, hover, completion and protoc-matching diagnostics for .proto files. Everything runs locally:
// no network call, no telemetry, no protoc needed. Pro tools (pro.js) run only when the user starts one.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { createIndex, TYPE_KINDS } = require('./proto/index');
const { check } = require('./proto/check');
const { format, minimalEdit } = require('./proto/format');
const { SCALARS } = require('./proto/parser');
const { WKT } = require('./proto/wkt');
const breaking = require('./proto/breaking');
const docsGen = require('./proto/docs');
const wire = require('./proto/wire');
const git = require('./git');
const { createPro } = require('./pro');
const { createRatingPrompt } = require('./rate');
const { registerSupport } = require('./support');

const PREFIX = 'zovoProto';
const LANG = 'protobuf';
const EXT_ID = 'zovo.zovo-protobuf';
const NAME = 'Protobuf & Proto3 Formatter';

let index;
let diagnostics;
let pro;
let rating = { success() {}, failure() {} };
let indexing = null;
let indexedCount = 0;

const cfg = () => vscode.workspace.getConfiguration(PREFIX);
const setting = (k, d) => { const v = cfg().get(k); return v === undefined ? d : v; };
const isProtoDoc = (d) => d && d.languageId === LANG;
const keyOf = (uri) => (uri.scheme === 'file' ? uri.fsPath : path.join(path.sep, `__${uri.scheme}__`, uri.path.replace(/^\/+/, '')));
const toRange = (r) => new vscode.Range(r.line, r.col, r.endLine, r.endCol);
const uriOf = (file) => {
  const open = vscode.workspace.textDocuments.find((d) => keyOf(d.uri) === file);
  return open ? open.uri : vscode.Uri.file(file);
};

// ---------------- index ----------------

function importDirs(file) {
  const out = [];
  const list = setting('importPaths', []) || [];
  const folders = vscode.workspace.workspaceFolders || [];
  const own = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
  const bases = own ? [own, ...folders.filter((f) => f !== own)] : folders;
  for (const p of list) {
    if (typeof p !== 'string' || !p.trim()) continue;
    const s = p.replace(/^\$\{workspaceFolder\}[\\/]?/, '');
    if (path.isAbsolute(s)) out.push(s);
    else for (const f of bases) if (f.uri.scheme === 'file') out.push(path.join(f.uri.fsPath, s));
  }
  return out;
}

function makeIndex() {
  return createIndex({
    readFile: (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } },
    fileExists: (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } },
    roots: () => (vscode.workspace.workspaceFolders || []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath),
    importPaths: importDirs,
  });
}

async function indexWorkspace() {
  const excl = setting('exclude', []) || [];
  const max = Math.max(100, Number(setting('maxFiles', 5000)) || 5000);
  let uris = [];
  try { uris = await vscode.workspace.findFiles('**/*.proto', excl.length ? `{${excl.join(',')}}` : undefined, max); } catch { uris = []; }
  for (const u of uris) {
    if (u.scheme !== 'file') continue;
    const k = keyOf(u);
    if (index.has(k)) continue;
    try { index.set(k, await fs.promises.readFile(u.fsPath, 'utf8')); } catch { /* unreadable */ }
  }
  for (const d of vscode.workspace.textDocuments) if (isProtoDoc(d)) index.set(keyOf(d.uri), d.getText(), true);
  indexedCount = index.allFiles().length;
}

// ---------------- diagnostics ----------------

const SEV = () => ({ error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, info: vscode.DiagnosticSeverity.Information, hint: vscode.DiagnosticSeverity.Hint });
let diagTimer = null;
function scheduleDiagnostics(ms = 200) {
  clearTimeout(diagTimer);
  diagTimer = setTimeout(refreshDiagnostics, ms);
}
function refreshDiagnostics() {
  if (!diagnostics) return;
  if (setting('diagnostics', true) === false) { diagnostics.clear(); return; }
  const sev = SEV();
  const openKeys = new Set();
  for (const d of vscode.workspace.textDocuments) {
    if (!isProtoDoc(d)) continue;
    const k = keyOf(d.uri);
    openKeys.add(d.uri.toString());
    index.set(k, d.getText(), true);
    const list = check(index, k, { unusedImports: setting('unusedImports', true) !== false }).map((x) => {
      const dg = new vscode.Diagnostic(toRange(x.range), x.message, sev[x.severity] || sev.error);
      dg.source = 'protobuf';
      if (x.code) dg.code = x.code;
      if (x.unnecessary) dg.tags = [vscode.DiagnosticTag.Unnecessary];
      return dg;
    });
    diagnostics.set(d.uri, list);
  }
  diagnostics.forEach((uri) => { if (!openKeys.has(uri.toString())) diagnostics.delete(uri); });
}

// ---------------- language features ----------------

function symbolTree(ast) {
  const K = vscode.SymbolKind;
  const sym = (name, detail, kind, node, children = []) => {
    const full = toRange(node.range || node.nameRange);
    const sel = toRange(node.nameRange);
    const s = new vscode.DocumentSymbol(name, detail, kind, full.contains(sel) ? full : sel, sel);
    s.children = children;
    return s;
  };
  const field = (f) => sym(f.name, `${f.label ? f.label + ' ' : ''}${f.type} = ${f.number}`, K.Field, f);
  const msg = (m) => {
    const kids = [];
    const inOneof = new Set();
    for (const o of m.oneofs) { for (const f of o.fields) inOneof.add(f); kids.push(sym(o.name, 'oneof', K.Struct, { range: o.range, nameRange: o.nameRange }, o.fields.map(field))); }
    for (const f of m.fields) if (!inOneof.has(f) && !f.group) kids.push(field(f));
    for (const e of m.enums) kids.push(en(e));
    for (const c of m.messages) kids.push(msg(c));
    for (const x of m.extends) kids.push(ext(x));
    return sym(m.name, m.isGroup ? 'group' : 'message', K.Class, m, kids);
  };
  const en = (e) => sym(e.name, 'enum', K.Enum, e, e.values.map((v) => sym(v.name, String(v.number), K.EnumMember, { range: v.nameRange, nameRange: v.nameRange })));
  const ext = (x) => sym(`extend ${x.extendee}`, 'extend', K.Namespace, { range: x.range, nameRange: x.extendeeRange }, x.fields.map(field));
  const out = [];
  for (const m of ast.messages) out.push(msg(m));
  for (const e of ast.enums) out.push(en(e));
  for (const s of ast.services) out.push(sym(s.name, 'service', K.Interface, s, s.rpcs.map((r) => sym(r.name, `(${r.inputStream ? 'stream ' : ''}${r.input}) returns (${r.outputStream ? 'stream ' : ''}${r.output})`, K.Method, r))));
  for (const x of ast.extends) out.push(ext(x));
  return out.sort((a, b) => a.range.start.line - b.range.start.line);
}

function defLocation(def) {
  if (!def || !def.file || !def.node || !def.node.nameRange) return null;
  return new vscode.Location(uriOf(def.file), toRange(def.node.nameRange));
}

function declText(def) {
  const n = def.node || {};
  if (def.kind === 'message') return `message ${def.fullName}`;
  if (def.kind === 'enum') return `enum ${def.fullName}`;
  if (def.kind === 'service') return `service ${def.fullName}`;
  if (def.kind === 'extension') return `extend ${n.extendee || ''} {\n  ${n.label ? n.label + ' ' : ''}${n.type} ${n.name} = ${n.number};\n}`;
  return def.fullName;
}

function hoverFor(doc, pos) {
  const k = keyOf(doc.uri);
  const hit = index.definitionAt(k, pos.line, pos.character);
  if (!hit || !hit.def) return null;
  const def = hit.def;
  const md = new vscode.MarkdownString();
  md.appendCodeblock(declText(def), LANG);
  const n = def.node || {};
  if (def.kind === 'message' && n.fields) {
    const lines = n.fields.slice(0, 12).map((f) => `  ${f.label ? f.label + ' ' : ''}${f.type} ${f.name} = ${f.number};`);
    if (n.fields.length > 12) lines.push(`  // ${n.fields.length - 12} more fields`);
    if (lines.length) md.appendCodeblock(`{\n${lines.join('\n')}\n}`, LANG);
  } else if (def.kind === 'enum' && n.values) {
    const lines = n.values.slice(0, 12).map((v) => `  ${v.name} = ${v.number};`);
    if (n.values.length > 12) lines.push(`  // ${n.values.length - 12} more values`);
    md.appendCodeblock(`{\n${lines.join('\n')}\n}`, LANG);
  }
  if (n.comment) md.appendMarkdown('\n' + n.comment.replace(/([*_`#\\])/g, '\\$1').replace(/\n/g, '  \n') + '\n');
  if (def.builtin) md.appendMarkdown('\n\nWell-known type, built into protoc.');
  else if (def.file) md.appendMarkdown(`\n\n${vscode.workspace.asRelativePath(def.file)}:${(n.nameRange ? n.nameRange.line : 0) + 1}`);
  if (hit.notImported) md.appendMarkdown('\n\nNot imported by this file.');
  return new vscode.Hover(md);
}

// smallest message, enum or service that contains a position
function containerAt(ast, line, col) {
  const inside = (r) => r && (line > r.line || (line === r.line && col >= r.col)) && (line < r.endLine || (line === r.endLine && col <= r.endCol));
  let best = null;
  const walk = (m) => {
    if (!inside(m.range)) return;
    best = m;
    for (const c of m.messages) walk(c);
    for (const e of m.enums) if (inside(e.range)) best = e;
  };
  for (const m of ast.messages) walk(m);
  for (const e of ast.enums) if (inside(e.range)) best = e;
  for (const s of ast.services) if (inside(s.range)) best = s;
  return best;
}

const FILE_OPTIONS = ['java_package', 'java_outer_classname', 'java_multiple_files', 'go_package', 'csharp_namespace', 'objc_class_prefix', 'php_namespace', 'ruby_package', 'swift_prefix', 'optimize_for', 'cc_enable_arenas', 'deprecated'];
const MESSAGE_OPTIONS = ['deprecated', 'map_entry', 'message_set_wire_format'];
const FIELD_OPTIONS = ['deprecated', 'json_name', 'packed', 'lazy', 'default', 'retention', 'targets', 'debug_redact', 'features.field_presence', 'features.repeated_field_encoding', 'features.utf8_validation', 'features.message_encoding'];
const ENUM_OPTIONS = ['allow_alias', 'deprecated'];

function completions(doc, pos) {
  const k = keyOf(doc.uri);
  const ast = index.set(k, doc.getText(), true);
  const linePrefix = doc.lineAt(pos.line).text.slice(0, pos.character);
  if (/\/\//.test(linePrefix)) return [];
  const CK = vscode.CompletionItemKind;
  const item = (label, kind, detail, insert) => { const c = new vscode.CompletionItem(label, kind); if (detail) c.detail = detail; if (insert) c.insertText = insert; return c; };
  const wordRange = doc.getWordRangeAtPosition(pos, /[.A-Za-z0-9_]+/);

  // import "path"
  const imp = /\bimport\s+(?:public\s+|weak\s+)?"([^"]*)$/.exec(linePrefix);
  if (imp) {
    const out = [];
    const root = index.rootFor(k);
    const seen = new Set();
    for (const f of index.allFiles()) {
      if (f === k) continue;
      const rels = [];
      if (root && f.startsWith(root + path.sep)) rels.push(path.relative(root, f).split(path.sep).join('/'));
      const dir = path.dirname(k);
      if (f.startsWith(dir + path.sep)) rels.push(path.relative(dir, f).split(path.sep).join('/'));
      for (const r of rels) if (!seen.has(r)) { seen.add(r); out.push(item(r, CK.File, 'workspace file')); }
    }
    for (const w of Object.keys(WKT)) if (!seen.has(w)) out.push(item(w, CK.File, 'well-known type, built in'));
    const start = pos.translate(0, -imp[1].length);
    for (const c of out) c.range = new vscode.Range(start, pos);
    return out;
  }
  const container = containerAt(ast, pos.line, pos.character);

  // next free number after "name ="
  if (/^\s*(?:(?:optional|required|repeated)\s+)?(?:map\s*<[^>]*>|[.\w]+)\s+\w+\s*=\s*$/.test(linePrefix) && container && container.kind === 'message') {
    const used = new Set(container.fields.map((f) => f.number));
    const reserved = container.reserved.ranges;
    let n = 1;
    while (used.has(n) || reserved.some((r) => n >= r.lo && n <= r.hi) || (n >= 19000 && n <= 19999)) n++;
    const c = item(String(n), CK.Value, 'next free field number');
    c.insertText = `${n};`;
    c.preselect = true;
    return [c];
  }
  if (/^\s*[A-Z_][A-Z0-9_]*\s*=\s*$/.test(linePrefix) && container && container.kind === 'enum') {
    const n = container.values.length ? Math.max(...container.values.map((v) => v.number)) + 1 : 0;
    const c = item(String(n), CK.Value, 'next enum number');
    c.insertText = `${n};`;
    c.preselect = true;
    return [c];
  }
  // option names
  if (/^\s*option\s+[\w.]*$/.test(linePrefix)) {
    const list = !container ? FILE_OPTIONS : container.kind === 'enum' ? ENUM_OPTIONS : container.kind === 'message' ? MESSAGE_OPTIONS : ['deprecated'];
    return list.map((o) => item(o, CK.Property, 'option'));
  }
  if (/\[[^\]]*$/.test(linePrefix) && /(\[|,)\s*[\w.]*$/.test(linePrefix)) return FIELD_OPTIONS.map((o) => item(o, CK.Property, 'field option', `${o} = `));

  // types and keywords
  const typePos = /^\s*(?:(?:optional|required|repeated)\s+)?[.\w]*$/.test(linePrefix) || /\(\s*(?:stream\s+)?[.\w]*$/.test(linePrefix) || /map\s*<\s*\w+\s*,\s*[.\w]*$/.test(linePrefix) || /^\s*extend\s+[.\w]*$/.test(linePrefix);
  if (!typePos) return [];
  const out = [];
  const atStmtStart = /^\s*[\w]*$/.test(linePrefix);
  if (atStmtStart) {
    const kw = !container ? ['syntax', 'edition', 'package', 'import', 'option', 'message', 'enum', 'service', 'extend']
      : container.kind === 'service' ? ['rpc', 'option']
        : container.kind === 'enum' ? ['option', 'reserved']
          : ['message', 'enum', 'oneof', 'map', 'repeated', 'optional', 'reserved', 'option', 'extend', 'extensions'];
    for (const w of kw) out.push(item(w, CK.Keyword));
  }
  if (container && container.kind === 'enum') return out;
  if (!container && atStmtStart) return out;
  const inRpc = /\(\s*(?:stream\s+)?[.\w]*$/.test(linePrefix);
  if (!inRpc && !(container && container.kind === 'service')) for (const s of SCALARS) out.push(item(s, CK.TypeParameter, 'scalar'));
  const table = index.table(k);
  const pkg = ast.package || '';
  const seen = new Set();
  for (const [full, d] of table.defs) {
    if (!TYPE_KINDS.has(d.kind)) continue;
    if (inRpc && d.kind !== 'message') continue;
    const label = pkg && full.startsWith(pkg + '.') ? full.slice(pkg.length + 1) : full;
    if (seen.has(label)) continue;
    seen.add(label);
    const c = item(label, d.kind === 'enum' ? CK.Enum : CK.Class, full);
    if (wordRange) c.range = wordRange;
    out.push(c);
  }
  return out;
}

// ---------------- Pro tools ----------------

function folderOf(arg) {
  const u = arg && arg.fsPath ? arg : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
  if (u && u.scheme === 'file') {
    const wf = vscode.workspace.getWorkspaceFolder(u);
    if (wf) return wf.uri.fsPath;
    return fs.existsSync(u.fsPath) && fs.statSync(u.fsPath).isDirectory() ? u.fsPath : path.dirname(u.fsPath);
  }
  const f = (vscode.workspace.workspaceFolders || []).find((x) => x.uri.scheme === 'file');
  return f ? f.uri.fsPath : null;
}

async function openUntitled(content, language) {
  const doc = await vscode.workspace.openTextDocument({ content, language });
  await vscode.window.showTextDocument(doc, { preview: false });
  return doc;
}

async function runBreaking(arg) {
  if (!(await pro.allowed('breaking', arg))) return;
  const folder = folderOf(arg);
  if (!folder) { vscode.window.showWarningMessage('Open a folder with .proto files in a git repository first.'); return; }
  const root = await git.repoRoot(folder);
  if (!root) { vscode.window.showWarningMessage(`${path.basename(folder)} is not in a git repository (or git is not on PATH). The breaking-change check compares with a git branch.`); return; }
  const base = await git.findBase(root, String(setting('baseBranch', '') || '').trim());
  if (!base) { vscode.window.showWarningMessage('No base branch found (origin/main, main, origin/master, master). Set "zovoProto.baseBranch".', 'Open Setting').then((p) => { if (p) vscode.commands.executeCommand('workbench.action.openSettings', 'zovoProto.baseBranch'); }); return; }
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Protobuf: comparing with ${base}` }, async () => {
    const mb = (await git.mergeBase(root, base)) || base;
    const baseFiles = await git.protoFilesAt(root, mb);
    const headList = await git.workingProtoFiles(root);
    const headFiles = new Map();
    for (const rel of headList) {
      const abs = path.join(root, rel);
      const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === abs);
      try { headFiles.set(rel, open ? open.getText() : await fs.promises.readFile(abs, 'utf8')); } catch { /* deleted in the working tree */ }
    }
    return { mb, r: breaking.compare(baseFiles, headFiles) };
  });
  const md = breaking.markdown(result.r, { base: `${base} (merge base ${result.mb.slice(0, 10)})`, head: `working tree of ${path.basename(root)}` });
  await openUntitled(md, 'markdown');
  await pro.produced('breaking');
  rating.success();
  const c = result.r.counts;
  const json = () => Buffer.from(JSON.stringify({ base, mergeBase: result.mb, counts: c, findings: result.r.findings }, null, 2) + '\n', 'utf8');
  if (arg && typeof arg.jsonTarget === 'string') { await vscode.workspace.fs.writeFile(vscode.Uri.file(arg.jsonTarget), json()); return result.r; }
  // not awaited: the report is already open, the JSON file is optional
  vscode.window.showInformationMessage(`Breaking-change check: ${c.wire} wire, ${c.json} JSON, ${c.source} source finding(s) against ${base}.`, 'Save JSON for CI').then(async (pick) => {
    if (!pick) return;
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(root, 'proto-breaking.json')), filters: { JSON: ['json'] }, title: 'Save the findings as JSON' });
    if (target) await vscode.workspace.fs.writeFile(target, json());
  });
  return result.r;
}

async function runDocs(arg) {
  if (!(await pro.allowed('docs', arg))) return;
  if (indexing) await indexing;
  let files = index.allFiles().filter((f) => !f.startsWith(path.sep + '__'));
  let scopeName = ((vscode.workspace.workspaceFolders || [])[0] || { name: 'workspace' }).name;
  if (arg && arg.fsPath) {
    const p = arg.fsPath;
    const isDir = fs.existsSync(p) && fs.statSync(p).isDirectory();
    files = isDir ? files.filter((f) => f.startsWith(p + path.sep)) : [p];
    scopeName = path.basename(p);
    if (!isDir) index.get(p);
  } else if (vscode.window.activeTextEditor && isProtoDoc(vscode.window.activeTextEditor.document) && files.length === 0) {
    files = [keyOf(vscode.window.activeTextEditor.document.uri)];
  }
  if (!files.length) { vscode.window.showWarningMessage('No .proto files found here.'); return; }
  const fmt = arg && (arg.format === 'md' || arg.format === 'html') ? { value: arg.format } : await vscode.window.showQuickPick([
    { label: 'Markdown', description: 'one .md file, readable on GitHub', value: 'md' },
    { label: 'HTML', description: 'one self-contained page with a contents sidebar, light and dark', value: 'html' },
  ], { title: `API docs for ${files.length} .proto file(s) in ${scopeName}` });
  if (!fmt) return;
  const folder = folderOf(arg) || path.dirname(files[0]);
  const target = arg && typeof arg.target === 'string' ? vscode.Uri.file(arg.target) : await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(folder, fmt.value === 'md' ? 'API.md' : 'api.html')), filters: fmt.value === 'md' ? { Markdown: ['md'] } : { HTML: ['html'] }, title: 'Save the API docs' });
  if (!target) return;
  const relOf = (f) => { const r = index.rootFor(f); return (r ? path.relative(r, f) : path.basename(f)).split(path.sep).join('/'); };
  const list = files.sort().map((f) => ({ rel: relOf(f), ast: index.get(f), file: f })).filter((x) => x.ast);
  const byRel = new Map(list.map((x) => [x.rel, x.file]));
  const resolve = (rel, t, scope) => { const r = index.lookup(byRel.get(rel), t, scope); return r.def && r.def.file && files.includes(r.def.file) ? r.def.fullName : null; };
  const model = docsGen.collect(list, resolve);
  const title = `${scopeName} API reference`;
  const out = fmt.value === 'md' ? docsGen.markdown(model, { title }) : docsGen.html(model, { title });
  await vscode.workspace.fs.writeFile(target, Buffer.from(out, 'utf8'));
  await pro.produced('docs');
  rating.success();
  if (fmt.value === 'md') await vscode.window.showTextDocument(target, { preview: false });
  else {
    vscode.window.showInformationMessage(`API docs saved: ${path.basename(target.fsPath)} (${model.length} file(s)).`, 'Open in Browser', 'Open as Text').then((pick) => {
      if (pick === 'Open in Browser') vscode.env.openExternal(target);
      else if (pick === 'Open as Text') vscode.window.showTextDocument(target, { preview: false });
    });
  }
  return target;
}

async function runDecode(arg) {
  if (!(await pro.allowed('decode', arg))) return;
  if (indexing) await indexing;
  let bytes;
  let source;
  const fileUri = arg && arg.fsPath ? arg : arg && typeof arg.file === 'string' ? vscode.Uri.file(arg.file) : null;
  if (arg && typeof arg.text === 'string') {
    try { const r = wire.bytesFromText(arg.text); bytes = r.bytes; source = `${r.format} text (${r.bytes.length} bytes)`; } catch (e) { vscode.window.showErrorMessage(`Not decoded: ${e.message}`); return; }
  } else if (fileUri && !/\.proto$/i.test(fileUri.fsPath)) {
    bytes = new Uint8Array(await vscode.workspace.fs.readFile(fileUri));
    source = path.basename(fileUri.fsPath);
  } else {
    const ed = vscode.window.activeTextEditor;
    const sel = ed && !ed.selection.isEmpty ? ed.document.getText(ed.selection) : '';
    const input = sel && !isProtoDoc(ed.document) ? sel : await vscode.window.showInputBox({ title: 'Decode a protobuf message', prompt: 'Paste the bytes as hex (0a 03 66 6f 6f) or base64. To decode a file, right-click it in the Explorer.', ignoreFocusOut: true });
    if (!input) return;
    try { const r = wire.bytesFromText(input); bytes = r.bytes; source = `${r.format} text (${r.bytes.length} bytes)`; } catch (e) { vscode.window.showErrorMessage(`Not decoded: ${e.message}`); return; }
  }
  const items = [{ label: '$(symbol-numeric) No schema', description: 'field numbers and best guesses', value: null }];
  for (const f of index.allFiles()) {
    const a = index.get(f);
    if (!a) continue;
    for (const d of a.defs) if (d.kind === 'message' && !d.node.isGroup) items.push({ label: d.fullName.split('.').pop(), description: d.fullName, detail: vscode.workspace.asRelativePath(f), value: { file: f, def: d } });
  }
  const wanted = arg && typeof arg.message === 'string' ? items.find((i) => (arg.message === '' ? i.value === null : i.value && i.value.def.fullName === arg.message)) : null;
  const pick = wanted || await vscode.window.showQuickPick(items, { title: `Decode ${source} as`, matchOnDescription: true, matchOnDetail: true, placeHolder: 'The message type (type to search)' });
  if (!pick) return;
  let frame = null;
  const g = wire.stripGrpcFrame(bytes);
  if (g && !g.compressed) { frame = 'gRPC frame header (5 bytes) removed'; bytes = g.bytes; }
  const fileOfDef = new Map();
  for (const f of index.allFiles()) { const a = index.get(f); if (a) for (const d of a.defs) if (!fileOfDef.has(d.fullName)) fileOfDef.set(d.fullName, f); }
  const resolve = (field, msg) => {
    const f = fileOfDef.get(msg.fullName) || (pick.value && pick.value.file);
    if (!f || !field.type || SCALARS.has(field.type)) return null;
    const r = index.lookup(f, field.type, msg.fullName);
    return r.def && r.def.node && (r.def.kind === 'message' || r.def.kind === 'enum') ? { kind: r.def.kind, node: r.def.node } : null;
  };
  let value;
  try {
    value = wire.decodeMessage(bytes, pick.value ? { message: pick.value.def.node, resolve } : null);
  } catch (e) {
    vscode.window.showErrorMessage(`Not decoded as ${pick.value ? pick.value.def.fullName : 'raw protobuf'}: ${e.message}`);
    return;
  }
  const head = [
    `// ${source} decoded as ${pick.value ? pick.value.def.fullName : 'raw protobuf (no schema)'}${frame ? `, ${frame}` : ''}.`,
    '// 64-bit integers beyond 2^53 are strings, bytes are base64. Keys "#N" are field numbers the schema does not list.',
  ];
  await openUntitled(`${head.join('\n')}\n${JSON.stringify(value, null, 2)}\n`, 'jsonc');
  await pro.produced('decode');
  rating.success();
}

// ---------------- activation ----------------

function activate(context) {
  index = makeIndex();
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: PREFIX, name: 'Protobuf' });
  registerSupport({ vscode, context, prefix: PREFIX, selfId: EXT_ID });
  pro = createPro({ vscode, context });
  diagnostics = vscode.languages.createDiagnosticCollection('protobuf');
  context.subscriptions.push(diagnostics);
  const sel = [{ language: LANG }];
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(sel, {
    provideDocumentFormattingEdits(doc, options) {
      const indent = options.insertSpaces ? ' '.repeat(options.tabSize) : '\t';
      const src = doc.getText();
      const r = format(src, { indent });
      if (r.error) { vscode.window.setStatusBarMessage(`Protobuf: not formatted. ${r.error}`, 8000); return []; }
      let text = r.text;
      if (doc.eol === vscode.EndOfLine.CRLF) text = text.replace(/\n/g, '\r\n');
      const e = minimalEdit(src, text);
      if (!e) return [];
      return [vscode.TextEdit.replace(new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.text)];
    },
  }));
  context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(sel, {
    provideDocumentSymbols(doc) { return symbolTree(index.set(keyOf(doc.uri), doc.getText(), true)); },
  }));
  context.subscriptions.push(vscode.languages.registerWorkspaceSymbolProvider({
    provideWorkspaceSymbols(query) {
      const q = String(query || '').toLowerCase();
      const out = [];
      const K = { message: vscode.SymbolKind.Class, enum: vscode.SymbolKind.Enum, service: vscode.SymbolKind.Interface, extension: vscode.SymbolKind.Field };
      for (const f of index.allFiles()) {
        const a = index.get(f);
        if (!a) continue;
        for (const d of a.defs) {
          if (q && !d.fullName.toLowerCase().includes(q)) continue;
          out.push(new vscode.SymbolInformation(d.fullName.split('.').pop(), K[d.kind] || vscode.SymbolKind.Object, d.fullName.split('.').slice(0, -1).join('.'), new vscode.Location(uriOf(f), toRange(d.node.nameRange))));
          if (d.kind === 'service') for (const r of d.node.rpcs) if (!q || r.fullName.toLowerCase().includes(q)) out.push(new vscode.SymbolInformation(r.name, vscode.SymbolKind.Method, d.fullName, new vscode.Location(uriOf(f), toRange(r.nameRange))));
          if (out.length > 2000) return out;
        }
      }
      return out;
    },
  }));
  context.subscriptions.push(vscode.languages.registerDefinitionProvider(sel, {
    provideDefinition(doc, pos) {
      const k = keyOf(doc.uri);
      index.set(k, doc.getText(), true);
      const hit = index.definitionAt(k, pos.line, pos.character);
      if (!hit) return null;
      if (hit.file) return new vscode.Location(uriOf(hit.file), new vscode.Position(0, 0));
      return defLocation(hit.def);
    },
  }));
  context.subscriptions.push(vscode.languages.registerReferenceProvider(sel, {
    async provideReferences(doc, pos, ctx) {
      if (indexing) await indexing;
      const k = keyOf(doc.uri);
      index.set(k, doc.getText(), true);
      const hit = index.definitionAt(k, pos.line, pos.character);
      if (!hit || !hit.def) return [];
      const out = index.references(hit.def.fullName).map((r) => new vscode.Location(uriOf(r.file), toRange(r.range)));
      if (ctx && ctx.includeDeclaration) { const l = defLocation(hit.def); if (l) out.unshift(l); }
      return out;
    },
  }));
  context.subscriptions.push(vscode.languages.registerHoverProvider(sel, { provideHover: (doc, pos) => { index.set(keyOf(doc.uri), doc.getText(), true); return hoverFor(doc, pos); } }));
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(sel, { provideCompletionItems: (doc, pos) => completions(doc, pos) }, '.', '"', '=', '(', '<', ' '));

  reg(`${PREFIX}.rescan`, async () => { index = makeIndex(); indexing = indexWorkspace(); await indexing; indexing = null; refreshDiagnostics(); vscode.window.setStatusBarMessage(`Protobuf: ${indexedCount} .proto file(s) indexed.`, 5000); });
  reg(`${PREFIX}.breaking`, (arg) => runBreaking(arg));
  reg(`${PREFIX}.docs`, (arg) => runDocs(arg));
  reg(`${PREFIX}.decode`, (arg) => runDecode(arg));
  // Explorer right-click entries ("Zovo Pro: ..." titles), tagged as the "ctx" surface
  reg(`${PREFIX}.zovoPro.breaking`, (uri) => runBreaking(uri && uri.fsPath ? uri : { surface: 'ctx' }));
  reg(`${PREFIX}.zovoPro.docs`, (uri) => runDocs(uri && uri.fsPath ? uri : { surface: 'ctx' }));
  reg(`${PREFIX}.zovoPro.decode`, (uri) => runDecode(uri && uri.fsPath ? uri : { surface: 'ctx' }));
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: (uri) => pro.handleUri(uri) }));

  // keep the index and the diagnostics in step with the editor and the disk
  const opened = (d) => {
    if (!isProtoDoc(d)) return;
    const a = index.set(keyOf(d.uri), d.getText(), true);
    scheduleDiagnostics(50);
    if (a && !a.errors.length) rating.success(d.uri);
  };
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(opened));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => { if (isProtoDoc(e.document)) { index.set(keyOf(e.document.uri), e.document.getText(), true); scheduleDiagnostics(); } }));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((d) => {
    if (!isProtoDoc(d)) return;
    if (d.uri.scheme === 'file') { try { index.set(keyOf(d.uri), fs.readFileSync(d.uri.fsPath, 'utf8')); } catch { index.remove(keyOf(d.uri)); } } else index.remove(keyOf(d.uri));
    diagnostics.delete(d.uri);
  }));
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.proto');
  const fromDisk = (u) => {
    if (u.scheme !== 'file') return;
    if (vscode.workspace.textDocuments.some((d) => d.uri.toString() === u.toString())) return;
    fs.promises.readFile(u.fsPath, 'utf8').then((t) => { index.set(keyOf(u), t); scheduleDiagnostics(400); }, () => {});
  };
  context.subscriptions.push(watcher, watcher.onDidCreate(fromDisk), watcher.onDidChange(fromDisk), watcher.onDidDelete((u) => { index.remove(keyOf(u)); scheduleDiagnostics(400); }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(`${PREFIX}.importPaths`)) { index = makeIndex(); indexing = indexWorkspace().then(() => { indexing = null; refreshDiagnostics(); }); }
    else if (e.affectsConfiguration(PREFIX)) refreshDiagnostics();
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { indexing = indexWorkspace().then(() => { indexing = null; refreshDiagnostics(); }); }));

  for (const d of vscode.workspace.textDocuments) if (isProtoDoc(d)) index.set(keyOf(d.uri), d.getText(), true);
  refreshDiagnostics();
  indexing = indexWorkspace().then(() => { indexing = null; refreshDiagnostics(); }, () => { indexing = null; });

  // a small read-only API (used by the real-app test)
  return {
    indexed: () => index.allFiles().length,
    ready: () => (indexing ? indexing.then(() => true) : Promise.resolve(true)),
    tries: () => pro.tries(),
    diagnosticsFor: (uri) => diagnostics.get(uri) || [],
  };
}

function deactivate() { clearTimeout(diagTimer); }

module.exports = { activate, deactivate };

// Runs inside a real VS Code extension host (extensionTestsPath), with the sample workspace of scripts/make-sample.sh
// open. Writes PASS/FAIL lines to SMOKE_OUT.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const out = process.env.SMOKE_OUT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(150); } return null; }

exports.run = async function () {
  const log = [];
  const check = (name, ok, extra) => log.push((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' :: ' + String(extra).slice(0, 300) : ''));
  try {
    const ext = vscode.extensions.getExtension('zovo.zovo-protobuf');
    check('extension found', !!ext);
    const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    check('sample workspace open', !!ws, ws && ws.uri.fsPath);
    const P = (rel) => vscode.Uri.joinPath(ws.uri, rel);
    await until(() => ext.isActive, 15000);
    check('activated (workspaceContains .proto)', ext.isActive);
    const api = ext.exports;
    await api.ready();
    check('workspace indexed', api.indexed() >= 5, api.indexed());

    // language, highlighting grammar, clean file
    const shop = await vscode.workspace.openTextDocument(P('proto/shop/v1/shop.proto'));
    await vscode.window.showTextDocument(shop);
    check('.proto opens as protobuf', shop.languageId === 'protobuf', shop.languageId);
    await sleep(800);
    const shopDiag = vscode.languages.getDiagnostics(shop.uri);
    check('real file has no diagnostics', shopDiag.length === 0, shopDiag.map((d) => d.message).join(' | '));

    // errors like protoc
    const errs = await vscode.workspace.openTextDocument(P('proto/shop/v1/errors.proto'));
    await vscode.window.showTextDocument(errs);
    const ed = await until(() => { const d = vscode.languages.getDiagnostics(errs.uri); return d.length >= 3 ? d : null; }, 8000) || [];
    const m = ed.map((d) => `${d.range.start.line + 1}:${d.message}`);
    check('duplicate field number (protoc wording)', m.some((x) => x.startsWith('10:Field number 2 has already been used in "shop.v1.Refund" by field "amount". Next available field number is 4.')), m.join(' | '));
    check('unknown type', m.some((x) => x.startsWith('11:"Customer" is not defined.')), m.join(' | '));
    check('proto3 first enum value', m.some((x) => x.startsWith('15:The first enum value must be zero for open enums.')), m.join(' | '));
    check('errors are Error severity', ed.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length === 3, ed.length);

    // live update while typing
    const edi = vscode.window.activeTextEditor;
    await edi.edit((b) => b.replace(new vscode.Range(9, 0, 9, 22), '  string reason = 4;'));
    const fixed = await until(() => !vscode.languages.getDiagnostics(errs.uri).some((d) => /Field number 2/.test(d.message)), 5000);
    check('diagnostics update on edit', !!fixed, vscode.languages.getDiagnostics(errs.uri).map((d) => d.message).join(' | '));
    await vscode.commands.executeCommand('workbench.action.files.revert');

    // formatter
    const messy = await vscode.workspace.openTextDocument(P('proto/shop/v1/messy.proto'));
    await vscode.window.showTextDocument(messy);
    const edits = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', messy.uri, { tabSize: 2, insertSpaces: true });
    const we = new vscode.WorkspaceEdit();
    for (const e of edits || []) we.replace(messy.uri, e.range, e.newText);
    await vscode.workspace.applyEdit(we);
    const want = 'syntax = "proto3";\npackage shop.v1;\nimport "common/money.proto";\n// A gift card.\nmessage GiftCard {\n  string code = 1; // printed on the card\n  shop.common.Money balance = 2;\n  repeated string tags = 3 [deprecated = true];\n  map<string, string> labels = 4;\n}\n';
    const got = await until(() => (messy.getText() === want ? true : null), 5000);
    check('formatting provider (Format Document)', !!got, JSON.stringify(messy.getText()).slice(0, 300));
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await until(() => messy.getText() !== want, 3000);
    let viaCommand = null;
    for (let i = 0; i < 3 && !viaCommand; i++) {
      await vscode.window.showTextDocument(messy, { preserveFocus: false });
      await sleep(500);
      await vscode.commands.executeCommand('editor.action.formatDocument');
      viaCommand = await until(() => (messy.getText() === want ? true : null), 3000);
    }
    check('editor.action.formatDocument command', !!viaCommand, JSON.stringify(messy.getText()).slice(0, 200));
    await vscode.commands.executeCommand('workbench.action.files.revert');

    // definition, references, hover, symbols, completion
    const lines = shop.getText().split('\n');
    const ln = lines.findIndex((l) => l.includes('shop.common.Money total'));
    const pos = new vscode.Position(ln, lines[ln].indexOf('Money') + 2);
    const defs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', shop.uri, pos);
    const d0 = defs && defs[0];
    const dUri = d0 && (d0.uri || d0.targetUri);
    check('go to definition across an import', dUri && dUri.fsPath.endsWith(path.join('common', 'money.proto')), dUri && dUri.fsPath);
    const refs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', shop.uri, pos);
    check('find references (Money used 3 times in the workspace)', refs && refs.length >= 3, refs && refs.map((r) => path.basename(r.uri.fsPath) + ':' + (r.range.start.line + 1)).join(' '));
    const hov = await vscode.commands.executeCommand('vscode.executeHoverProvider', shop.uri, pos);
    const htext = (hov || []).map((h) => h.contents.map((c) => c.value || c).join('\n')).join('\n');
    check('hover shows the type and its comment', /message shop\.common\.Money/.test(htext) && /An amount of money in one currency/.test(htext), htext.slice(0, 200));
    const syms = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', shop.uri);
    const names = (syms || []).map((s) => s.name);
    check('outline', ['OrderService', 'Order', 'Address', 'Status'].every((n) => names.includes(n)), names.join(','));
    const wsSyms = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', 'Money');
    check('workspace symbols', (wsSyms || []).some((s) => s.name === 'Money'), (wsSyms || []).length);
    const comp = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', shop.uri, new vscode.Position(lines.findIndex((l) => l.includes('string city = 2;')), 2));
    const labels = (comp && comp.items || []).map((c) => (typeof c.label === 'string' ? c.label : c.label.label));
    check('completion: types and scalars', labels.includes('Order') && labels.includes('int64') && labels.includes('shop.common.Money'), labels.slice(0, 12).join(','));
    const defImp = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', shop.uri, new vscode.Position(lines.findIndex((l) => l.startsWith('import "common')), 12));
    check('ctrl-click an import opens the file', defImp && defImp[0] && (defImp[0].uri || defImp[0].targetUri).fsPath.endsWith('money.proto'));

    // Pro 1: breaking-change check against main (try 1 of 3)
    const before = api.tries();
    check('3 free tries per tool at start', before.breaking === 3 && before.docs === 3 && before.decode === 3, JSON.stringify(before));
    const jsonOut = path.join(os.tmpdir(), `zovo-proto-breaking-${process.pid}.json`);
    const r = await vscode.commands.executeCommand('zovoProto.breaking', { jsonTarget: jsonOut });
    const rep = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.getText();
    check('breaking report opened', /^# Protobuf breaking-change check/.test(rep || ''), (rep || '').slice(0, 100));
    const rules = r ? r.findings.map((f) => f.rule) : [];
    check('breaking findings', ['FIELD_RENAMED', 'FIELD_REMOVED', 'FIELD_TYPE_CHANGED', 'ENUM_VALUE_REMOVED'].every((x) => rules.includes(x)), rules.join(','));
    let jsonOk = false;
    try { jsonOk = JSON.parse(fs.readFileSync(jsonOut, 'utf8')).counts.wire >= 2; fs.unlinkSync(jsonOut); } catch { /* missing */ }
    check('breaking JSON for CI', jsonOk);
    check('breaking try counted', api.tries().breaking === 2, JSON.stringify(api.tries()));

    // Pro 2: API docs (Markdown and HTML)
    const md = path.join(ws.uri.fsPath, 'API.md');
    await vscode.commands.executeCommand('zovoProto.docs', { format: 'md', target: md });
    const mdText = fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : '';
    check('API docs Markdown', /### OrderService \(service\)/.test(mdText) && /\| GetOrder \|/.test(mdText) && /\| total \| 6 \|/.test(mdText), mdText.slice(0, 120));
    const html = path.join(ws.uri.fsPath, 'api.html');
    await vscode.commands.executeCommand('zovoProto.docs', { format: 'html', target: html });
    const htmlText = fs.existsSync(html) ? fs.readFileSync(html, 'utf8') : '';
    check('API docs HTML', /<h3 id="shop-v1-order">Order<\/h3>/.test(htmlText) && !/<script/i.test(htmlText), htmlText.length);
    check('docs tries counted', api.tries().docs === 1, JSON.stringify(api.tries()));

    // Pro 3: decode a binary message, 3 tries then the gate
    await vscode.commands.executeCommand('zovoProto.decode', { file: path.join(ws.uri.fsPath, 'data', 'order.bin'), message: 'shop.v1.Order' });
    const dec = vscode.window.activeTextEditor.document.getText();
    check('decode order.bin with the schema', /"id": "A-1001"/.test(dec) && /"status": 2|"status": "STATUS_SHIPPED"/.test(dec) && /"channel": "web"/.test(dec) && /"currency_code": "EUR"/.test(dec), dec.slice(0, 200));
    await vscode.commands.executeCommand('zovoProto.decode', { text: '0a 03 66 6f 6f', message: '' });
    const raw = vscode.window.activeTextEditor.document.getText();
    check('decode hex with no schema', /"#1": "foo"/.test(raw), raw.slice(0, 200));
    await vscode.commands.executeCommand('zovoProto.decode', { text: 'CgZBLTEwMDE=', message: 'shop.v1.Order' });
    check('decode base64', /"id": "A-1001"/.test(vscode.window.activeTextEditor.document.getText()));
    check('3 decode tries used', api.tries().decode === 0, JSON.stringify(api.tries()));
    const untitledBefore = vscode.workspace.textDocuments.filter((d) => d.isUntitled).length;
    vscode.commands.executeCommand('zovoProto.decode', { text: '0a 03 66 6f 6f', message: '' }); // 4th: the Pro panel (modal), never resolves here
    await sleep(1500);
    const untitledAfter = vscode.workspace.textDocuments.filter((d) => d.isUntitled).length;
    check('4th decode is gated (no new output)', untitledAfter === untitledBefore, `${untitledBefore} -> ${untitledAfter}`);

    // menus: the Explorer entries are real commands with "Zovo Pro:" titles
    const all = await vscode.commands.getCommands(true);
    check('Explorer Pro commands registered', ['zovoProto.zovoPro.breaking', 'zovoProto.zovoPro.docs', 'zovoProto.zovoPro.decode'].every((c) => all.includes(c)));
  } catch (e) {
    log.push('FAIL exception :: ' + (e && e.stack || e));
  }
  fs.writeFileSync(out, log.join('\n') + '\n');
};

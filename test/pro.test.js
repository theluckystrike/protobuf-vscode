'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createPro, TRIAL_USES, TRIAL_KEY, FEATURES } = require('../src/pro');

function fakeVscode(messages) {
  class EventEmitter { constructor() { this.l = []; this.event = (f) => { this.l.push(f); return { dispose() {} }; }; } fire(v) { for (const f of this.l) f(v); } dispose() {} }
  return { EventEmitter, window: { setStatusBarMessage: (m) => messages.push(m) } };
}
function ctx() { const m = new Map(); return { subscriptions: [], globalState: { get: (k) => m.get(k), update: async (k, v) => { m.set(k, v); } } }; }

test('3 free tries per tool, counted only after output, then the Pro panel with the surface', async () => {
  const msgs = []; const asked = [];
  const license = { isPro: () => false, requirePro: async (title, d) => { asked.push([title, d.surface]); return false; }, onDidChange() {} };
  const p = createPro({ vscode: fakeVscode(msgs), context: ctx(), license });
  assert.equal(TRIAL_USES, 3);
  for (let i = 0; i < 3; i++) { assert.equal(await p.allowed('decode'), true); await p.produced('decode'); }
  assert.equal(p.left('decode'), 0);
  assert.equal(p.left('docs'), 3);
  assert.equal(await p.allowed('decode', { surface: 'toolbar' }), false);
  assert.equal(await p.allowed('decode', { fsPath: '/x.bin', scheme: 'file' }), false);
  assert.deepEqual(asked, [['Decode a binary message', 'toolbar'], ['Decode a binary message', 'ctx']]);
  assert.match(msgs[2], /free try 3 of 3/);
  assert.deepEqual(p.tries(), { breaking: 3, docs: 3, decode: 0 });
});

test('a stale globalState read never gives tries back or drops another tool', async () => {
  const c = ctx();
  const p = createPro({ vscode: fakeVscode([]), context: c, license: { isPro: () => false, requirePro: async () => false, onDidChange() {} } });
  await p.produced('breaking');
  await c.globalState.update(TRIAL_KEY, undefined); // what a late storage echo looks like
  await p.produced('docs');
  assert.deepEqual(c.globalState.get(TRIAL_KEY), { breaking: 1, docs: 1 });
  assert.deepEqual(p.tries(), { breaking: 2, docs: 2, decode: 3 });
});

test('a licensed user never uses tries', async () => {
  const c = ctx();
  const p = createPro({ vscode: fakeVscode([]), context: c, license: { isPro: () => true, requirePro: async () => assert.fail('no panel'), onDidChange() {} } });
  for (let i = 0; i < 5; i++) { assert.equal(await p.allowed('breaking'), true); await p.produced('breaking'); }
  assert.equal(c.globalState.get(TRIAL_KEY), undefined);
});

test('package.json: id, name, phrase first, 5 keywords, engines, activation, Pro and Explorer commands', () => {
  const pk = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(`${pk.publisher}.${pk.name}`, 'zovo.zovo-protobuf');
  assert.ok(pk.displayName.length <= 30);
  assert.ok(pk.displayName.startsWith('Protobuf'));
  assert.ok(pk.description.startsWith('Protobuf'));
  assert.equal(pk.keywords.length, 5);
  assert.ok(!pk.activationEvents.includes('*'));
  assert.match(pk.engines.vscode, /^\^1\.(7\d|8\d)\./);
  const cmds = new Map(pk.contributes.commands.map((c) => [c.command, c.title]));
  for (const c of ['zovoProto.breaking', 'zovoProto.docs', 'zovoProto.decode', 'zovoProto.getPro', 'zovoProto.enterLicenseKey']) assert.ok(cmds.has(c), c);
  // Explorer entries: own commands whose title starts with "Zovo Pro:" (VS Code ignores a title on a menu item)
  const ctxMenu = pk.contributes.menus['explorer/context'];
  assert.equal(ctxMenu.length, 3);
  for (const m of ctxMenu) { assert.match(cmds.get(m.command), /^Zovo Pro: /); assert.equal(m.title, undefined); }
  const hidden = new Set(pk.contributes.menus.commandPalette.filter((m) => m.when === 'false').map((m) => m.command));
  for (const m of ctxMenu) assert.ok(hidden.has(m.command), m.command);
  assert.equal(Object.keys(FEATURES).length, 3);
  assert.ok(fs.existsSync(path.join(__dirname, '..', pk.icon)));
});

test('activation shows no message on its own; no network module anywhere in the product code', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.js'), 'utf8');
  const act = src.slice(src.indexOf('function activate('), src.indexOf('function deactivate('));
  assert.ok(!/show(Information|Warning|Error)Message/.test(act));
  const files = ['extension.js', 'git.js', 'pro.js', ...fs.readdirSync(path.join(__dirname, '..', 'src', 'proto')).map((f) => `proto/${f}`)];
  for (const f of files) {
    const s = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    assert.ok(!/require\(['"](https?|net|tls|dgram)['"]\)|fetch\(|XMLHttpRequest/.test(s), f);
  }
});

test('grammar and language configuration are valid JSON with the protobuf scope', () => {
  const g = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'syntaxes', 'protobuf.tmLanguage.json'), 'utf8'));
  assert.equal(g.scopeName, 'source.proto');
  for (const [k, v] of Object.entries(g.repository)) {
    for (const pat of [v, ...(v.patterns || [])]) for (const key of ['match', 'begin', 'end']) if (pat[key]) assert.doesNotThrow(() => new RegExp(pat[key].replace(/\(\?i:/g, '(?:')), `${k}.${key}`);
  }
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'language-configuration.json'), 'utf8'));
});

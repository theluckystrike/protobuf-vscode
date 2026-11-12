'use strict';
// Zovo Pro for Protobuf & Proto3 Formatter, on top of the shared license module (src/license, copied unchanged from
// factory/sprint/license by apply.sh). Three Pro tools, 3 free tries each on this computer. A try counts only after the
// tool produced its output (a report, a docs file or a decoded message); Escape, Cancel or an error never uses one.
// Nothing about Pro shows on open or activation: the panel appears only after a click on a Pro tool with no tries left.
const { createLicense } = require('./license');

const SKU = 'protobuf-pro';
const TRIAL_USES = 3;
const TRIAL_KEY = 'zovoProto.proTrial';

const FEATURES = {
  breaking: {
    title: 'Check breaking changes against git',
    detail: 'Compares every .proto file with main (or the branch you set) and lists removed fields, changed numbers and types, renamed enum values and removed methods, with a JSON file for CI.',
  },
  docs: {
    title: 'Generate API docs',
    detail: 'Writes one Markdown file or one self-contained HTML page with every service, method, message, field and enum, their comments and the HTTP routes.',
  },
  decode: {
    title: 'Decode a binary message',
    detail: 'Turns protobuf bytes (a file, hex or base64) into readable JSON with your .proto schema: field names, enums, maps and nested messages.',
  },
};
const TOOLS = Object.values(FEATURES).map((f) => f.title);

function surfaceOf(arg) {
  if (arg && typeof arg === 'object' && typeof arg.surface === 'string') return arg.surface;
  if (arg && typeof arg === 'object' && (arg.fsPath || arg.scheme)) return 'ctx';
  return undefined;
}

function createPro({ vscode, context, license, prefix = 'zovoProto', productName = 'Protobuf & Proto3 Formatter' }) {
  const emitter = new vscode.EventEmitter();
  const lic = license || createLicense({ vscode, context, sku: SKU, name: 'Zovo', product: productName, commandPrefix: prefix, proTools: TOOLS });
  if (lic.onDidChange) lic.onDidChange(() => emitter.fire(lic.isPro(SKU)));

  // Counts never go down in a session: VS Code's shared globalState can hand back an older value for a moment after a
  // write from another window or at start-up, so the highest count seen here wins.
  const seen = {};
  const used = (f) => Math.max(Number((context.globalState.get(TRIAL_KEY) || {})[f]) || 0, seen[f] || 0);
  const left = (f) => (FEATURES[f] ? Math.max(0, TRIAL_USES - used(f)) : 0);
  const licensed = () => lic.isPro(SKU);

  /** Before a Pro tool runs: true when it may run (licensed, or a free try left). Otherwise the one panel. */
  async function allowed(f, arg) {
    if (licensed()) { if (lic.refresh) lic.refresh(); return true; }
    if (left(f) > 0) return true;
    const feat = FEATURES[f] || { title: 'This tool', detail: '' };
    const surface = surfaceOf(arg);
    return !!(await lic.requirePro(feat.title, { detail: feat.detail, triesUsed: used(f), tools: TOOLS, ...(surface ? { surface } : {}) }));
  }

  /** After the tool produced its output: counts one free try (nothing when licensed). */
  async function produced(f) {
    if (licensed() || !FEATURES[f]) return;
    const m = { ...(context.globalState.get(TRIAL_KEY) || {}) };
    for (const k of Object.keys(seen)) m[k] = Math.max(Number(m[k]) || 0, seen[k]);
    m[f] = used(f) + 1;
    seen[f] = m[f];
    await context.globalState.update(TRIAL_KEY, m);
    const l = left(f);
    vscode.window.setStatusBarMessage(`Zovo Pro: free try ${used(f)} of ${TRIAL_USES} of "${FEATURES[f].title}" used${l ? `, ${l} left` : ''} on this computer.`, 8000);
    emitter.fire(false);
  }

  context.subscriptions.push(emitter);
  return {
    SKU, FEATURES, TRIAL_USES,
    get licensed() { return licensed(); },
    ready: lic.ready,
    allowed, produced, left,
    tries: () => Object.fromEntries(Object.keys(FEATURES).map((f) => [f, left(f)])),
    handleUri: (uri) => (lic.handleUri ? lic.handleUri(uri) : undefined),
    onDidChange: emitter.event,
    license: lic,
  };
}

module.exports = { createPro, FEATURES, SKU, TRIAL_USES, TRIAL_KEY, TOOLS, surfaceOf };

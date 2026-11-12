'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tokenize, unquote } = require('../src/proto/lexer');
const { parse } = require('../src/proto/parser');
const { format, minimalEdit } = require('../src/proto/format');
const { createIndex } = require('../src/proto/index');
const { check } = require('../src/proto/check');
const wire = require('../src/proto/wire');
const breaking = require('../src/proto/breaking');
const docs = require('../src/proto/docs');

const FX = path.join(__dirname, 'fixtures');
const read = (p) => fs.readFileSync(path.join(FX, p), 'utf8');

// an index over in-memory files under /ws
function memIndex(files, root = '/ws') {
  const idx = createIndex({ readFile: () => null, fileExists: () => false, roots: () => [root], importPaths: () => [] });
  for (const [rel, text] of Object.entries(files)) idx.set(path.join(root, rel), text);
  return idx;
}
function diag(text, extra = {}) {
  const idx = memIndex({ 'a.proto': text, ...extra });
  return check(idx, path.join('/ws', 'a.proto'));
}
const msgs = (d) => d.filter((x) => x.severity === 'error').map((x) => x.message);

// ---------- lexer and parser ----------

test('lexer: strings with escapes, numbers, comments and positions', () => {
  const { tokens, errors } = tokenize('a = "x\\ny\\x41\\101"; // c\n/* b */ 0x1F -3 1.5e3');
  assert.equal(errors.length, 0);
  assert.deepEqual(tokens.map((t) => t.kind), ['ident', 'sym', 'string', 'sym', 'comment', 'comment', 'int', 'sym', 'int', 'float']);
  assert.equal(unquote(tokens[2]), 'x\nyAA');
  assert.equal(tokens[5].line, 1);
  assert.equal(tokens[5].nlBefore, 1);
});

test('parser: proto3 file with services, nested types, maps, oneofs, comments', () => {
  const a = parse(read('shop/v1/shop.proto'));
  assert.equal(a.errors.length, 0);
  assert.equal(a.syntax, 'proto3');
  assert.equal(a.package, 'shop.v1');
  assert.deepEqual(a.imports.map((i) => i.path), ['common/money.proto', 'google/protobuf/timestamp.proto']);
  const order = a.messages.find((m) => m.name === 'Order');
  assert.equal(order.comment, 'One order and its lines.');
  assert.equal(order.fields.length, 11);
  assert.deepEqual(order.oneofs[0].fields.map((f) => f.name), ['pickup_store', 'address']);
  assert.equal(order.fields.find((f) => f.name === 'labels').map.key, 'string');
  assert.equal(order.messages[0].fullName, 'shop.v1.Order.Line');
  const svc = a.services[0];
  assert.equal(svc.rpcs[1].outputStream, true);
  assert.equal(svc.rpcs[0].comment, 'Returns one order.');
});

test('parser: proto2 descriptor.proto (groups-free, extensions, defaults) has no errors', () => {
  const a = parse(read('descriptor.proto'));
  assert.equal(a.errors.length, 0, JSON.stringify(a.errors.slice(0, 3)));
  assert.equal(a.syntax, 'proto2');
  assert.ok(a.defs.length > 40);
});

test('parser: groups, editions, extend, reserved names and aggregate options', () => {
  const a = parse(`edition = "2023";
package p;
option features.field_presence = IMPLICIT;
message M {
  reserved 4, 9 to 11;
  reserved foo, bar;
  extensions 100 to max [declaration = { number: 100 full_name: ".p.x" type: "int32" }];
  int32 a = 1 [features.field_presence = EXPLICIT];
}
extend M { int32 x = 100; }
`);
  assert.equal(a.errors.length, 0, JSON.stringify(a.errors));
  assert.equal(a.edition, '2023');
  const m = a.messages[0];
  assert.deepEqual(m.reserved.names.map((n) => n.name), ['foo', 'bar']);
  assert.equal(m.extensions[0].hi, 536870911);
  assert.equal(a.extends[0].fields[0].fullName, 'p.x');
});

test('parser: errors are protoc-like and the parser keeps going', () => {
  const a = parse('syntax = "proto3";\nmessage A {\n  string a = 1\n  string b = 2;\n}\nmessage B { int32 c = 1; }\n');
  assert.equal(a.errors[0].message, 'Expected ";".');
  assert.equal(a.errors[0].line, 3);
  assert.ok(a.messages.some((m) => m.name === 'B'));
});

// ---------- formatter ----------

test('formatter: messy input becomes one statement per line, comments kept', () => {
  const src = 'syntax="proto3";package a.b;\n\n\n\nimport  "x.proto" ;\nmessage  Foo{int32 a=1;// first\n  repeated   string b = 2 [ deprecated=true ,json_name="bb" ];\n\n\n  map< string ,Foo > m=3;oneof k{string s=4;}\nenum E{E_UNSPECIFIED=0;E_ONE = 1 ;}\nmessage Empty {\n}\n}\nservice S{rpc Get ( Foo ) returns ( stream Foo ) {}\n}\n';
  const r = format(src);
  assert.equal(r.error, undefined);
  assert.equal(r.text, [
    'syntax = "proto3";',
    'package a.b;',
    '',
    'import "x.proto";',
    'message Foo {',
    '  int32 a = 1; // first',
    '  repeated string b = 2 [deprecated = true, json_name = "bb"];',
    '',
    '  map<string, Foo> m = 3;',
    '  oneof k {',
    '    string s = 4;',
    '  }',
    '  enum E {',
    '    E_UNSPECIFIED = 0;',
    '    E_ONE = 1;',
    '  }',
    '  message Empty {}',
    '}',
    'service S {',
    '  rpc Get(Foo) returns (stream Foo) {}',
    '}',
    '',
  ].join('\n'));
  assert.equal(format(r.text).text, r.text, 'idempotent');
});

test('formatter: aggregate options, wrapped lines and tabs', () => {
  const src = 'syntax = "proto3";\nservice S {\n  rpc A(R) returns (R) {\n      option (google.api.http) = {\n        post: "/v1/a"\n        body: "*"\n      };\n  }\n  rpc B(R)\n      returns (R);\n}\nmessage R { string very_long_field_name = 1\n      [(x.y) = true]; }\n';
  const r = format(src, { indent: '\t' });
  assert.match(r.text, /\n\t\toption \(google\.api\.http\) = \{\n\t\t\tpost: "\/v1\/a"\n\t\t\tbody: "\*"\n\t\t\};/);
  assert.match(r.text, /\trpc B\(R\)\n\t\t\treturns \(R\);/);
  assert.match(r.text, /string very_long_field_name = 1\n\t\t\t\[\(x\.y\) = true\];/);
  assert.equal(format(r.text, { indent: '\t' }).text, r.text);
});

test('formatter: real files keep every token and are idempotent', () => {
  for (const f of ['descriptor.proto', 'route_guide.proto', 'shop/v1/shop.proto']) {
    const src = read(f);
    const r = format(src);
    const a = tokenize(src).tokens.map((t) => (t.kind === 'comment' ? t.value.replace(/\s+/g, ' ') : t.value));
    const b = tokenize(r.text).tokens.map((t) => (t.kind === 'comment' ? t.value.replace(/\s+/g, ' ') : t.value));
    assert.deepEqual(b, a, f);
    assert.equal(format(r.text).text, r.text, f);
  }
});

test('formatter: refuses a file that does not parse', () => {
  const r = format('message A { int32 a = 1 }');
  assert.match(r.error, /Line 1: Expected ";"/);
});

test('minimalEdit gives one small replacement', () => {
  assert.equal(minimalEdit('abc', 'abc'), null);
  assert.deepEqual(minimalEdit('a  = 1;', 'a = 1;'), { start: 2, end: 3, text: '' });
});

// ---------- diagnostics (messages as printed by protoc 36.2 on the same input) ----------

test('diagnostics match protoc on common mistakes', () => {
  assert.deepEqual(msgs(diag('syntax = "proto3";\npackage demo;\nmessage A {\n  string a = 1;\n  int32 b = 1;\n}\n')),
    ['Field number 1 has already been used in "demo.A" by field "a". Next available field number is 2.']);
  assert.deepEqual(msgs(diag('syntax = "proto3";\npackage demo;\nmessage A {\n  Missing m = 1;\n}\n')), ['"Missing" is not defined.']);
  assert.deepEqual(msgs(diag('syntax = "proto3";\npackage demo;\nenum Color {\n  RED = 1;\n}\n')), ['The first enum value must be zero for open enums.']);
  assert.deepEqual(msgs(diag('syntax = "proto3";\nmessage A {\n  required string a = 1;\n}\n')), ['Required fields are not allowed in proto3.']);
  assert.deepEqual(msgs(diag('syntax = "proto3";\nmessage A {\n  reserved 2, 5 to 9;\n  reserved "old";\n  string a = 6;\n  string old = 1;\n}\n')),
    ['Field "a" uses reserved number 6.', 'Field name "old" is reserved.']);
  assert.deepEqual(msgs(diag('syntax = "proto3";\npackage demo;\nenum E {\n  E_UNSPECIFIED = 0;\n  E_A = 1;\n  E_B = 1;\n}\n')),
    ['"demo.E_B" uses the same enum value as "demo.E_A". If this is intended, set \'option allow_alias = true;\' to the enum definition. The next available enum value is 2.']);
  assert.deepEqual(msgs(diag('syntax = "proto3";\nmessage A {\n  map<double, string> m = 1;\n}\n')), ['Key in map fields cannot be float/double, bytes or message types.']);
  assert.deepEqual(msgs(diag('syntax = "proto2";\nmessage A {\n  string a = 1;\n}\n')), ['Expected "required", "optional", or "repeated".']);
  assert.deepEqual(msgs(diag('syntax = "proto3";\nmessage A {\n  int32 a = 1 [default = 5];\n}\n')), ['Explicit default values are not allowed in proto3.']);
  assert.deepEqual(msgs(diag('syntax = "proto3";\nmessage A {\n  oneof x {\n    repeated string a = 1;\n  }\n}\n')), ['Fields in oneofs must not have labels (required / optional / repeated).']);
  assert.deepEqual(msgs(diag('edition = "2023";\nmessage A {\n  optional string a = 1;\n}\n')), ['Label "optional" is not supported in editions. By default, all singular fields have presence unless features.field_presence is set.']);
  assert.deepEqual(msgs(diag('syntax = "proto3";\nmessage A {\n  string a = 19001;\n}\n')), ['Field numbers 19000 through 19999 are reserved for the protocol buffer library implementation.']);
  assert.deepEqual(msgs(diag('syntax = "proto3";\npackage foo.bar;\nmessage Outer {\n  message foo {}\n  foo.bar.Inner x = 1;\n}\nmessage Inner {}\n')),
    ['"foo.bar.Inner" is resolved to "foo.bar.Outer.foo.bar.Inner", which is not defined. The innermost scope is searched first in name resolution. Consider using a leading \'.\'(i.e., ".foo.bar.Inner") to start from the outermost scope.']);
  const dup = msgs(diag('syntax = "proto3";\npackage demo;\nenum X { X_ZERO = 0; SAME = 1; }\nenum Y { Y_ZERO = 0; SAME = 1; }\n'));
  assert.match(dup[0], /^"SAME" is already defined in "demo"\. {2}Note that enum values use C\+\+ scoping rules/);
  assert.deepEqual(msgs(diag('syntax = "proto2";\npackage demo;\nmessage A {\n  extensions 100 to 199;\n  optional string a = 150;\n}\nextend A {\n  optional int32 x = 300;\n}\n')),
    ['Extension range 100 to 199 includes field "a" (150).', '"demo.A" does not declare 300 as an extension number.']);
});

test('diagnostics: positions are on the offending token', () => {
  const d = diag('syntax = "proto3";\npackage demo;\nmessage A {\n  string a = 1;\n  int32 b = 1;\n}\n');
  assert.deepEqual([d[0].range.line, d[0].range.col], [4, 12]);
});

test('diagnostics: editions features from the file and enclosing messages', () => {
  assert.deepEqual(msgs(diag('edition = "2023";\noption features.enum_type = CLOSED;\nenum E { A = 1; }\n')), []);
  assert.deepEqual(msgs(diag('edition = "2023";\noption features = { enum_type: CLOSED };\nmessage M { enum E { A = 1; } }\n')), []);
  assert.deepEqual(msgs(diag('edition = "2023";\nenum E { A = 1; }\n')), ['The first enum value must be zero for open enums.']);
});

test('no false red marks: real files clean, missing imports only warn on the import line', () => {
  const idx = memIndex({ 'shop/v1/shop.proto': read('shop/v1/shop.proto'), 'common/money.proto': read('common/money.proto'), 'route_guide.proto': read('route_guide.proto'), 'google/protobuf/descriptor.proto': read('descriptor.proto') });
  for (const f of ['shop/v1/shop.proto', 'common/money.proto', 'route_guide.proto', 'google/protobuf/descriptor.proto']) assert.deepEqual(check(idx, path.join('/ws', f)), [], f);
  const d = diag('syntax = "proto3";\nimport "vendor/thing.proto";\nmessage A { thing.Thing t = 1; Nope n = 2; }\n');
  assert.equal(d.length, 1);
  assert.equal(d[0].severity, 'warning');
  assert.match(d[0].message, /Import "vendor\/thing\.proto" was not found/);
});

test('types from a file that is not imported: protoc-style hint to add the import', () => {
  const d = diag('syntax = "proto3";\nmessage A { shop.common.Money m = 1; }\n', { 'common/money.proto': read('common/money.proto') });
  assert.match(d[0].message, /"shop\.common\.Money" seems to be defined in "common\/money\.proto", which is not imported by "a\.proto"/);
});

test('unused imports are faded hints, used ones are not', () => {
  const d = diag('syntax = "proto3";\nimport "google/protobuf/timestamp.proto";\nimport "common/money.proto";\nmessage A { google.protobuf.Timestamp t = 1; }\n', { 'common/money.proto': read('common/money.proto') });
  assert.equal(d.length, 1);
  assert.equal(d[0].severity, 'hint');
  assert.equal(d[0].unnecessary, true);
  assert.equal(d[0].message, 'Import common/money.proto is unused.');
});

// ---------- index: imports, definitions, references ----------

test('index: go to definition across imports and find references', () => {
  const idx = memIndex({ 'shop/v1/shop.proto': read('shop/v1/shop.proto'), 'common/money.proto': read('common/money.proto') });
  const f = path.join('/ws', 'shop/v1/shop.proto');
  const text = read('shop/v1/shop.proto').split('\n');
  const line = text.findIndex((l) => l.includes('shop.common.Money total'));
  const hit = idx.definitionAt(f, line, text[line].indexOf('Money') + 1);
  assert.equal(hit.def.fullName, 'shop.common.Money');
  assert.equal(hit.def.file, path.join('/ws', 'common/money.proto'));
  const refs = idx.references('shop.common.Money');
  assert.equal(refs.length, 2); // Order.total and Order.Line.price
  const imp = text.findIndex((l) => l.includes('import "common/money.proto"'));
  assert.equal(idx.definitionAt(f, imp, 10).file, path.join('/ws', 'common/money.proto'));
  const nested = idx.lookup(f, 'Line', 'shop.v1.Order');
  assert.equal(nested.def.fullName, 'shop.v1.Order.Line');
});

test('index: imports resolve from parent folders and from import paths', () => {
  const idx = createIndex({ readFile: () => null, fileExists: () => false, roots: () => ['/ws'], importPaths: () => ['/ws/third_party'] });
  idx.set('/ws/proto/a/v1/a.proto', 'syntax = "proto3";\nimport "b/v1/b.proto";\nimport "ext/e.proto";\nmessage A { b.v1.B b = 1; e.E e = 2; }\n');
  idx.set('/ws/proto/b/v1/b.proto', 'syntax = "proto3";\npackage b.v1;\nmessage B {}\n');
  idx.set('/ws/third_party/ext/e.proto', 'syntax = "proto3";\npackage e;\nmessage E {}\n');
  assert.deepEqual(check(idx, '/ws/proto/a/v1/a.proto'), []);
});

// ---------- Pro engines ----------

function shopSchema() {
  const idx = memIndex({ 'shop/v1/shop.proto': read('shop/v1/shop.proto'), 'common/money.proto': read('common/money.proto') });
  const f = path.join('/ws', 'shop/v1/shop.proto');
  idx.visible(f);
  const fileOf = new Map();
  for (const x of idx.allFiles()) for (const d of idx.get(x).defs) fileOf.set(d.fullName, x);
  const resolve = (field, msg) => { const r = idx.lookup(fileOf.get(msg.fullName) || f, field.type, msg.fullName); return r.def && r.def.node && (r.def.kind === 'message' || r.def.kind === 'enum') ? { kind: r.def.kind, node: r.def.node } : null; };
  return { idx, f, resolve };
}

test('decoder: a message encoded by protoc decodes with names, enums, maps, oneof, packed, sint64, bytes', () => {
  const { idx, f, resolve } = shopSchema();
  const order = idx.get(f).defs.find((d) => d.fullName === 'shop.v1.Order').node;
  const out = wire.decodeMessage(fs.readFileSync(path.join(FX, 'order.bin')), { message: order, resolve });
  assert.deepEqual(out, {
    id: 'A-1001', status: 'STATUS_SHIPPED',
    lines: [{ sku: 'MUG-RED', qty: 2, price: { currency_code: 'EUR', units: 12, nanos: 500000000 } }, { sku: 'TEE-L', qty: 1 }],
    labels: { channel: 'web', gift: 'yes' }, created: { seconds: 1762944000 }, total: { currency_code: 'EUR', units: 37 },
    address: { street: '1 Main St', city: 'Lyon' }, coupon_ids: [7, 300, -1], balance: -42, signature: 'AQID',
  });
});

test('decoder: no schema, hex and base64 input, gRPC frame, bad input', () => {
  const raw = wire.decodeMessage(fs.readFileSync(path.join(FX, 'route_guide_feature.bin')), null);
  assert.equal(raw['#1'], 'Patriots Path, Mendham, NJ 07945, USA');
  assert.deepEqual(raw['#2'], { '#1': 407838351, '#2': '18446744072963407853' }); // int32 -746143763 seen as a raw varint
  assert.deepEqual(wire.bytesFromText('0a 03 66 6f 6f').bytes, Buffer.from([10, 3, 102, 111, 111]));
  assert.deepEqual(wire.bytesFromText('CgNmb28=').bytes, Buffer.from([10, 3, 102, 111, 111]));
  const framed = Buffer.from([0, 0, 0, 0, 5, 10, 3, 102, 111, 111]);
  assert.deepEqual([...wire.stripGrpcFrame(framed).bytes], [10, 3, 102, 111, 111]);
  assert.throws(() => wire.decodeMessage(Buffer.from([10, 9, 1]), null), /runs past the end/);
  assert.throws(() => wire.decodeMessage(Buffer.from([7]), null), /Field number 0|Wire type 7/);
});

test('breaking: removed, renumbered, retyped fields, enum and rpc changes, by level', () => {
  const base = new Map([['api.proto', 'syntax = "proto3";\npackage s.v1;\nmessage O { string id = 1; int32 qty = 2; string note = 3; repeated string tags = 5; int64 total = 6; string gone = 8; }\nenum St { ST_UNSPECIFIED = 0; PAID = 1; SHIPPED = 2; }\nservice Svc { rpc Get(O) returns (O); rpc Gone(O) returns (O); }\n']]);
  const head = new Map([['api.proto', 'syntax = "proto3";\npackage s.v1;\nmessage O { reserved 8; string order_id = 1; int64 qty = 2; string note = 7; string tags = 5; string total = 6; }\nenum St { ST_UNSPECIFIED = 0; PAID_IN_FULL = 1; }\nservice Svc { rpc Get(O) returns (stream O); }\n']]);
  const r = breaking.compare(base, head);
  const rules = r.findings.map((f) => `${f.level}:${f.rule}`);
  for (const want of ['wire:FIELD_NUMBER_CHANGED', 'wire:FIELD_LABEL_CHANGED', 'wire:FIELD_TYPE_CHANGED', 'wire:RPC_SERVER_STREAMING_CHANGED', 'wire:RPC_REMOVED', 'json:FIELD_RENAMED', 'json:ENUM_VALUE_RENAMED', 'json:ENUM_VALUE_REMOVED', 'source:FIELD_TYPE_CHANGED', 'source:FIELD_REMOVED_RESERVED']) assert.ok(rules.includes(want), want);
  assert.deepEqual(r.counts, { wire: 5, json: 3, source: 2 });
  assert.match(breaking.markdown(r, { base: 'main' }), /\| Wire: old and new programs misread binary data, or calls fail \| 5 \|/);
  assert.deepEqual(breaking.compare(base, base).findings, []);
});

test('docs: Markdown and HTML with links between types and HTTP routes', () => {
  const { idx, f } = shopSchema();
  const files = [{ rel: 'shop/v1/shop.proto', ast: idx.get(f) }, { rel: 'common/money.proto', ast: idx.get(path.join('/ws', 'common/money.proto')) }];
  const resolve = (rel, t, scope) => { const r = idx.lookup(path.join('/ws', rel), t, scope); return r.def && r.def.file ? r.def.fullName : null; };
  const model = docs.collect(files, resolve);
  const md = docs.markdown(model, { title: 'Shop API', when: new Date('2026-11-12T00:00:00Z') });
  assert.match(md, /^# Shop API/);
  assert.match(md, /\| GetOrder \| \[GetOrderRequest\]\(#shop-v1-getorderrequest\) \| \[Order\]\(#shop-v1-order\) \| Returns one order\. \|/);
  assert.match(md, /\| WatchOrders \| \[WatchOrdersRequest\]\(#shop-v1-watchordersrequest\) \| stream \[Order\]\(#shop-v1-order\) \|/);
  assert.match(md, /\| total \| 6 \| \[shop\.common\.Money\]\(#shop-common-money\) \|/);
  assert.match(md, /\| currency_code \| 1 \| `string` \| {2}\| ISO 4217 \|/);
  const html = docs.html(model, { title: 'Shop API' });
  assert.match(html, /<h3 id="shop-v1-order">Order<\/h3>/);
  assert.ok(!/<script/i.test(html));
  assert.equal(docs.httpRoute({ options: [{ name: '(google.api.http)', value: { kind: 'aggregate', text: '{ get: "/v1/{name=orders/*}" }' } }] }), 'GET /v1/{name=orders/*}');
});

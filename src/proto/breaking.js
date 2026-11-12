'use strict';
// Breaking-change check between two versions of a set of .proto files (for example git main and the working tree).
// Three levels:
//   wire   - old and new programs misread each other's binary data, or a gRPC call fails
//   json   - the binary format still works, but JSON (and text format) payloads break
//   source - the data stays compatible, but code generated from the old file no longer compiles
// Pure JavaScript; the files come from the caller (git show, disk).

const path = require('path');
const { createIndex } = require('./index');
const { optionValue, SCALARS } = require('./parser');

const WIRE_GROUPS = [
  ['int32', 'uint32', 'int64', 'uint64', 'bool', 'enum'],
  ['sint32', 'sint64'],
  ['fixed32', 'sfixed32'],
  ['fixed64', 'sfixed64'],
  ['string', 'bytes'],
];
const groupOf = (t) => WIRE_GROUPS.findIndex((g) => g.includes(t));

/** files: Map(relPath -> text). Builds a model of every type, field, enum value and method, by full name. */
function model(files, label) {
  const root = path.join(path.sep, `__${label}__`);
  const idx = createIndex({ readFile: () => null, fileExists: () => false, roots: () => [root], importPaths: () => [] });
  for (const [rel, text] of files) idx.set(path.join(root, rel), text);
  const types = new Map();
  const services = new Map();
  const filePkg = new Map();
  const relOf = (f) => path.relative(root, f).split(path.sep).join('/');
  for (const f of idx.allFiles()) {
    const a = idx.get(f);
    const rel = relOf(f);
    filePkg.set(rel, { pkg: a.package || '', syntax: a.syntax || 'proto2', defs: a.defs.length });
    const typeName = (field, scope) => {
      const t = field.map ? field.map.value : field.type;
      if (SCALARS.has(t)) return { name: t, kind: t };
      const r = idx.lookup(f, t, scope);
      if (r.def) return { name: r.def.fullName, kind: r.def.kind };
      return { name: t.replace(/^\./, ''), kind: 'unknown' };
    };
    const walk = (m) => {
      const fields = new Map();
      for (const fd of m.fields) {
        const tn = typeName(fd, m.fullName);
        fields.set(fd.number, {
          name: fd.name, number: fd.number, type: fd.map ? `map<${fd.map.key}, ${tn.name}>` : tn.name, kind: fd.map ? 'map' : tn.kind,
          label: fd.map ? 'repeated' : fd.label || (a.syntax === 'proto3' ? 'implicit' : 'optional'),
          oneof: fd.oneof, jsonName: optionValue(fd.options, 'json_name'), dflt: optionValue(fd.options, 'default'), line: fd.nameRange.line,
        });
      }
      types.set(m.fullName, {
        kind: 'message', file: rel, name: m.name, rel: m.fullName.slice((a.package ? a.package.length + 1 : 0)), line: m.nameRange.line, fields,
        reserved: m.reserved.ranges.map((r) => [r.lo, r.hi]), reservedNames: new Set(m.reserved.names.map((n) => n.name)),
      });
      for (const c of m.messages) walk(c);
      for (const e of m.enums) walkEnum(e);
    };
    const walkEnum = (e) => {
      const values = new Map();
      for (const v of e.values) if (!values.has(v.number)) values.set(v.number, { name: v.name, number: v.number, line: v.nameRange.line });
      const names = new Map(e.values.map((v) => [v.name, v.number]));
      types.set(e.fullName, {
        kind: 'enum', file: rel, name: e.name, rel: e.fullName.slice((a.package ? a.package.length + 1 : 0)), line: e.nameRange.line, values, names,
        reserved: e.reserved.ranges.map((r) => [r.lo, r.hi]), reservedNames: new Set(e.reserved.names.map((n) => n.name)),
      });
    };
    for (const m of a.messages) walk(m);
    for (const e of a.enums) walkEnum(e);
    for (const s of a.services) {
      const rpcs = new Map();
      for (const r of s.rpcs) {
        const it = idx.lookup(f, r.input, s.fullName);
        const ot = idx.lookup(f, r.output, s.fullName);
        rpcs.set(r.name, { name: r.name, input: it.def ? it.def.fullName : r.input, output: ot.def ? ot.def.fullName : r.output, inStream: r.inputStream, outStream: r.outputStream, line: r.nameRange.line });
      }
      services.set(s.fullName, { file: rel, name: s.name, rel: s.name, line: s.nameRange.line, rpcs });
    }
  }
  return { types, services, filePkg };
}

const labelText = (l) => (l === 'implicit' ? 'singular' : l);
const inRanges = (n, rs) => rs.some(([lo, hi]) => n >= lo && n <= hi);

/**
 * @param {Map<string,string>} baseFiles relPath -> text (the old version)
 * @param {Map<string,string>} headFiles relPath -> text (the new version)
 * @returns {{ findings: Array<{ level, rule, message, file, line, type }>, counts }}
 */
function compare(baseFiles, headFiles) {
  const B = model(baseFiles, 'base');
  const H = model(headFiles, 'head');
  const findings = [];
  const add = (level, rule, message, file, line, type) => findings.push({ level, rule, message, file, line: line == null ? null : line + 1, type: type || null });

  // files and packages
  for (const [rel, info] of B.filePkg) {
    const h = H.filePkg.get(rel);
    if (!h) { if (info.defs) add('source', 'FILE_REMOVED', `The file ${rel} was removed (or moved). Code that imports it no longer compiles.`, rel, null); continue; }
    if (h.pkg !== info.pkg) add('wire', 'PACKAGE_CHANGED', `The package changed from "${info.pkg}" to "${h.pkg}". Full type names, Any type URLs and gRPC method paths all change.`, rel, 0);
  }
  // find the head version of a base type: same full name, or the same name in the same file after a package change
  const headType = (full, t) => H.types.get(full) || [...H.types.values()].find((x) => x.file === t.file && x.rel === t.rel && x.kind === t.kind && B.filePkg.get(t.file) && H.filePkg.get(t.file) && B.filePkg.get(t.file).pkg !== H.filePkg.get(t.file).pkg);
  const headSvc = (full, s) => H.services.get(full) || [...H.services.values()].find((x) => x.file === s.file && x.name === s.name && B.filePkg.get(s.file) && H.filePkg.get(s.file) && B.filePkg.get(s.file).pkg !== H.filePkg.get(s.file).pkg);
  for (const [full, bt] of B.types) {
    const ht = headType(full, bt);
    if (!ht) { add('source', bt.kind === 'message' ? 'MESSAGE_REMOVED' : 'ENUM_REMOVED', `${bt.kind === 'message' ? 'Message' : 'Enum'} "${full}" was removed.`, bt.file, bt.line, full); continue; }
    if (ht.kind !== bt.kind) { add('wire', 'TYPE_KIND_CHANGED', `"${full}" changed from ${bt.kind} to ${ht.kind}.`, ht.file, ht.line, full); continue; }
    if (bt.kind === 'message') {
      const byName = new Map([...ht.fields.values()].map((f) => [f.name, f]));
      for (const [no, bf] of bt.fields) {
        const hf = ht.fields.get(no);
        if (!hf) {
          const moved = byName.get(bf.name);
          if (moved && !bt.fields.has(moved.number)) add('wire', 'FIELD_NUMBER_CHANGED', `Field "${bf.name}" in "${full}" changed number from ${no} to ${moved.number}. Old data puts its value in the wrong field.`, ht.file, moved.line, full);
          else if (inRanges(no, ht.reserved)) add('source', 'FIELD_REMOVED_RESERVED', `Field "${bf.name}" (${no}) was removed from "${full}". Its number is reserved, so the wire stays safe; generated code that used it no longer compiles.`, ht.file, ht.line, full);
          else add('wire', 'FIELD_REMOVED', `Field "${bf.name}" (${no}) was removed from "${full}" without reserving ${no}. A later field can reuse the number with another type. Add "reserved ${no};" and "reserved "${bf.name}";".`, ht.file, ht.line, full);
          continue;
        }
        if (hf.name !== bf.name) add('json', 'FIELD_RENAMED', `Field ${no} in "${full}" was renamed from "${bf.name}" to "${hf.name}". Binary data still works; JSON and text format payloads and generated code break.`, ht.file, hf.line, full);
        if (hf.type !== bf.type) {
          const gb = groupOf(bf.kind === 'enum' ? 'enum' : bf.type);
          const gh = groupOf(hf.kind === 'enum' ? 'enum' : hf.type);
          const compatible = (gb >= 0 && gb === gh) || (bf.kind === 'message' && hf.type === 'bytes') || (bf.type === 'bytes' && hf.kind === 'message');
          add(compatible ? 'source' : 'wire', 'FIELD_TYPE_CHANGED', `Field "${hf.name}" (${no}) in "${full}" changed type from ${bf.type} to ${hf.type}.${compatible ? ' The two types share a wire encoding, so old data still decodes (values can be cut or change sign).' : ' Old and new programs read this field differently.'}`, ht.file, hf.line, full);
        }
        if (hf.label !== bf.label) {
          const rep = (l) => l === 'repeated';
          let level = 'source';
          if (rep(hf.label) !== rep(bf.label)) level = 'wire';
          if (hf.label === 'required' || bf.label === 'required') level = 'wire';
          add(level, 'FIELD_LABEL_CHANGED', `Field "${hf.name}" (${no}) in "${full}" changed from ${labelText(bf.label)} to ${labelText(hf.label)}.`, ht.file, hf.line, full);
        }
        if ((hf.oneof || null) !== (bf.oneof || null)) {
          add(hf.oneof && [...ht.fields.values()].filter((x) => x.oneof === hf.oneof).length > 1 ? 'wire' : 'source', 'FIELD_ONEOF_CHANGED', `Field "${hf.name}" (${no}) in "${full}" moved ${hf.oneof ? `into oneof "${hf.oneof}"` : `out of oneof "${bf.oneof}"`}.`, ht.file, hf.line, full);
        }
        if ((hf.jsonName || null) !== (bf.jsonName || null)) add('json', 'FIELD_JSON_NAME_CHANGED', `Field "${hf.name}" (${no}) in "${full}" changed json_name from ${bf.jsonName || '(default)'} to ${hf.jsonName || '(default)'}.`, ht.file, hf.line, full);
        if (String(hf.dflt) !== String(bf.dflt)) add('wire', 'FIELD_DEFAULT_CHANGED', `Field "${hf.name}" (${no}) in "${full}" changed its default from ${bf.dflt === undefined ? '(none)' : bf.dflt} to ${hf.dflt === undefined ? '(none)' : hf.dflt}. Old and new programs read a missing value differently.`, ht.file, hf.line, full);
      }
      for (const [no, hf] of ht.fields) {
        if (!bt.fields.has(no) && inRanges(no, bt.reserved)) add('wire', 'RESERVED_NUMBER_REUSED', `Field "${hf.name}" in "${full}" uses number ${no}, which the old version reserved.`, ht.file, hf.line, full);
        if (!bt.fields.has(no) && bt.reservedNames.has(hf.name)) add('json', 'RESERVED_NAME_REUSED', `Field "${hf.name}" in "${full}" uses a name the old version reserved.`, ht.file, hf.line, full);
        if (!bt.fields.has(no) && hf.label === 'required') add('wire', 'REQUIRED_FIELD_ADDED', `Field "${hf.name}" (${no}) in "${full}" is new and required. Old programs never send it, so new programs reject their messages.`, ht.file, hf.line, full);
      }
    } else {
      for (const [no, bv] of bt.values) {
        const hv = ht.values.get(no);
        if (!hv) {
          const renum = ht.names.get(bv.name);
          if (renum !== undefined) add('wire', 'ENUM_VALUE_NUMBER_CHANGED', `Enum value "${bv.name}" in "${full}" changed number from ${no} to ${renum}.`, ht.file, ht.line, full);
          else if (inRanges(no, ht.reserved)) add('source', 'ENUM_VALUE_REMOVED_RESERVED', `Enum value "${bv.name}" (${no}) was removed from "${full}"; its number is reserved.`, ht.file, ht.line, full);
          else add('json', 'ENUM_VALUE_REMOVED', `Enum value "${bv.name}" (${no}) was removed from "${full}" without reserving ${no}. JSON payloads with "${bv.name}" fail to parse. Add "reserved ${no};".`, ht.file, ht.line, full);
          continue;
        }
        if (hv.name !== bv.name && !ht.names.has(bv.name)) add('json', 'ENUM_VALUE_RENAMED', `Enum value ${no} in "${full}" was renamed from "${bv.name}" to "${hv.name}". JSON payloads with the old name fail to parse.`, ht.file, hv.line, full);
      }
      for (const [no, hv] of ht.values) if (!bt.values.has(no) && inRanges(no, bt.reserved)) add('wire', 'RESERVED_NUMBER_REUSED', `Enum value "${hv.name}" in "${full}" uses number ${no}, which the old version reserved.`, ht.file, hv.line, full);
    }
  }

  for (const [full, bs] of B.services) {
    const hs = headSvc(full, bs);
    if (!hs) { add('wire', 'SERVICE_REMOVED', `Service "${full}" was removed. Clients that call it get UNIMPLEMENTED.`, bs.file, bs.line, full); continue; }
    for (const [name, br] of bs.rpcs) {
      const hr = hs.rpcs.get(name);
      if (!hr) { add('wire', 'RPC_REMOVED', `Method "${full}.${name}" was removed. Clients that call it get UNIMPLEMENTED.`, hs.file, hs.line, full); continue; }
      if (hr.input !== br.input) add('wire', 'RPC_REQUEST_CHANGED', `Method "${full}.${name}" changed its request from ${br.input} to ${hr.input}.`, hs.file, hr.line, full);
      if (hr.output !== br.output) add('wire', 'RPC_RESPONSE_CHANGED', `Method "${full}.${name}" changed its response from ${br.output} to ${hr.output}.`, hs.file, hr.line, full);
      if (hr.inStream !== br.inStream) add('wire', 'RPC_CLIENT_STREAMING_CHANGED', `Method "${full}.${name}" ${hr.inStream ? 'now streams' : 'no longer streams'} its requests.`, hs.file, hr.line, full);
      if (hr.outStream !== br.outStream) add('wire', 'RPC_SERVER_STREAMING_CHANGED', `Method "${full}.${name}" ${hr.outStream ? 'now streams' : 'no longer streams'} its responses.`, hs.file, hr.line, full);
    }
  }
  const order = { wire: 0, json: 1, source: 2 };
  findings.sort((x, y) => order[x.level] - order[y.level] || String(x.file).localeCompare(String(y.file)) || (x.line || 0) - (y.line || 0));
  const counts = { wire: 0, json: 0, source: 0 };
  for (const f of findings) counts[f.level]++;
  return { findings, counts, baseFiles: baseFiles.size, headFiles: headFiles.size };
}

const LEVEL_TEXT = {
  wire: 'Wire: old and new programs misread binary data, or calls fail',
  json: 'JSON: binary data still works, JSON and text payloads break',
  source: 'Source: data stays compatible, generated code no longer compiles',
};

function markdown(result, { title = 'Protobuf breaking-change check', base = 'base', head = 'working tree', when = new Date() } = {}) {
  const L = [];
  L.push(`# ${title}`, '');
  L.push(`Compared ${result.headFiles} .proto file(s) in the ${head} with ${result.baseFiles} in ${base}. ${when.toISOString().slice(0, 16).replace('T', ' ')} UTC.`, '');
  const total = result.findings.length;
  if (!total) { L.push('No breaking changes found.', ''); return L.join('\n'); }
  L.push('| Level | Count |', '| --- | --- |');
  for (const k of ['wire', 'json', 'source']) L.push(`| ${LEVEL_TEXT[k]} | ${result.counts[k]} |`);
  L.push('');
  const byFile = new Map();
  for (const f of result.findings) { const k = f.file || '(workspace)'; if (!byFile.has(k)) byFile.set(k, []); byFile.get(k).push(f); }
  for (const [file, list] of byFile) {
    L.push(`## ${file}`, '');
    for (const f of list) L.push(`- **${f.level}**${f.line ? ` line ${f.line}` : ''} (${f.rule}): ${f.message}`);
    L.push('');
  }
  return L.join('\n');
}

module.exports = { compare, markdown, model };

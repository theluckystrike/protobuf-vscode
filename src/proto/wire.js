'use strict';
// Protobuf binary (wire format) decoder, written for this extension from the encoding spec. Decodes with a message
// type from the user's .proto files (field names, enums, maps, packed fields, nested messages, groups) or without a
// schema (field numbers and best guesses). Pure JavaScript; it reads only the bytes it is given.

const INT64 = new Set(['int64', 'uint64', 'sint64', 'fixed64', 'sfixed64']);
const VARINT_T = new Set(['int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64', 'bool', 'enum']);
const F32_T = new Set(['fixed32', 'sfixed32', 'float']);
const F64_T = new Set(['fixed64', 'sfixed64', 'double']);
const WT_NAMES = ['varint', 'i64', 'len', 'sgroup', 'egroup', 'i32'];

class Reader {
  constructor(buf, start = 0, end = buf.length) { this.b = buf; this.p = start; this.end = end; }
  eof() { return this.p >= this.end; }
  varint() {
    let r = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.p >= this.end) throw new Error(`The data ends inside a varint at byte ${this.p}.`);
      const c = this.b[this.p++];
      r |= BigInt(c & 0x7f) << shift;
      if (!(c & 0x80)) return r;
      shift += 7n;
    }
    throw new Error(`A varint longer than 10 bytes at byte ${this.p - 10}.`);
  }
  bytes(n) {
    if (n < 0 || this.p + n > this.end) throw new Error(`A length of ${n} bytes at byte ${this.p} runs past the end of the data (${this.end - this.p} bytes left).`);
    const s = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return s;
  }
}

const num = (big) => (big <= BigInt(Number.MAX_SAFE_INTEGER) && big >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big.toString());
const s32 = (big) => Number(BigInt.asIntN(32, big));
const u32 = (big) => Number(BigInt.asUintN(32, big));
const zig = (big) => (big >> 1n) ^ -(big & 1n);

function scalarFromVarint(type, v) {
  switch (type) {
    case 'int32': return s32(v);
    case 'uint32': return u32(v);
    case 'int64': return num(BigInt.asIntN(64, v));
    case 'uint64': return num(BigInt.asUintN(64, v));
    case 'sint32': return Number(BigInt.asIntN(32, zig(BigInt.asUintN(32, v))));
    case 'sint64': return num(BigInt.asIntN(64, zig(BigInt.asUintN(64, v))));
    case 'bool': return v !== 0n;
    case 'enum': return s32(v);
    default: return num(v);
  }
}
function scalarFrom32(type, bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, 4);
  if (type === 'float') return niceFloat(dv.getFloat32(0, true));
  if (type === 'sfixed32') return dv.getInt32(0, true);
  return dv.getUint32(0, true);
}
function scalarFrom64(type, bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, 8);
  if (type === 'double') return niceFloat(dv.getFloat64(0, true));
  if (type === 'sfixed64') return num(dv.getBigInt64(0, true));
  return num(dv.getBigUint64(0, true));
}
function niceFloat(x) {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  return Number.isInteger(x) ? x : Number(x.toPrecision(9)) === Number(x.toPrecision(17)) ? Number(x.toPrecision(9)) : x;
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
function utf8OrNull(bytes) {
  const s = Buffer.from(bytes).toString('utf8');
  if (s.includes('�')) return null;
  // printable text only (tabs and line breaks allowed)
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) return null;
  return s;
}

/**
 * Decode one message.
 * schema: { message: node, resolve(field, message) -> { kind: 'message'|'enum', node } | null } or null (no schema).
 */
function decodeMessage(buf, schema, opts = {}, depth = 0, endGroup = null) {
  if (depth > (opts.maxDepth || 64)) throw new Error('Messages are nested more than 64 levels deep.');
  const r = buf instanceof Reader ? buf : new Reader(buf);
  const out = {};
  const msg = schema && schema.message;
  const byNum = new Map();
  const multi = new Set(); // unknown field numbers seen more than once (shown as a list)
  if (msg) for (const f of msg.fields) byNum.set(f.number, f);
  const push = (key, value, repeated) => {
    if (repeated) { (out[key] = out[key] || []).push(value); return; }
    if (key in out) { // a singular field seen twice: the last one wins on the wire; keep both for the reader
      out[key] = value;
      return;
    }
    out[key] = value;
  };
  while (!r.eof()) {
    const at = r.p;
    const tag = r.varint();
    const fieldNo = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    if (fieldNo === 0) throw new Error(`Field number 0 at byte ${at}: this is not a protobuf message (or it starts at another byte).`);
    if (wt === 4) {
      if (endGroup === fieldNo) return out;
      throw new Error(`An end-group tag for field ${fieldNo} at byte ${at} without a start.`);
    }
    if (wt > 5) throw new Error(`Wire type ${wt} at byte ${at} does not exist: this is not a protobuf message (or it starts at another byte).`);
    const f = byNum.get(fieldNo);
    const d = f && schema ? schema.resolve(f, msg) : null;
    const ftype = f ? (f.map ? 'map' : d ? d.kind : f.type) : null;
    const expectWt = !f ? null : f.map || ftype === 'message' && !f.group || ftype === 'string' || ftype === 'bytes' ? 2 : f.group ? 3 : VARINT_T.has(ftype) ? 0 : F32_T.has(ftype) ? 5 : F64_T.has(ftype) ? 1 : null;
    const repeated = f && (f.label === 'repeated' || !!f.map);
    // packed repeated scalars come as one length-delimited field
    if (f && repeated && wt === 2 && expectWt !== 2 && expectWt !== 3 && expectWt !== null) {
      const body = r.bytes(Number(r.varint()));
      const pr = new Reader(body);
      while (!pr.eof()) {
        if (expectWt === 0) push(f.name, enumOr(d, scalarFromVarint(ftype, pr.varint())), true);
        else if (expectWt === 5) push(f.name, scalarFrom32(ftype, pr.bytes(4)), true);
        else push(f.name, scalarFrom64(ftype, pr.bytes(8)), true);
      }
      continue;
    }
    // a message field can come length-delimited or, with features.message_encoding = DELIMITED or a proto2 group, as a group
    const okWt = expectWt !== null && (wt === expectWt || (ftype === 'message' && !f.map && (wt === 2 || wt === 3)));
    if (f && okWt) {
      let value;
      if (wt === 0) value = enumOr(d, scalarFromVarint(ftype, r.varint()));
      else if (wt === 5) value = scalarFrom32(ftype, r.bytes(4));
      else if (wt === 1) value = scalarFrom64(ftype, r.bytes(8));
      else if (wt === 3) value = decodeMessage(r, d ? { message: d.node, resolve: schema.resolve } : null, opts, depth + 1, fieldNo);
      else {
        const body = r.bytes(Number(r.varint()));
        if (f.map) {
          const entry = decodeMapEntry(body, f, msg, schema, opts, depth);
          out[f.name] = out[f.name] || {};
          out[f.name][String(entry.key)] = entry.value;
          continue;
        }
        if (ftype === 'string') value = Buffer.from(body).toString('utf8');
        else if (ftype === 'bytes') value = b64(body);
        else value = decodeMessage(body, d ? { message: d.node, resolve: schema.resolve } : null, opts, depth + 1);
      }
      push(f.name, value, repeated);
      continue;
    }
    // unknown field (not in the schema, or a wire type that does not match it)
    const key = f ? `${f.name} (#${fieldNo}, unexpected ${WT_NAMES[wt]})` : `#${fieldNo}`;
    const rv = rawValue(r, wt, fieldNo, opts, depth);
    if (!(key in out)) out[key] = rv;
    else if (multi.has(key)) out[key].push(rv);
    else { out[key] = [out[key], rv]; multi.add(key); }
  }
  if (endGroup !== null) throw new Error(`Group ${endGroup} is not closed before the end of the data.`);
  return out;
}

function enumOr(d, v) {
  if (!d || d.kind !== 'enum') return v;
  const ev = d.node.values.find((x) => x.number === v);
  return ev ? ev.name : v;
}

function decodeMapEntry(body, f, msg, schema, opts, depth) {
  const keyField = { name: 'key', number: 1, type: f.map.key, label: null };
  const valField = { name: 'value', number: 2, type: f.map.value, label: null };
  const entryMsg = { fields: [keyField, valField], fullName: msg && msg.fullName };
  const resolve = (ff, m) => (m === entryMsg ? (ff === valField ? schema.resolve(valField, msg) : null) : schema.resolve(ff, m));
  const o = decodeMessage(body, { message: entryMsg, resolve }, opts, depth + 1);
  return { key: o.key !== undefined ? o.key : defaultFor(f.map.key), value: o.value !== undefined ? o.value : null };
}
function defaultFor(t) { return t === 'string' ? '' : t === 'bool' ? false : 0; }

function rawValue(r, wt, fieldNo, opts, depth) {
  if (wt === 0) { const v = r.varint(); return num(BigInt.asUintN(64, v)); }
  if (wt === 1) { const b = r.bytes(8); return { fixed64: scalarFrom64('fixed64', b), double: scalarFrom64('double', b) }; }
  if (wt === 5) { const b = r.bytes(4); return { fixed32: scalarFrom32('fixed32', b), float: scalarFrom32('float', b) }; }
  if (wt === 3) return decodeMessage(r, null, opts, depth + 1, fieldNo);
  const body = r.bytes(Number(r.varint()));
  if (!body.length) return '';
  // a nested message, a string, or plain bytes: try them in that order
  if (depth < 20) {
    try {
      const m = decodeMessage(body, null, opts, depth + 1);
      if (Object.keys(m).length) {
        const text = utf8OrNull(body);
        if (!(text && /^[\x20-\x7e\s]+$/.test(text) && text.length > 2)) return m;
      }
    } catch { /* not a message */ }
  }
  const text = utf8OrNull(body);
  if (text !== null) return text;
  return { bytes: b64(body) };
}

/** Bytes from text: hex (spaces, colons, 0x allowed), base64 or base64url. Returns { bytes, format } or throws. */
function bytesFromText(text) {
  const t = String(text).trim();
  if (!t) throw new Error('The text is empty.');
  const hex = t.replace(/0x/gi, '').replace(/[\s:,\-]/g, '');
  if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0 && (/[\s:]/.test(t) || /^[0-9a-fA-F]+$/.test(t) && !/[g-zG-Z+/=]/.test(t))) {
    return { bytes: Buffer.from(hex, 'hex'), format: 'hex' };
  }
  const b = t.replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(b)) return { bytes: Buffer.from(b.replace(/-/g, '+').replace(/_/g, '/'), 'base64'), format: 'base64' };
  throw new Error('The text is neither hex nor base64.');
}

/** gRPC message frame (1 byte compressed flag + 4 byte big-endian length + message)? Returns the inner bytes or null. */
function stripGrpcFrame(bytes) {
  if (bytes.length >= 5 && (bytes[0] === 0 || bytes[0] === 1)) {
    const n = (bytes[1] << 24 >>> 0) + (bytes[2] << 16) + (bytes[3] << 8) + bytes[4];
    if (n === bytes.length - 5) return { bytes: bytes.subarray(5), compressed: bytes[0] === 1 };
  }
  return null;
}

module.exports = { decodeMessage, bytesFromText, stripGrpcFrame, Reader };

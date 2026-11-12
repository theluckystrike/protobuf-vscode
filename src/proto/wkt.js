'use strict';
// The well-known types that ship with protoc (google/protobuf/*.proto). When a workspace has no copy of these files,
// the names below count as defined, so "import "google/protobuf/timestamp.proto";" never shows a false error.
// Only names are listed here (no file contents). descriptor.proto is large and changes between protoc releases, so
// any google.protobuf.* name counts as defined when it is imported.

const M = 'message';
const E = 'enum';
// Fields of the small well-known messages, so hover and the binary decoder know them: [name, type, number, label]
const FIELDS = {
  Any: [['type_url', 'string', 1], ['value', 'bytes', 2]],
  Duration: [['seconds', 'int64', 1], ['nanos', 'int32', 2]],
  Timestamp: [['seconds', 'int64', 1], ['nanos', 'int32', 2]],
  FieldMask: [['paths', 'string', 1, 'repeated']],
  Empty: [],
  DoubleValue: [['value', 'double', 1]], FloatValue: [['value', 'float', 1]], Int64Value: [['value', 'int64', 1]], UInt64Value: [['value', 'uint64', 1]],
  Int32Value: [['value', 'int32', 1]], UInt32Value: [['value', 'uint32', 1]], BoolValue: [['value', 'bool', 1]], StringValue: [['value', 'string', 1]], BytesValue: [['value', 'bytes', 1]],
};

const WKT = {
  'google/protobuf/any.proto': [['Any', M]],
  'google/protobuf/api.proto': [['Api', M], ['Method', M], ['Mixin', M]],
  'google/protobuf/duration.proto': [['Duration', M]],
  'google/protobuf/empty.proto': [['Empty', M]],
  'google/protobuf/field_mask.proto': [['FieldMask', M]],
  'google/protobuf/source_context.proto': [['SourceContext', M]],
  'google/protobuf/struct.proto': [['Struct', M], ['Value', M], ['ListValue', M], ['NullValue', E]],
  'google/protobuf/timestamp.proto': [['Timestamp', M]],
  'google/protobuf/type.proto': [['Type', M], ['Field', M], ['Field.Kind', E], ['Field.Cardinality', E], ['Enum', M], ['EnumValue', M], ['Option', M], ['Syntax', E]],
  'google/protobuf/wrappers.proto': [['DoubleValue', M], ['FloatValue', M], ['Int64Value', M], ['UInt64Value', M], ['Int32Value', M], ['UInt32Value', M], ['BoolValue', M], ['StringValue', M], ['BytesValue', M]],
  'google/protobuf/descriptor.proto': '*',
  'google/protobuf/cpp_features.proto': '*',
  'google/protobuf/java_features.proto': '*',
  'google/protobuf/go_features.proto': '*',
};

/** A pseudo parsed file for a well-known import, or null. */
function builtinFile(importPath) {
  const list = WKT[importPath];
  if (!list) return null;
  const node = (n, kind) => {
    const x = { kind, name: n.split('.').pop(), fullName: `google.protobuf.${n}`, fields: [], messages: [], enums: [], values: [] };
    for (const [name, type, number, label] of FIELDS[n] || []) x.fields.push({ kind: 'field', name, type, number, label: label || null, options: [] });
    return x;
  };
  const defs = list === '*' ? [] : list.map(([n, kind]) => ({ fullName: `google.protobuf.${n}`, kind, node: node(n, kind) }));
  const pkg = /_features\.proto$/.test(importPath) ? 'pb' : 'google.protobuf';
  return { builtin: true, path: importPath, package: pkg, wildcard: list === '*', defs, imports: [], refs: [], optionRefs: [], errors: [], messages: [], enums: [], services: [], extends: [] };
}

module.exports = { WKT, builtinFile };

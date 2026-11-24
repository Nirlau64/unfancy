// Safe projection of a live Worker Settings API readback.
// Returns ONLY value-free fields: bindings inventories (names, types, resource ids) and
// the full safe-settings objects (compatibility_flags, tags, logpush, tail_consumers,
// placement, usage_model, observability) — these contain no binding values, so they are
// projected IN FULL for the safe-settings preservation pin. We throw when a binding
// carries a value field (`text`/`value`) — value fields never enter a projection, a log
// or a file.
const SAFE_BINDING_ID_FIELDS = ['namespace_id', 'id', 'class_name', 'queue_name', 'service', 'dataset', 'bucket_name', 'index_name', 'certificate_id'];
const SAFE_BINDING_VALUE_FIELDS = ['text', 'value'];
const SAFE_SETTINGS_FIELDS = [
  'compatibility_date', 'compatibility_flags', 'placement', 'usage_model',
  'tags', 'tail_consumers', 'logpush', 'observability',
];

export function projectSettings(responseJson) {
  const result = responseJson?.result;
  if (!result || typeof result !== 'object') throw new Error('unexpected settings response: missing result');
  const bindings = (result.bindings ?? []).map((b) => {
    if (!b || typeof b !== 'object') throw new Error('unexpected binding entry');
    const out = { name: b.name, type: b.type };
    for (const idField of SAFE_BINDING_ID_FIELDS) {
      if (b[idField] !== undefined) out[idField] = b[idField];
    }
    for (const valueField of SAFE_BINDING_VALUE_FIELDS) {
      if (valueField in b) {
        throw new Error(
          `refusing to project binding "${b.name}": contains a value field "${valueField}" — remove value fields from any payload/transport`
        );
      }
    }
    return out;
  });
  const out = { bindings };
  for (const field of SAFE_SETTINGS_FIELDS) {
    if (result[field] !== undefined) out[field] = JSON.parse(JSON.stringify(result[field]));
  }
  return out;
}

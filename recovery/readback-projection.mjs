// Safe projection of a live Worker Settings API readback.
// Returns ONLY inventory fields (names, types, resource ids). Never value fields.
export function projectSettings(responseJson) {
  const result = responseJson?.result;
  if (!result || typeof result !== 'object') throw new Error('unexpected settings response: missing result');
  const bindings = (result.bindings ?? []).map((b) => {
    if (!b || typeof b !== 'object') throw new Error('unexpected binding entry');
    const out = { name: b.name, type: b.type };
    for (const idField of ['namespace_id', 'id', 'class_name', 'queue_name', 'service', 'dataset', 'bucket_name', 'index_name', 'certificate_id']) {
      if (b[idField] !== undefined) out[idField] = b[idField];
    }
    for (const valueField of ['text', 'value']) {
      if (valueField in b) {
        throw new Error(
          `refusing to project binding "${b.name}": contains a value field "${valueField}" — remove value fields from any payload/transport`
        );
      }
    }
    return out;
  });
  return {
    compatibility_date: result.compatibility_date ?? null,
    compatibility_flags: result.compatibility_flags ?? [],
    bindings,
    // Redaction-relevant observability fields are safe to project; everything else dropped.
    observability: result.observability
      ? {
          enabled: result.observability.enabled,
          head_sampling_rate: result.observability.head_sampling_rate,
          redact_query_string: result.observability.redact_query_string,
        }
      : null,
  };
}

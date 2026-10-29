/** JSON with object keys sorted at every depth, so two values that differ only
 * in key insertion order (for example a schema-parsed record and the object it
 * was built from) serialize identically. Arrays keep their order. */
export function stableJson(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

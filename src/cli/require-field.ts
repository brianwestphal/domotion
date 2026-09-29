/**
 * Narrow a value that config validation guarantees is present, failing with a named
 * error instead of a bare non-null assertion if that guarantee ever slips (a schema
 * edit, a hand-built config that bypassed parsing).
 */
export function requireField<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`${label} is required but missing (config validation was bypassed?)`);
  return value;
}

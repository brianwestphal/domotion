/** Shared numeric and shard validation for conformance CLIs and visual shards. */

export interface ShardSpec {
  index: number; // 1-indexed
  total: number;
}

/** Parse a `"<i>/<N>"` shard spec; null for empty/undefined (no sharding). */
export function parseShardSpec(spec: string | undefined | null): ShardSpec | null {
  if (spec == null || spec.trim() === "") return null;
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(spec.trim());
  if (m == null) {
    throw new Error(`Invalid shard spec ${JSON.stringify(spec)} — expected "i/N" (1-indexed), e.g. "2/5".`);
  }
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || total < 1 || index < 1 || index > total) {
    throw new Error(`Shard spec ${JSON.stringify(spec)} out of range — need 1 <= i <= N and N >= 1.`);
  }
  return { index, total };
}

/** Keep only the items belonging to the given shard (stride/round-robin). */
export function selectShard<T>(items: readonly T[], spec: string | undefined | null): T[] {
  const parsed = parseShardSpec(spec);
  if (parsed == null || parsed.total === 1) return [...items];
  const { index, total } = parsed;
  return items.filter((_, idx) => (idx % total) + 1 === index);
}

/** Reject partial, non-finite, unsafe, and out-of-domain integer flags. */
export function intFlag(name: string, raw: string, minimum = 1): number {
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw new Error(`${name} needs an integer >= ${minimum}, got ${raw}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} needs an integer >= ${minimum}, got ${raw}`);
  }
  return value;
}

/** Accept finite real values only, including zero where a caller permits it. */
export function finiteFlag(name: string, raw: string, minimum = 0): number {
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} needs a finite number >= ${minimum}, got ${raw}`);
  }
  return value;
}

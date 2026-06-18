// DM-1216: shard-by-index selection for the visual-regression harness, so the
// suite can be fanned out across independent GitHub Actions jobs (each job runs
// one shard). Used by `tests/html-test-suite.tsx`; unit-tested in
// `tests/shard.test.ts`.
//
// We slice by STRIDE (round-robin), not contiguous chunks: per-fixture cost
// varies wildly (a clean CJK ideograph block finishes in ~1 fixture-time while a
// complex-shaper block is many times slower), and a contiguous split would pile
// the slow neighbours into one shard. Stride interleaves them so every shard
// gets a balanced mix and the shards finish at roughly the same wall-clock.
//
// `spec` is 1-indexed `"<i>/<N>"` (e.g. "2/5" = the 2nd of 5 shards). Empty /
// undefined / "1/1" means "no sharding — keep everything". Across all N shards
// the selections partition the input exactly: their union is the full list and
// they never overlap.

export interface ShardSpec {
  index: number; // 1-indexed
  total: number;
}

/** Parse a `"<i>/<N>"` shard spec; null for empty/undefined (no sharding). */
export function parseShardSpec(spec: string | undefined | null): ShardSpec | null {
  if (spec == null || spec.trim() === "") return null;
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(spec.trim());
  if (m == null) {
    throw new Error(`Invalid shard spec ${JSON.stringify(spec)} — expected "<i>/<N>" (1-indexed), e.g. "2/5".`);
  }
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (total < 1 || index < 1 || index > total) {
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

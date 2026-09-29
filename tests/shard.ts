// DM-1216: shard-by-index selection for the visual-regression harness, so the
// suite can be fanned out across independent GitHub Actions jobs (each job runs
// one shard). Used by `tests/html-test-suite.tsx`; unit-tested in
// `tests/shard.test.ts`.
//
// We slice by STRIDE (round-robin), not contiguous chunks: per-fixture cost
// varies wildly (a clean CJK ideograph block finishes in ~1 fixture-time while a
// complex-shaper block is many times slower), and a contiguous split would pile
// the slow neighbors into one shard. Stride interleaves them so every shard
// gets a balanced mix and the shards finish at roughly the same wall-clock.
//
// `spec` is 1-indexed `"<i>/<N>"` (e.g. "2/5" = the 2nd of 5 shards). Empty /
// undefined / "1/1" means "no sharding — keep everything". Across all N shards
// the selections partition the input exactly: their union is the full list and
// they never overlap.

export { parseShardSpec, selectShard, type ShardSpec } from "../tools/lib/conformance-args.js";

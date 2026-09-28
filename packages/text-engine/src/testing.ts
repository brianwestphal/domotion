/**
 * `@domotion/text-engine/testing` — hooks for the root repository's oracles and
 * fixture tooling: cache/registry introspection, deterministic resets, platform
 * overrides, and the synthetic-font builder. NOT a stable API; production code
 * must not import it (tests/conventions.test.ts enforces that for the root `src/`
 * tree). Tests of engine internals live in this workspace and import the modules
 * directly, so a hook belongs here only while a root tool or test still needs it.
 */
export { __skiaLastResortKeysForTest, _clusterFallbackCounters } from "./render/cluster-fallback.js";
export {
  __pickWebfontVariantMetaForTest,
  __resolveSystemFallbackKeyForCpForTest,
  __setWin32FamilyKeyResolverForTest,
  clearCharacterFallbackRendererScopesForTest,
} from "./render/font-resolution.js";
export { buildSfnt } from "./render/synth-test-fonts.js";

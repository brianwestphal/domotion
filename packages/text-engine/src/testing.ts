/**
 * `@domotion/text-engine/testing` — test and oracle hooks: cache/registry
 * introspection, deterministic resets, and platform overrides. NOT a stable API;
 * production code must not import it (tests/conventions.test.ts enforces that for
 * the root `src/` tree).
 */
export { __skiaLastResortKeysForTest, _clusterFallbackCounters } from "./render/cluster-fallback.js";
export {
  _builderEntryFieldNames,
  _builderEntryState,
  _builderInstanceKeys,
  _builderRegistrySize,
} from "./render/embedded-font-builder.js";
export {
  __pickLocalFontAliasVariantForTest,
  __pickWebfontVariantMetaForCodepointForTest,
  __pickWebfontVariantMetaForTest,
  __resolveFaceInfoForFileForTest,
  __resolveSystemFallbackKeyForCpForTest,
  __setWin32FamilyKeyResolverForTest,
  __systemFallbackKeyCacheSizeForTest,
  clearCharacterFallbackRendererScopesForTest,
} from "./render/font-resolution.js";
export { _clearHbFontCache } from "./render/harfbuzz-shaper.js";
export { withHostPlatform } from "./render/host-platform.js";

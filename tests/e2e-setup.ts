import { afterAll, afterEach, beforeEach } from "vitest";
import {
  clearGlyphHelperCache,
  getSystemFallbackResolution,
  getSessionGenericFamilyOverrides,
  hostPlatformIsOverridden,
  setSessionGenericFamilyOverrides,
  setSystemFallbackResolution,
  setTextRunProvenanceEnabled,
  textRunProvenanceEnabled,
} from "@domotion/text-engine/testing";
import { getFlattenNestedSvg, setFlattenNestedSvg } from "../src/render/svg-inline.js";
import { getRenderTextMode, setRenderTextMode } from "../src/render/text-to-path.js";

// Snapshot each process-global test knob before a case and restore it after.
// withHostPlatform is scoped by its own finally; assert that scope did not leak.
let prior: ReturnType<typeof snapshot>;
function snapshot() {
  return {
    textMode: getRenderTextMode(),
    systemFallback: getSystemFallbackResolution(),
    genericOverrides: getSessionGenericFamilyOverrides(),
    flattenNestedSvg: getFlattenNestedSvg(),
    textProvenance: textRunProvenanceEnabled(),
  };
}
beforeEach(() => {
  prior = snapshot();
});
afterEach(() => {
  setRenderTextMode(prior.textMode);
  setSystemFallbackResolution(prior.systemFallback);
  setSessionGenericFamilyOverrides(prior.genericOverrides);
  setFlattenNestedSvg(prior.flattenNestedSvg);
  setTextRunProvenanceEnabled(prior.textProvenance);
  if (hostPlatformIsOverridden()) throw new Error("withHostPlatform override leaked across an E2E test");
});

// DM-2672: E2E must exercise the product's persistent native-helper transport.
// Kill that unref'd helper at the end of each test file so Vitest workers have
// an explicit lifecycle boundary without forcing every glyph query through a
// fresh one-shot process.
afterAll(() => clearGlyphHelperCache());

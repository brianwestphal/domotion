// The system-fallback key cache is keyed on the declared family, so asking the
// same codepoint question under two different declared families occupies two
// entries, and asking them again in the reverse order must reuse both rather
// than reset or contaminate one another. The generic-family semantics audit
// (root `tests/generic-family-semantics-audit.test.ts` and its tool) compares
// that cache identity against an independent transcription of Blink's; this is
// the engine-side half, which needs no audit tooling.
import { describe, expect, it } from "vitest";
import {
  __resolveSystemFallbackKeyForCpForTest,
  __systemFallbackKeyCacheSizeForTest,
  clearFontResolutionCaches,
} from "./font-resolution.js";
import { withHostPlatform } from "./host-platform.js";

describe("system-fallback key cache ordering", () => {
  it("starts one real process cache, then reads the reverse order without resetting", () => {
    const ask = (family: string) =>
      withHostPlatform("linux", () =>
        __resolveSystemFallbackKeyForCpForTest(0x10d0, 400, 0, 16, "helvetica", false, "ka", 100, undefined, family),
      );
    clearFontResolutionCaches();
    for (const family of ["Courier", "Arial"]) ask(family);
    expect(__systemFallbackKeyCacheSizeForTest()).toBe(2);
    for (const family of ["Arial", "Courier"]) ask(family);
    expect(__systemFallbackKeyCacheSizeForTest()).toBe(2);
  });
});

/**
 * DM-1350: `setSystemFallbackResolution()` flips a PROCESS-GLOBAL toggle, so a
 * caller that sets-without-restoring would leak the change into every later
 * render in the same process. `withSystemFallbackResolution()` is the safe
 * scoped form that guarantees restore (even on throw); these tests pin that
 * guarantee. Registry-level — runs cross-platform, no font extraction.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSystemFallbackResolution,
  setSystemFallbackResolution,
  withSystemFallbackResolution,
} from "./text-to-path.js";

describe("system-fallback resolution toggle save/restore (DM-1350)", () => {
  let original: boolean;
  beforeEach(() => { original = getSystemFallbackResolution(); });
  // Never let a test leak the process-global into the next test.
  afterEach(() => { setSystemFallbackResolution(original); });

  it("withSystemFallbackResolution applies the toggle inside and restores it after", () => {
    setSystemFallbackResolution(false);
    let seenInside: boolean | null = null;
    const result = withSystemFallbackResolution(true, () => {
      seenInside = getSystemFallbackResolution();
      return 42;
    });
    expect(seenInside).toBe(true);          // applied for the duration of fn
    expect(result).toBe(42);                // returns fn's value
    expect(getSystemFallbackResolution()).toBe(false); // restored to the prior value
  });

  it("restores the prior value even when fn throws", () => {
    setSystemFallbackResolution(true);
    expect(() =>
      withSystemFallbackResolution(false, () => {
        expect(getSystemFallbackResolution()).toBe(false);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(getSystemFallbackResolution()).toBe(true); // not left flipped
  });

  it("nests correctly, restoring each layer's prior value", () => {
    setSystemFallbackResolution(false);
    withSystemFallbackResolution(true, () => {
      expect(getSystemFallbackResolution()).toBe(true);
      withSystemFallbackResolution(false, () => {
        expect(getSystemFallbackResolution()).toBe(false);
      });
      expect(getSystemFallbackResolution()).toBe(true); // inner restored to outer's value
    });
    expect(getSystemFallbackResolution()).toBe(false); // outer restored to original
  });
});

import { describe, expect, it } from "vitest";
import { __persistentFlagsForTest, clearGlyphHelperTransport } from "./glyph-helper-transport.js";
import { invalidateFontEnvironmentCaches } from "./font-resolution.js";

describe("environment invalidation resets the persistent-helper classification", () => {
  it("forgets both 'disabled' and 'ever worked' so a swapped binary is judged afresh", () => {
    __persistentFlagsForTest({ disabled: true, everWorked: true });
    clearGlyphHelperTransport();
    expect(__persistentFlagsForTest()).toEqual({ disabled: false, everWorked: false });
  });

  it("is reached through invalidateFontEnvironmentCaches and stays idempotent", () => {
    __persistentFlagsForTest({ disabled: true, everWorked: true });
    invalidateFontEnvironmentCaches();
    invalidateFontEnvironmentCaches();
    expect(__persistentFlagsForTest()).toEqual({ disabled: false, everWorked: false });
  });
});

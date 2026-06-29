// DM-1435: the render-text mode is a process-global; `withRenderTextMode` is the
// save/restore scope guard that prevents a scoped change from leaking into later
// renders in the same process (the footgun class of DM-1338 / DM-1350). Also
// covers `resetGeneration` bundling the per-generation cache clears.

import { afterEach, describe, expect, it } from "vitest";
import {
  getRenderTextMode,
  setRenderTextMode,
  withRenderTextMode,
  resetGeneration,
  getGlyphDefs,
} from "./text-to-path.js";

// Restore the global default so this file can't leak the mode into other suites.
afterEach(() => setRenderTextMode("embedded-font"));

describe("withRenderTextMode", () => {
  it("sets the mode for the callback and restores the prior value", () => {
    setRenderTextMode("paths");
    const inner = withRenderTextMode("embedded-font", () => getRenderTextMode());
    expect(inner).toBe("embedded-font");
    expect(getRenderTextMode()).toBe("paths"); // restored
  });

  it("restores the prior mode even when the callback throws", () => {
    setRenderTextMode("paths");
    expect(() =>
      withRenderTextMode("embedded-font", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(getRenderTextMode()).toBe("paths"); // restored despite the throw
  });

  it("returns the callback's value", () => {
    expect(withRenderTextMode("paths", () => 42)).toBe(42);
  });

  it("nests correctly", () => {
    setRenderTextMode("embedded-font");
    withRenderTextMode("paths", () => {
      expect(getRenderTextMode()).toBe("paths");
      withRenderTextMode("embedded-font", () => {
        expect(getRenderTextMode()).toBe("embedded-font");
      });
      expect(getRenderTextMode()).toBe("paths"); // inner restored to outer scope
    });
    expect(getRenderTextMode()).toBe("embedded-font");
  });
});

describe("resetGeneration", () => {
  it("clears the paths-mode glyph-defs registry (is callable + leaves it empty)", () => {
    resetGeneration();
    expect(getGlyphDefs()).toBe("");
  });
});

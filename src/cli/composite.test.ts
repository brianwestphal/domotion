/**
 * Unit tests for the `composite` config schema (src/cli/composite.ts). Pure / no
 * Chromium — the layer rendering + compositing is exercised by the runnable
 * example (examples/composite/) and the primitive's own tests
 * (src/animation/composite.test.ts); the schema rules are deterministic here.
 */

import { describe, it, expect } from "vitest";
import { validateCompositeConfig } from "./composite.js";

const base = { width: 800, height: 600 };

describe("validateCompositeConfig (DM-1323)", () => {
  it("accepts a multi-layer config (svg + cast + template) with placement + timeline", () => {
    const cfg = validateCompositeConfig({
      ...base,
      background: "#000",
      duration: 10000,
      layers: [
        { svg: "desktop.svg", x: 0, y: 0, width: 800, height: 600 },
        { cast: "build.cast", term: { mode: "incremental" }, chrome: { device: "window", label: "build" }, x: 100, y: 80,
          animations: [{ property: "scale", from: 1, to: 1.3, start: 5000, duration: 800, transformOrigin: "0 0" }] },
        { template: "lower-third", params: { title: "Hi" }, x: 0, y: 500, start: 2000, mode: "hold" },
      ],
    });
    expect(cfg.layers).toHaveLength(3);
    expect(cfg.layers[1].chrome?.device).toBe("window");
    expect(cfg.layers[1].animations?.[0].property).toBe("scale");
  });

  it("rejects a layer with no source", () => {
    expect(() => validateCompositeConfig({ ...base, layers: [{ x: 0, y: 0 }] })).toThrow(/exactly one source/);
  });

  it("rejects a layer with two sources", () => {
    expect(() => validateCompositeConfig({ ...base, layers: [{ svg: "a.svg", cast: "b.cast" }] })).toThrow(/exactly one source/);
  });

  it("rejects an empty layers array", () => {
    expect(() => validateCompositeConfig({ ...base, layers: [] })).toThrow();
  });

  it("rejects an unknown layer-animation property", () => {
    expect(() =>
      validateCompositeConfig({ ...base, layers: [{ svg: "a.svg", animations: [{ property: "blur", from: 0, to: 1 }] }] }),
    ).toThrow();
  });

  it("defaults chrome device/theme", () => {
    const cfg = validateCompositeConfig({ ...base, layers: [{ cast: "x.cast", chrome: {} }] });
    expect(cfg.layers[0].chrome).toEqual({ device: "window", theme: "dark" });
  });
});

import { describe, expect, it } from "vitest";

import {
  BACKDROP_CASES,
  BACKDROP_EQUIVALENT_CHANGED_FRACTION,
  BACKDROP_MUTATION_MIN_CHANGED_FRACTION,
  BACKDROP_PIXEL_CHANNEL_TOLERANCE,
  BACKDROP_REQUIRED_FAMILIES,
  BACKDROP_SOURCE_PINS,
  backdropAuditFixtureHtml,
  backdropRootReasons,
  mutationDiscriminates,
  nearestBackdropRoot,
  type BackdropStyleFacts,
} from "../tools/backdrop-source-surface-audit.js";

const style = (overrides: Partial<BackdropStyleFacts> = {}): BackdropStyleFacts => ({
  id: "node",
  isDocumentRoot: false,
  opacity: "1",
  filter: "none",
  backdropFilter: "none",
  clipPath: "none",
  maskImage: "none",
  maskBorderSource: "none",
  mixBlendMode: "normal",
  isolation: "auto",
  transform: "none",
  position: "static",
  overflowX: "visible",
  overflowY: "visible",
  willChange: "auto",
  ...overrides,
});

describe("DM-2357 backdrop source-surface model", () => {
  it("pins the Blink handoff and Chromium-owned Skia revision", () => {
    expect(BACKDROP_SOURCE_PINS).toEqual({
      chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
      skiaPinnedByChromium: "62efacd37737505732dbe3d8daa62abd679626a1",
    });
    expect(BACKDROP_PIXEL_CHANNEL_TOLERANCE).toBe(4);
    expect(BACKDROP_EQUIVALENT_CHANGED_FRACTION).toBe(.01);
    expect(BACKDROP_MUTATION_MIN_CHANGED_FRACTION).toBe(.002);
  });

  it("classifies every effect-tree Backdrop Root trigger", () => {
    expect(backdropRootReasons(style({ isDocumentRoot: true }))).toContain("document-root");
    expect(backdropRootReasons(style({ opacity: ".8" }))).toContain("opacity");
    expect(backdropRootReasons(style({ filter: "blur(1px)" }))).toContain("filter");
    expect(backdropRootReasons(style({ backdropFilter: "blur(1px)" }))).toContain("backdrop-filter");
    expect(backdropRootReasons(style({ clipPath: "inset(2px)" }))).toContain("clip-path");
    expect(backdropRootReasons(style({ maskImage: "linear-gradient(#000,#000)" }))).toContain("mask");
    expect(backdropRootReasons(style({ mixBlendMode: "multiply" }))).toContain("mix-blend-mode");
    expect(backdropRootReasons(style({ willChange: "transform, clip-path" }))).toContain("will-change");
  });

  it("does not confuse isolation, transform, positioning, overflow, or z-order with a Backdrop Root", () => {
    expect(backdropRootReasons(style({ isolation: "isolate" }))).toEqual([]);
    expect(backdropRootReasons(style({ transform: "matrix(1, 0, 0, 1, 4, 2)" }))).toEqual([]);
    expect(backdropRootReasons(style({ position: "fixed" }))).toEqual([]);
    expect(backdropRootReasons(style({ position: "sticky", overflowY: "auto" }))).toEqual([]);
  });

  it("selects the nearest root rather than the nearest stacking context", () => {
    const root = nearestBackdropRoot([
      style({ id: "isolated", isolation: "isolate" }),
      style({ id: "transformed", transform: "matrix(1, 0, 0, 1, 4, 2)" }),
      style({ id: "opaque-root", opacity: ".7" }),
      style({ id: "document", isDocumentRoot: true }),
    ]);
    expect(root).toEqual({ id: "opaque-root", reasons: ["opacity"] });
  });

  it("ships every requested transition family in a deterministic font-free corpus", () => {
    const families = new Set(BACKDROP_CASES.map((row) => row.family));
    for (const family of BACKDROP_REQUIRED_FAMILIES) expect(families, family).toContain(family);
    const fixture = backdropAuditFixtureHtml();
    expect(fixture).toContain("backdrop-filter:blur(6px)");
    expect(fixture).toContain("#bd-pseudo-target::before");
    expect(fixture).toContain('data-domotion-anim="bd-nested-outer"');
    expect(fixture).toContain('data-domotion-anim="bd-overlap-secondary"');
  });

  it("requires both spatial movement and a material channel delta from mutations", () => {
    expect(mutationDiscriminates({ pixels: 1000, changedPixels: 3, changedFraction: .003, meanAbsoluteChannelDelta: .1, maxChannelDelta: 12 })).toBe(true);
    expect(mutationDiscriminates({ pixels: 1000, changedPixels: 1, changedFraction: .001, meanAbsoluteChannelDelta: 8, maxChannelDelta: 255 })).toBe(false);
    expect(mutationDiscriminates({ pixels: 1000, changedPixels: 500, changedFraction: .5, meanAbsoluteChannelDelta: 2, maxChannelDelta: 11 })).toBe(false);
  });
});

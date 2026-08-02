// `installHarfbuzzShaping` gives an already-built font instance HarfBuzz
// shaping while leaving its own engine as the source of outlines.
//
// It exists because `sf-pro` / `sf-pro-italic` / `u-sf-pro-text` / `sf-hebrew`
// carry `trak` + `STAT` and are opened by FONTKIT, not by the native helper —
// they are ordinary `glyf` files, so they never take the `extractor: "native"`
// branch and never reach the helper's `shapeFallback` seam. That is `system-ui`,
// most macOS body text, and fontkit implements no AAT tracking at all.
//
// macOS-gated on purpose. `trak` is a per-size interpolated table and `STAT`
// has to satisfy HarfBuzz's sanitizer, so a synthetic pair would test the
// builder rather than the shaper. The platform-independent half — which faces
// qualify — is covered by `trak-stat-gate.test.ts`.
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { installHarfbuzzShaping } from "./harfbuzz-shaper.js";
import { clearFontResolutionCaches, getFontInstance } from "./font-resolution.js";

const SFNS = "/System/Library/Fonts/SFNS.ttf";
const onDarwin = process.platform === "darwin" && existsSync(SFNS);
const describeMac = onDarwin ? describe : describe.skip;

/** Total advance of a run, in font units — the quantity tracking moves. */
function totalAdvance(size: number, key = "sf-pro", text = "Hamburgefonstiv"): number {
  const f = getFontInstance(key, 400, size, 0) as unknown as {
    layout(t: string): { positions: Array<{ xAdvance: number }> };
  } | null;
  if (f == null) throw new Error(`no instance for ${key}`);
  return f.layout(text).positions.reduce((a, p) => a + p.xAdvance, 0);
}

beforeEach(() => {
  delete process.env.DOMOTION_TRAK_HB_SHAPING;
  clearFontResolutionCaches();
});
afterEach(() => {
  delete process.env.DOMOTION_TRAK_HB_SHAPING;
  clearFontResolutionCaches();
});

describeMac("AAT tracking on the fontkit path", () => {
  it("makes a trak+STAT face's advances depend on the run size", () => {
    // The defining property of tracking: the SAME text is a different width at
    // a different size, beyond the linear scale. Asserting three sizes rather
    // than two, because two could differ from an optical-size step alone.
    const a = totalAdvance(12);
    const b = totalAdvance(16);
    const c = totalAdvance(32);
    expect(new Set([a, b, c]).size).toBe(3);
    // Tracking tightens as size grows, which is what the table encodes and what
    // makes the direction checkable rather than just the variance.
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });

  it("is bounded by DOMOTION_TRAK_HB_SHAPING=0, and the answer moves", async () => {
    // The standing check for anything default-on: disabling it must MOVE the
    // number. A flag that changes nothing is not evidence the mechanism is in
    // the loop — it is the signature of a mechanism that never ran, which is
    // exactly how a resolver once shipped inert for months.
    //
    // Re-imported rather than toggled in place: the flag is a module-level
    // const, like every sibling `DOMOTION_*` flag, so it is read once at load.
    // Setting the variable and re-calling would test nothing and PASS as though
    // it had — the failure mode this assertion exists to catch.
    const on = totalAdvance(16);
    process.env.DOMOTION_TRAK_HB_SHAPING = "0";
    vi.resetModules();
    const reloaded = await import("./font-resolution.js");
    reloaded.clearFontResolutionCaches();
    const f = reloaded.getFontInstance("sf-pro", 400, 16, 0) as unknown as {
      layout(t: string): { positions: Array<{ xAdvance: number }> };
    };
    const off = f.layout("Hamburgefonstiv").positions.reduce((a, p) => a + p.xAdvance, 0);
    expect(off).not.toBe(on);
    vi.resetModules();
  });

  it("leaves a face WITHOUT both tables alone", () => {
    // The control. Helvetica carries `morx` and `kern` and neither `trak` nor
    // `STAT`, so its advances must not depend on the run size at all — if they
    // did, this would be firing on every face rather than the qualifying ones.
    const sizes = [12, 16, 32].map((s) => totalAdvance(s, "helvetica"));
    expect(new Set(sizes).size).toBe(1);
  });
});

describeMac("installHarfbuzzShaping mechanics", () => {
  it("keeps the instance's own fields and identity", () => {
    // The reason this installs in place rather than returning a proxy: a
    // `getFontInstance` result carries fields the renderer and the embedded-font
    // path read later, and is itself a `fontSourceMap` key. A proxy with a fixed
    // property set would drop all of it silently.
    const inst = getFontInstance("sf-pro", 400, 16, 0) as unknown as Record<string, unknown> | null;
    expect(inst).not.toBeNull();
    expect(typeof inst!.naturalWeight).toBe("number");
    expect(inst!.unitsPerEm).toBeGreaterThan(0);
    // Identity is stable across calls, which is what keeps `renderTextAsPath`
    // from ending a run at every character (it compares font overrides by ===).
    expect(getFontInstance("sf-pro", 400, 16, 0)).toBe(inst);
  });

  it("takes outlines from the base engine, not from HarfBuzz", () => {
    // Both engines read the same `glyf`, so comparing path commands would be a
    // weak assertion — near-identical either way. Object identity is the strong
    // one: fontkit memoizes `Glyph` objects by id, so a glyph that came from the
    // base is the very same object the base hands out directly.
    const inst = getFontInstance("sf-pro", 400, 16, 0) as unknown as {
      layout(t: string): { glyphs: Array<{ id: number; path: { commands: unknown[] } }> };
      getGlyph(id: number): unknown;
    };
    const run = inst.layout("Hamburgefonstiv");
    expect(run.glyphs.length).toBeGreaterThan(0);
    for (const g of run.glyphs) expect(g).toBe(inst.getGlyph(g.id));
    // And they can actually be drawn — an outline-less result would satisfy the
    // identity check above just as well.
    expect(run.glyphs.some((g) => g.path.commands.length > 0)).toBe(true);
  });

  it("declines a face HarfBuzz cannot open, leaving layout untouched", () => {
    // Failure has to be inert. A shaper that cannot open the file must leave
    // the instance shaping exactly as it did, not lose its `layout`.
    const marker = { glyphs: [], positions: [], clusters: [] };
    const stub = {
      layout: () => marker,
      unitsPerEm: 1000, ascent: 800, descent: -200,
      underlinePosition: -100, underlineThickness: 50,
      glyphForCodePoint: () => ({ id: 1 }),
    };
    expect(installHarfbuzzShaping(stub as never, "/no/such/font.ttf", 0, 16, null)).toBe(false);
    expect(stub.layout()).toBe(marker);
    // A null face index is "I could not identify the face", which must decline
    // rather than silently shape with member 0.
    expect(installHarfbuzzShaping(stub as never, SFNS, null, 16, null)).toBe(false);
    expect(stub.layout()).toBe(marker);
  });
});

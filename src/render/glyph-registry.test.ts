/**
 * DM-1338: the `paths`-mode glyph registry (`<defs><path id="gN">` + `<use>`)
 * is module-global. Producers reset it per top-level generation (alongside
 * `clearEmbeddedFonts()`); without that reset, `getGlyphDefs()` accumulates
 * every glyph rendered process-wide, so each back-to-back render emits the
 * prior render's (now unreferenced) glyph defs as dead bloat. These tests pin
 * the reset semantics that the producer wiring depends on — registry-level so
 * they run cross-platform (no font/glyph extraction needed).
 */
import { describe, expect, it } from "vitest";
import { ensureGlyphDef, getGlyphDefs, clearGlyphDefs } from "./text-to-path.js";

const CMDS = [
  { command: "moveTo", args: [0, 0] },
  { command: "lineTo", args: [10, 0] },
  { command: "lineTo", args: [10, 10] },
  { command: "closePath", args: [] },
];
const defCount = (svg: string): number => (svg.match(/<path id="g\d+"/g) ?? []).length;

describe("glyph registry resets per generation (DM-1338)", () => {
  it("clearGlyphDefs empties the def map and rewinds the id counter", () => {
    clearGlyphDefs();
    const id1 = ensureGlyphDef("FontA", 400, 16, 0, 5, CMDS);
    expect(id1).toBe("g0");
    expect(getGlyphDefs()).toContain('id="g0"');

    clearGlyphDefs();
    expect(getGlyphDefs()).toBe("");

    // The next "render" must start fresh at g0 and carry ONLY its own glyph —
    // not the previous render's g0.
    const id2 = ensureGlyphDef("FontB", 700, 24, 0, 9, CMDS);
    expect(id2).toBe("g0");
    expect(defCount(getGlyphDefs())).toBe(1);
  });

  it("two back-to-back renders separated by clearGlyphDefs do not accumulate", () => {
    clearGlyphDefs();
    ensureGlyphDef("FontA", 400, 16, 0, 1, CMDS);
    ensureGlyphDef("FontA", 400, 16, 0, 2, CMDS);
    expect(defCount(getGlyphDefs())).toBe(2);

    clearGlyphDefs(); // what every producer now does before the next top-level render
    ensureGlyphDef("FontB", 400, 16, 0, 3, CMDS);
    // The second render's output contains ONLY its own glyph, not the first's 2.
    expect(defCount(getGlyphDefs())).toBe(1);
  });

  it("WITHOUT a reset the registry accumulates across renders (the bug being guarded)", () => {
    clearGlyphDefs();
    ensureGlyphDef("FontA", 400, 16, 0, 1, CMDS);
    ensureGlyphDef("FontA", 400, 16, 0, 2, CMDS);
    // No reset here → the next render piles onto the same map.
    ensureGlyphDef("FontB", 400, 16, 0, 3, CMDS);
    expect(defCount(getGlyphDefs())).toBe(3);
    clearGlyphDefs();
  });
});

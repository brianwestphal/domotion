/**
 * Speculative composition — the embedded-font subset builder's snapshot/restore
 * transaction.
 *
 * The builder hands out PUA codepoints in order of first glyph use and `dmfN`
 * family names in order of first instance registration. Both are module-global
 * and, under a NESTED composition (`manageFonts: false`), shared with the whole
 * outer run. So a caller that composes a variant merely to measure its real
 * byte size, then throws it away, silently shifts the addressing of the real
 * output that follows — the output stops being a function of its input.
 *
 * The bar these tests hold the API to is BYTE IDENTITY: compose X normally and
 * record the bytes; then, from the same starting state, snapshot → compose a
 * DIFFERENT variant → restore → compose X, and the two must be byte-identical.
 * Each byte-identity test is paired with a "goes red without the rollback"
 * assertion in the same file, so the test can never quietly become vacuous.
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  _builderEntryFieldNames,
  _builderEntryState,
  _builderInstanceKeys,
  _builderRegistrySize,
  clearEmbeddedFontBuilder,
  getBuiltEmbeddedFontFaceCss,
  restoreEmbeddedFonts,
  snapshotEmbeddedFonts,
  trackGlyphInEmbedFont,
} from "./embedded-font-builder.js";
import {
  clearGlyphDefs,
  ensureGlyphDef,
  getGlyphDefs,
  resetGeneration,
  restoreGeneration,
  setRenderTextMode,
  snapshotGeneration,
} from "./text-to-path.js";
import { elementTreeToSvg } from "./element-tree-to-svg.js";
import type { CapturedElement } from "../capture/types.js";

// Two distinct deterministic outlines so a swapped glyph changes the subset
// bytes, not only the PUA stream.
const TRI = [
  { command: "moveTo", args: [100, 0] },
  { command: "lineTo", args: [500, 0] },
  { command: "lineTo", args: [300, 700] },
  { command: "closePath", args: [] },
];
const BOX = [
  { command: "moveTo", args: [120, 0] },
  { command: "lineTo", args: [480, 0] },
  { command: "lineTo", args: [480, 640] },
  { command: "lineTo", args: [120, 640] },
  { command: "closePath", args: [] },
];

/** The "real" composition under test: two instances, glyphs in a fixed order. */
function composeReal(): string {
  trackGlyphInEmbedFont("real-a|w=400|s=0", 1000, 800, -200, 11, TRI, 600);
  trackGlyphInEmbedFont("real-a|w=400|s=0", 1000, 800, -200, 22, BOX, 640);
  trackGlyphInEmbedFont("real-b|w=700|s=1", 2048, 1638, -410, 5, BOX, 1200,
    { italic: true, weight: 700 });
  return getBuiltEmbeddedFontFaceCss();
}

/** A DIFFERENT variant: different instance keys, different glyph ids, and the
 *  same glyph ids the real pass uses but reached in the opposite order — so a
 *  leaked trial shifts both the `dmfN` names and the PUA assignments. */
function composeSpeculative(): string {
  trackGlyphInEmbedFont("spec-x|w=400|s=0", 1000, 800, -200, 22, BOX, 640);
  trackGlyphInEmbedFont("spec-x|w=400|s=0", 1000, 800, -200, 11, TRI, 600);
  trackGlyphInEmbedFont("real-a|w=400|s=0", 1000, 800, -200, 99, BOX, 700, { italic: false, weight: 900 });
  return getBuiltEmbeddedFontFaceCss();
}

describe("snapshotEmbeddedFonts / restoreEmbeddedFonts — byte identity under speculation", () => {
  beforeEach(() => clearEmbeddedFontBuilder());

  it("a discarded speculative compose leaves the real output byte-identical", () => {
    // (1) Normal compose from a clean builder.
    clearEmbeddedFontBuilder();
    const baseline = composeReal();
    expect(baseline).toContain("data:font/ttf;base64,");

    // (2) Fresh state → snapshot → speculative compose → restore → same compose.
    clearEmbeddedFontBuilder();
    const marker = snapshotEmbeddedFonts();
    composeSpeculative();
    restoreEmbeddedFonts(marker);
    const afterRollback = composeReal();

    expect(afterRollback).toBe(baseline);
  });

  it("goes red without the rollback (the trial DOES perturb the output)", () => {
    // The proof that the test above is not vacuous: drop the restore and the
    // same compose produces different bytes. If this ever starts passing, the
    // byte-identity assertion above has stopped proving anything.
    clearEmbeddedFontBuilder();
    const baseline = composeReal();

    clearEmbeddedFontBuilder();
    snapshotEmbeddedFonts();
    composeSpeculative();
    /* no restoreEmbeddedFonts(marker) here */
    const leaked = composeReal();

    expect(leaked).not.toBe(baseline);
  });

  it("restores to a marker taken after real work already accumulated (the nesting case)", () => {
    // `manageFonts: false` composers share the registry with the outer run, so
    // the marker is normally taken mid-run, not from empty.
    const prefix = (): void => {
      trackGlyphInEmbedFont("outer|w=400|s=0", 1000, 800, -200, 7, TRI, 500);
      trackGlyphInEmbedFont("outer|w=400|s=0", 1000, 800, -200, 8, BOX, 520);
    };

    clearEmbeddedFontBuilder();
    prefix();
    const baseline = composeReal();

    clearEmbeddedFontBuilder();
    prefix();
    const marker = snapshotEmbeddedFonts();
    composeSpeculative();
    restoreEmbeddedFonts(marker);
    const afterRollback = composeReal();

    expect(afterRollback).toBe(baseline);
    // And red without the rollback, from the same mid-run marker.
    clearEmbeddedFontBuilder();
    prefix();
    snapshotEmbeddedFonts();
    composeSpeculative();
    expect(composeReal()).not.toBe(baseline);
  });

  it("survives repeated speculation from the same marker", () => {
    clearEmbeddedFontBuilder();
    const baseline = composeReal();

    clearEmbeddedFontBuilder();
    const marker = snapshotEmbeddedFonts();
    for (let i = 0; i < 3; i++) {
      composeSpeculative();
      restoreEmbeddedFonts(marker); // marker is reusable, not consumed
    }
    expect(composeReal()).toBe(baseline);
  });
});

describe("snapshotEmbeddedFonts / restoreEmbeddedFonts — state rollback surface", () => {
  beforeEach(() => clearEmbeddedFontBuilder());

  it("rolls back every mutable field of a tracked entry", () => {
    const KEY = "surface|w=400|s=0";
    const SRC = { path: "/synthetic/source.ttf", faceIndex: 0, variationAxes: { wght: 400 } };
    trackGlyphInEmbedFont(KEY, 1000, 800, -200, 3, TRI, 600, { italic: false, weight: 400, hintedSource: SRC });
    trackGlyphInEmbedFont(KEY, 1000, 800, -200, 4, BOX, 610, { italic: false, weight: 400, hintedSource: SRC });
    const before = _builderEntryState(KEY);
    expect(before).not.toBeNull();
    expect(before!.hintedSourceDisqualified).toBe(false);

    const marker = snapshotEmbeddedFonts();

    // Mutate every field the entry can mutate: add glyphs (glyphs +
    // puaForGlyphId + nextPua), widen the weight range both ways, and latch the
    // hinted-source disqualification with a synthetic (faux-bold) glyph.
    trackGlyphInEmbedFont(KEY, 1000, 800, -200, 5, BOX, 620, { italic: false, weight: 900, hintedSource: SRC });
    trackGlyphInEmbedFont(KEY, 1000, 800, -200, 6, TRI, 630, { italic: false, weight: 100, emboldenStrengthFU: 20 });
    trackGlyphInEmbedFont("brand-new|w=400|s=0", 1000, 800, -200, 1, TRI, 600);
    const dirty = _builderEntryState(KEY)!;
    expect(dirty.glyphIds).not.toEqual(before!.glyphIds);
    expect(dirty.nextPua).toBeGreaterThan(before!.nextPua);
    expect(dirty.weightMin).toBe(100);
    expect(dirty.weightMax).toBe(900);
    expect(dirty.hintedSourceDisqualified).toBe(true);
    expect(_builderRegistrySize()).toBe(2);

    restoreEmbeddedFonts(marker);

    expect(_builderEntryState(KEY)).toEqual(before);
    expect(_builderRegistrySize()).toBe(1);
    expect(_builderInstanceKeys()).toEqual([KEY]);
  });

  it("rolls back the dmfN family counter, so the next instance reuses the id", () => {
    trackGlyphInEmbedFont("first|w=400|s=0", 1000, 800, -200, 1, TRI, 600);
    const marker = snapshotEmbeddedFonts();
    trackGlyphInEmbedFont("trial|w=400|s=0", 1000, 800, -200, 1, TRI, 600);
    expect(_builderEntryState("trial|w=400|s=0")!.cssFamily).toBe("dmf1");

    restoreEmbeddedFonts(marker);
    trackGlyphInEmbedFont("for-real|w=400|s=0", 1000, 800, -200, 1, TRI, 600);
    expect(_builderEntryState("for-real|w=400|s=0")!.cssFamily).toBe("dmf1");
  });

  it("restores registry insertion order, not just the set of entries", () => {
    // Insertion order is the order `@font-face` rules are emitted in, so a
    // rollback that restored the entries in a different order would still
    // change the output bytes.
    trackGlyphInEmbedFont("k-a|w=400|s=0", 1000, 800, -200, 1, TRI, 600);
    trackGlyphInEmbedFont("k-b|w=400|s=0", 1000, 800, -200, 1, TRI, 600);
    const marker = snapshotEmbeddedFonts();
    clearEmbeddedFontBuilder();
    trackGlyphInEmbedFont("k-b|w=400|s=0", 1000, 800, -200, 1, TRI, 600);
    trackGlyphInEmbedFont("k-a|w=400|s=0", 1000, 800, -200, 1, TRI, 600);
    expect(_builderInstanceKeys()).toEqual(["k-b|w=400|s=0", "k-a|w=400|s=0"]);

    restoreEmbeddedFonts(marker);
    expect(_builderInstanceKeys()).toEqual(["k-a|w=400|s=0", "k-b|w=400|s=0"]);
  });

  it("recovers state a speculative pass CLEARED outright", () => {
    // A nested producer may start its own generation (clearEmbeddedFontBuilder)
    // inside the speculative window. A cursor-style marker could not undo that;
    // this one holds values, so it can.
    trackGlyphInEmbedFont("keep|w=400|s=0", 1000, 800, -200, 1, TRI, 600);
    const marker = snapshotEmbeddedFonts();
    clearEmbeddedFontBuilder();
    expect(_builderRegistrySize()).toBe(0);
    restoreEmbeddedFonts(marker);
    expect(_builderRegistrySize()).toBe(1);
    expect(_builderEntryState("keep|w=400|s=0")!.puas).toEqual([0xE000]);
  });

  it("nests: take, take, restore, restore unwinds to each marker in turn", () => {
    trackGlyphInEmbedFont("base|w=400|s=0", 1000, 800, -200, 1, TRI, 600);
    const outer = snapshotEmbeddedFonts();
    trackGlyphInEmbedFont("mid|w=400|s=0", 1000, 800, -200, 1, TRI, 600);
    const inner = snapshotEmbeddedFonts();
    trackGlyphInEmbedFont("leaf|w=400|s=0", 1000, 800, -200, 1, TRI, 600);
    expect(_builderInstanceKeys()).toHaveLength(3);

    restoreEmbeddedFonts(inner);
    expect(_builderInstanceKeys()).toEqual(["base|w=400|s=0", "mid|w=400|s=0"]);
    restoreEmbeddedFonts(outer); // an inner restore must not invalidate the outer marker
    expect(_builderInstanceKeys()).toEqual(["base|w=400|s=0"]);
  });

  it("a restored marker is not aliased to the live registry", () => {
    trackGlyphInEmbedFont("alias|w=400|s=0", 1000, 800, -200, 1, TRI, 600);
    const marker = snapshotEmbeddedFonts();
    trackGlyphInEmbedFont("alias|w=400|s=0", 1000, 800, -200, 2, BOX, 610);
    restoreEmbeddedFonts(marker);
    // Mutating after a restore must not write through into the marker.
    trackGlyphInEmbedFont("alias|w=400|s=0", 1000, 800, -200, 3, BOX, 620);
    restoreEmbeddedFonts(marker);
    expect(_builderEntryState("alias|w=400|s=0")!.glyphIds).toEqual([1]);
  });

  it("restoring a marker taken before ANY font work empties the builder", () => {
    clearEmbeddedFontBuilder();
    const marker = snapshotEmbeddedFonts();
    composeSpeculative();
    expect(_builderRegistrySize()).toBeGreaterThan(0);
    restoreEmbeddedFonts(marker);
    expect(_builderRegistrySize()).toBe(0);
    expect(getBuiltEmbeddedFontFaceCss()).toBe("");
    // …and the family counter rewound with it.
    trackGlyphInEmbedFont("fresh|w=400|s=0", 1000, 800, -200, 1, TRI, 600);
    expect(_builderEntryState("fresh|w=400|s=0")!.cssFamily).toBe("dmf0");
  });

  it("never throws on an empty / never-used builder, or on a repeated restore", () => {
    clearEmbeddedFontBuilder();
    const marker = snapshotEmbeddedFonts();
    expect(() => restoreEmbeddedFonts(marker)).not.toThrow();
    expect(() => restoreEmbeddedFonts(marker)).not.toThrow();
    expect(_builderRegistrySize()).toBe(0);
  });

  it("pins the BuilderEntry field list the clone has to cover", () => {
    // A new mutable-container field on BuilderEntry would be copied by
    // reference by the spread in `cloneBuilderEntry` and silently escape the
    // rollback — a partial rollback corrupts output more quietly than none.
    // If this fails: audit `cloneBuilderEntry`, then update the list.
    trackGlyphInEmbedFont("fields|w=400|s=0", 1000, 800, -200, 1, TRI, 600);
    expect(_builderEntryFieldNames("fields|w=400|s=0").sort()).toEqual([
      "ascender",
      "cssFamily",
      "descender",
      "glyphs",
      "hintedSource",
      "hintedSourceDisqualified",
      "italic",
      "nextPua",
      "puaForGlyphId",
      "unitsPerEm",
      "weightMax",
      "weightMin",
    ]);
  });
});

describe("snapshotGeneration / restoreGeneration — both registries in one transaction", () => {
  const CMDS = [
    { command: "moveTo", args: [0, 0] },
    { command: "lineTo", args: [10, 0] },
    { command: "closePath", args: [] },
  ];

  beforeEach(() => resetGeneration());
  afterEach(() => { setRenderTextMode("embedded-font"); resetGeneration(); });

  it("rolls back the paths-mode glyph-defs registry too", () => {
    setRenderTextMode("paths");
    ensureGlyphDef("FontA", 400, 16, 0, 1, CMDS);
    const baseline = getGlyphDefs();

    const marker = snapshotGeneration();
    ensureGlyphDef("Trial", 700, 24, 0, 9, CMDS);
    ensureGlyphDef("Trial", 700, 24, 0, 10, CMDS);
    expect(getGlyphDefs()).not.toBe(baseline);

    restoreGeneration(marker);
    expect(getGlyphDefs()).toBe(baseline);
    // The id counter rewound, so the next real glyph reuses `g1`.
    expect(ensureGlyphDef("FontB", 400, 16, 0, 2, CMDS)).toBe("g1");
  });

  it("recovers glyph defs a speculative pass cleared", () => {
    setRenderTextMode("paths");
    ensureGlyphDef("FontA", 400, 16, 0, 1, CMDS);
    const marker = snapshotGeneration();
    const baseline = getGlyphDefs();
    clearGlyphDefs(); // a nested producer starting its own generation
    restoreGeneration(marker);
    expect(getGlyphDefs()).toBe(baseline);
  });

  it("rolls back both registries at once and never throws when empty", () => {
    resetGeneration();
    const marker = snapshotGeneration();
    setRenderTextMode("paths");
    ensureGlyphDef("Trial", 400, 16, 0, 1, CMDS);
    trackGlyphInEmbedFont("gen-trial|w=400|s=0", 1000, 800, -200, 1, TRI, 600);

    expect(() => restoreGeneration(marker)).not.toThrow();
    expect(getGlyphDefs()).toBe("");
    expect(_builderRegistrySize()).toBe(0);
    expect(() => restoreGeneration(marker)).not.toThrow();
  });

  it("nests across both registries", () => {
    setRenderTextMode("paths");
    ensureGlyphDef("A", 400, 16, 0, 1, CMDS);
    trackGlyphInEmbedFont("n-a|w=400|s=0", 1000, 800, -200, 1, TRI, 600);
    const outer = snapshotGeneration();
    ensureGlyphDef("B", 400, 16, 0, 2, CMDS);
    trackGlyphInEmbedFont("n-b|w=400|s=0", 1000, 800, -200, 1, TRI, 600);
    const inner = snapshotGeneration();
    ensureGlyphDef("C", 400, 16, 0, 3, CMDS);
    trackGlyphInEmbedFont("n-c|w=400|s=0", 1000, 800, -200, 1, TRI, 600);

    restoreGeneration(inner);
    expect(_builderInstanceKeys()).toEqual(["n-a|w=400|s=0", "n-b|w=400|s=0"]);
    expect(getGlyphDefs().match(/<path/g)).toHaveLength(2);

    restoreGeneration(outer);
    expect(_builderInstanceKeys()).toEqual(["n-a|w=400|s=0"]);
    expect(getGlyphDefs().match(/<path/g)).toHaveLength(1);
  });
});

// ── Compose-level acceptance: a real elementTreeToSvg render ────────────────

const BASE_STYLES = {
  backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none", backgroundSize: "auto",
  backgroundPosition: "0% 0%", backgroundRepeat: "repeat", backgroundClip: "border-box",
  backgroundOrigin: "padding-box", backgroundAttachment: "scroll",
  borderColor: "rgb(0,0,0)", borderWidth: "0", borderRadius: "0",
  borderTopLeftRadius: "0", borderTopRightRadius: "0", borderBottomRightRadius: "0", borderBottomLeftRadius: "0",
  borderTopWidth: "0", borderRightWidth: "0", borderBottomWidth: "0", borderLeftWidth: "0",
  borderTopColor: "rgb(0,0,0)", borderRightColor: "rgb(0,0,0)", borderBottomColor: "rgb(0,0,0)", borderLeftColor: "rgb(0,0,0)",
  borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none",
  color: "rgb(0,0,0)", fontSize: "16px", fontFamily: "sans-serif", fontWeight: "400", fontStyle: "normal",
  lineHeight: "20px", letterSpacing: "normal", textAlign: "left", textTransform: "none",
  textDecoration: "none", textDecorationLine: "none", textDecorationStyle: "solid", textDecorationColor: "rgb(0,0,0)",
  textDecorationThickness: "auto", textUnderlineOffset: "auto", whiteSpace: "normal", wordSpacing: "0",
  verticalAlign: "baseline", direction: "ltr", writingMode: "horizontal-tb", textOverflow: "clip",
  cursor: "auto", caretColor: "auto", outlineColor: "rgb(0,0,0)", outlineWidth: "0", outlineStyle: "none", outlineOffset: "0",
  boxShadow: "none", opacity: "1", transform: "none", transformOrigin: "50% 50%", visibility: "visible",
  borderCollapse: "separate", overflowX: "visible", overflowY: "visible", scrollbarGutter: "auto",
  scrollWidth: 200, scrollHeight: 40, clientWidth: 200, clientHeight: 40, scrollTop: 0, scrollLeft: 0,
  objectFit: "fill", objectPosition: "50% 50%", filter: "none", backdropFilter: "none", mixBlendMode: "normal",
  clipPath: "none", mask: "none", maskImage: "none", maskMode: "match-source", maskSize: "auto",
  maskPosition: "0% 0%", maskRepeat: "repeat", maskComposite: "add",
  listStyleType: "disc", listStyleImage: "none", display: "block", listStylePosition: "outside",
  paddingTop: "0", paddingRight: "0", paddingBottom: "0", paddingLeft: "0",
  borderImageSource: "none", borderImageSlice: "100%", borderImageWidth: "1", borderImageOutset: "0", borderImageRepeat: "stretch",
  zIndex: "auto", position: "static", float: "none", order: "0", flexDirection: "row",
} as unknown as CapturedElement["styles"];

function textTree(text: string, fontSize: string): CapturedElement[] {
  return [{
    tag: "div", text,
    x: 10, y: 10, width: 400, height: 30, children: [],
    textLeft: 10, textTop: 12, textWidth: 380, textHeight: 20, fontAscent: 15,
    styles: { ...BASE_STYLES, fontSize },
  } as CapturedElement];
}

const composeSvg = (text: string, fontSize = "16px"): string =>
  elementTreeToSvg(textTree(text, fontSize), 420, 50);

describe("speculative compose through elementTreeToSvg is byte-identical after rollback", () => {
  beforeEach(() => resetGeneration());
  afterEach(() => resetGeneration());

  // Text rendering routes through the host platform's fonts; if none resolve
  // (an unusual bare container) no subset is embedded and the comparison would
  // be vacuous, so the assertions below check the font data is really there.
  const REAL = "The quick brown fox";
  const TRIAL = "xof nworb kciuq ehT — 9876543210"; // same-ish glyph set, different order + extras

  it("composes → speculates → rolls back → recomposes to the same bytes", () => {
    resetGeneration();
    const baseline = composeSvg(REAL);
    const embedded = baseline.includes("data:font/ttf;base64,");

    resetGeneration();
    const marker = snapshotGeneration();
    const trial = composeSvg(TRIAL, "23px"); // a different variant, measured then discarded
    expect(trial.length).toBeGreaterThan(0);
    restoreGeneration(marker);
    const afterRollback = composeSvg(REAL);

    expect(afterRollback).toBe(baseline);
    // Non-vacuity: the render really did embed a font subset on this platform.
    expect(embedded).toBe(true);
  });

  it("goes red without the rollback", () => {
    resetGeneration();
    const baseline = composeSvg(REAL);

    resetGeneration();
    snapshotGeneration();
    composeSvg(TRIAL, "23px");
    /* no restoreGeneration(marker) */
    const leaked = composeSvg(REAL);

    expect(leaked).not.toBe(baseline);
  });

  it("rolls back a mid-run marker (the nested `manageFonts: false` case)", () => {
    resetGeneration();
    composeSvg("Outer chrome heading");
    const baseline = composeSvg(REAL);

    resetGeneration();
    composeSvg("Outer chrome heading");
    const marker = snapshotGeneration();
    composeSvg(TRIAL, "23px");
    restoreGeneration(marker);

    expect(composeSvg(REAL)).toBe(baseline);
  });
});

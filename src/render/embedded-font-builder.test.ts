import { describe, expect, it, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import * as fontkit from "fontkit";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearEmbeddedFontBuilder, getBuiltEmbeddedFontFaceCss, getEmbeddedFontBuildDiagnostics, trackGlyphInEmbedFont } from "./embedded-font-builder.js";
import { buildStaticHintedFont, buildVariableHintedFont } from "./synth-test-fonts.js";

// A small deterministic glyph outline (a triangle) to register.
const TRI = [
  { command: "moveTo" as const, args: [100, 0] },
  { command: "lineTo" as const, args: [500, 0] },
  { command: "lineTo" as const, args: [300, 700] },
  { command: "closePath" as const, args: [] },
];

// An "A" drawn the way system fonts (SF Pro) draw it: a leg-and-apex silhouette
// contour PLUS a separate crossbar rectangle that OVERLAPS both legs. These two
// same-winding contours must union under nonzero fill. Emitted as CFF, Chrome
// rasterized the overlap as even-odd and punched holes at the crossbar joins
// (DM-1666); emitted as glyf, the union is correct.
const OVERLAP_A = [
  { command: "moveTo" as const, args: [332, 0] },
  { command: "lineTo" as const, args: [72, 0] },
  { command: "lineTo" as const, args: [824, 2048] },
  { command: "lineTo" as const, args: [1080, 2048] },
  { command: "lineTo" as const, args: [1832, 0] },
  { command: "lineTo" as const, args: [1572, 0] },
  { command: "lineTo" as const, args: [960, 1724] },
  { command: "lineTo" as const, args: [944, 1724] },
  { command: "closePath" as const, args: [] },
  { command: "moveTo" as const, args: [428, 800] },
  { command: "lineTo" as const, args: [1476, 800] },
  { command: "lineTo" as const, args: [1476, 580] },
  { command: "lineTo" as const, args: [428, 580] },
  { command: "closePath" as const, args: [] },
];

function buildOnceCss(): string {
  clearEmbeddedFontBuilder();
  trackGlyphInEmbedFont("det-test|w=400|s=0", 1000, 800, -200, 42, TRI, 600);
  return getBuiltEmbeddedFontFaceCss();
}

/** Extract + base64-decode the first embedded font from the @font-face CSS. */
function decodeFirstFont(css: string): Buffer {
  const m = /data:font\/ttf;base64,([A-Za-z0-9+/=]+)/.exec(css);
  if (m == null) throw new Error("no embedded font data: URI found");
  return Buffer.from(m[1], "base64");
}

describe("embedded-font-builder determinism (DM-902)", () => {
  beforeEach(() => clearEmbeddedFontBuilder());

  it("produces byte-identical @font-face output across builds of the same glyphs", () => {
    // Without the head-timestamp strip, opentype.js stamps the build time into
    // head.created/modified (+ checksums), so two builds of identical glyphs
    // differ — which broke the animate golden suite and reproducible builds.
    const a = buildOnceCss();
    const b = buildOnceCss();
    expect(a).toBe(b);
    expect(a).toContain("data:font/ttf;base64,");
  });

  it("zeroes the head table's created/modified timestamps and checkSumAdjustment", () => {
    const bytes = decodeFirstFont(buildOnceCss());
    // Walk the sfnt table directory to the `head` record.
    const numTables = bytes.readUInt16BE(4);
    let headOff = -1;
    let dirChecksum = -1;
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      if (bytes.toString("ascii", rec, rec + 4) === "head") {
        dirChecksum = bytes.readUInt32BE(rec + 4);
        headOff = bytes.readUInt32BE(rec + 8);
        break;
      }
    }
    expect(headOff).toBeGreaterThan(0);
    expect(dirChecksum).toBe(0);                       // directory per-table head checksum
    expect(bytes.readUInt32BE(headOff + 8)).toBe(0);   // checkSumAdjustment
    // created (8 bytes @ +20) and modified (8 bytes @ +28) all zero.
    for (let o = headOff + 20; o < headOff + 36; o++) expect(bytes[o]).toBe(0);
  });
});

describe("embedded-font-builder glyf output (DM-1666)", () => {
  beforeEach(() => clearEmbeddedFontBuilder());

  it("emits TrueType `glyf` outlines, NOT CFF/`OTTO`", () => {
    // The whole point of the switch: opentype.js CFF (`OTTO`) rendered
    // overlapping contours even-odd in Chrome; glyf (sfnt version 0x00010000)
    // renders nonzero. Guard the flavor so a writer regression can't silently
    // reintroduce the holes.
    const bytes = decodeFirstFont(buildOnceCss());
    expect(bytes.readUInt32BE(0)).toBe(0x00010000); // TrueType sfnt version
    expect(bytes.toString("ascii", 0, 4)).not.toBe("OTTO");
    // A `glyf` (+`loca`) table must be present; a `CFF ` table must not.
    const numTables = bytes.readUInt16BE(4);
    const tags = new Set<string>();
    for (let i = 0; i < numTables; i++) tags.add(bytes.toString("ascii", 12 + i * 16, 16 + i * 16));
    expect(tags.has("glyf")).toBe(true);
    expect(tags.has("loca")).toBe(true);
    expect(tags.has("CFF ")).toBe(false);
  });

  it("round-trips an overlapping-contour glyph with both contours intact", () => {
    clearEmbeddedFontBuilder();
    const placement = trackGlyphInEmbedFont("overlap-test|w=700|s=0", 2048, 1638, -410, 7, OVERLAP_A, 1904);
    expect(placement).not.toBeNull();
    const bytes = decodeFirstFont(getBuiltEmbeddedFontFaceCss());

    const font = fontkit.create(bytes) as unknown as {
      glyphForCodePoint(cp: number): { path: { toSVG(): string }; bbox: { minX: number; minY: number; maxX: number; maxY: number } };
    };
    const glyph = font.glyphForCodePoint(placement!.puaCodepoint);
    const svg = glyph.path.toSVG();
    // Both contours survived the SVG-font → glyf round-trip (2 subpath closes).
    expect((svg.match(/Z/gi) ?? []).length).toBe(2);
    // The outline spans the full "A" cell (not collapsed/empty).
    expect(glyph.bbox.maxY - glyph.bbox.minY).toBeGreaterThan(1900);
    expect(glyph.bbox.maxX - glyph.bbox.minX).toBeGreaterThan(1600);
  });

  it("assigns sequential PUA codepoints so the cmap covers every tracked glyph", () => {
    clearEmbeddedFontBuilder();
    const a = trackGlyphInEmbedFont("cmap-test|w=400|s=0", 1000, 800, -200, 10, TRI, 600);
    const b = trackGlyphInEmbedFont("cmap-test|w=400|s=0", 1000, 800, -200, 11, TRI, 600);
    expect(a!.puaCodepoint).toBe(0xE000);
    expect(b!.puaCodepoint).toBe(0xE001);
    const bytes = decodeFirstFont(getBuiltEmbeddedFontFaceCss());
    const font = fontkit.create(bytes) as unknown as {
      glyphForCodePoint(cp: number): { id: number };
    };
    // Both PUA codepoints resolve to real (non-.notdef) glyphs.
    expect(font.glyphForCodePoint(0xE000).id).toBeGreaterThan(0);
    expect(font.glyphForCodePoint(0xE001).id).toBeGreaterThan(0);
  });
});

describe("embedded-font-builder hinted hb-subset branch (DM-1714/DM-1716)", () => {
  let dir: string;
  let staticPath: string;
  let compositePath: string;
  let variablePath: string;
  let hvglPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "domotion-hinted-test-"));
    staticPath = join(dir, "static-hinted.ttf");
    compositePath = join(dir, "composite-hinted.ttf");
    variablePath = join(dir, "variable-hinted.ttf");
    hvglPath = join(dir, "outline-less-hvgl.ttf");
    writeFileSync(staticPath, buildStaticHintedFont());
    writeFileSync(compositePath, buildStaticHintedFont({ withComposite: true }));
    writeFileSync(variablePath, buildVariableHintedFont());
    const hvgl = Buffer.alloc(32);
    hvgl.writeUInt32BE(0x00010000, 0);
    hvgl.writeUInt16BE(1, 4);
    hvgl.write("hvgl", 12, "latin1");
    hvgl.writeUInt32BE(28, 20);
    hvgl.writeUInt32BE(4, 24);
    writeFileSync(hvglPath, hvgl);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  beforeEach(() => {
    clearEmbeddedFontBuilder();
    process.env.DOMOTION_HINTED_SUBSET = "1";
  });
  afterEach(() => {
    delete process.env.DOMOTION_HINTED_SUBSET;
  });

  function tags(bytes: Buffer): Set<string> {
    const numTables = bytes.readUInt16BE(4);
    const t = new Set<string>();
    for (let i = 0; i < numTables; i++) t.add(bytes.toString("latin1", 12 + i * 16, 16 + i * 16));
    return t;
  }

  it("takes the hinted path for a pure static entry: hinting tables survive, PUA cmap maps to the ORIGINAL outline", () => {
    // glyph id 1 = the synthesized font's "A" rectangle (xMax 550)
    const placement = trackGlyphInEmbedFont("hinted-static|w=400|s=0", 1000, 800, -200, 1, TRI, 600,
      { italic: false, weight: 400, hintedSource: { path: staticPath, faceIndex: 0, variationAxes: null } });
    expect(placement).not.toBeNull();
    const bytes = decodeFirstFont(getBuiltEmbeddedFontFaceCss());
    const t = tags(bytes);
    expect(t.has("fpgm")).toBe(true);
    expect(t.has("prep")).toBe(true);
    expect(t.has("cvt ")).toBe(true);
    // the outline is the SOURCE font's glyph 1 (rect to 550), NOT the tracked
    // TRI outline — proof the subset came from the original file
    const font = fontkit.create(bytes) as unknown as {
      glyphForCodePoint(cp: number): { id: number; bbox: { maxX: number; maxY: number } };
    };
    const g = font.glyphForCodePoint(placement!.puaCodepoint);
    expect(g.id).toBe(1); // RETAIN_GIDS: still the source font's gid
    expect(g.bbox.maxX).toBe(550);
    expect(g.bbox.maxY).toBe(700);
    expect(getEmbeddedFontBuildDiagnostics()).toEqual([expect.objectContaining({
      sourcePath: staticPath, faceIndex: 0, variationAxes: null,
      inputUnitsPerEm: 1000,
      selectedBuilder: "hb-subset", hintedSourceDisqualifiedReasons: [],
      affectedGlyphCount: 1, affectedGlyphOccurrenceCount: 1,
      retainedTableTags: expect.arrayContaining(["cvt ", "fpgm", "glyf", "prep"]),
    })]);
  });

  it("keeps HarfBuzz RETAIN_GIDS identity through the PUA cmap for sparse composite glyphs (DM-2293)", () => {
    // Source gid 3 is composite(A), while gid 2 is deliberately not requested.
    // A private post-subset compactor used to renumber 3 → 2 and reconstruct
    // only the tables it knew about. The consumer contract is instead the one
    // passed to HarfBuzz: retain source ids and point the PUA cmap at those ids.
    const placement = trackGlyphInEmbedFont("hinted-composite|w=400|s=0", 1000, 800, -200, 3, TRI, 600,
      { italic: false, weight: 400, hintedSource: { path: compositePath, faceIndex: 0, variationAxes: null } });
    const bytes = decodeFirstFont(getBuiltEmbeddedFontFaceCss());
    const font = fontkit.create(bytes) as unknown as {
      glyphForCodePoint(cp: number): { id: number; bbox: { minX: number; maxX: number } };
    };
    const glyph = font.glyphForCodePoint(placement!.puaCodepoint);
    expect(glyph.id).toBe(3);
    expect(glyph.bbox.minX).toBeGreaterThanOrEqual(650); // A shifted +600
    expect(glyph.bbox.maxX).toBeGreaterThan(1100);
  });

  it("uses the hinting-preserving path by default and reserves 0 for the control arm", () => {
    delete process.env.DOMOTION_HINTED_SUBSET;
    trackGlyphInEmbedFont("hinted-default|w=400|s=0", 1000, 800, -200, 1, TRI, 600,
      { italic: false, weight: 400, hintedSource: { path: staticPath, faceIndex: 0, variationAxes: null } });
    getBuiltEmbeddedFontFaceCss();
    expect(getEmbeddedFontBuildDiagnostics()[0]).toEqual(expect.objectContaining({
      selectedBuilder: "hb-subset",
      hintedSourceDisqualifiedReasons: [],
    }));

    clearEmbeddedFontBuilder();
    process.env.DOMOTION_HINTED_SUBSET = "0";
    trackGlyphInEmbedFont("hinted-control|w=400|s=0", 1000, 800, -200, 1, TRI, 600,
      { italic: false, weight: 400, hintedSource: { path: staticPath, faceIndex: 0, variationAxes: null } });
    getBuiltEmbeddedFontFaceCss();
    expect(getEmbeddedFontBuildDiagnostics()[0]).toEqual(expect.objectContaining({
      selectedBuilder: "svg2ttf",
      hintedSourceDisqualifiedReasons: ["disabled-by-environment"],
    }));
  });

  it("pins a variable source to the entry's axis location (DM-1716)", () => {
    trackGlyphInEmbedFont("hinted-var|w=900|s=0", 1000, 800, -200, 1, TRI, 700,
      { italic: false, weight: 900, hintedSource: { path: variablePath, faceIndex: 0, variationAxes: { wght: 900 } } });
    const bytes = decodeFirstFont(getBuiltEmbeddedFontFaceCss());
    const t = tags(bytes);
    expect(t.has("fvar")).toBe(false); // fully instanced — consumer can't re-vary
    expect(t.has("prep")).toBe(true);  // hinting survived instancing
    const font = fontkit.create(bytes) as unknown as {
      glyphForCodePoint(cp: number): { bbox: { maxX: number } };
    };
    // gvar delta at wght=900: "A" right edge 550 → 650
    expect(font.glyphForCodePoint(0xE000).bbox.maxX).toBe(650);
  });

  it("finalizes a tracked source gid 0 as a PUA-addressable nonzero glyph (DM-2435)", () => {
    const placement = trackGlyphInEmbedFont("hinted-notdef|w=400|s=0", 1000, 800, -200, 0, TRI, 500,
      { italic: false, weight: 400, hintedSource: { path: staticPath, faceIndex: 0, variationAxes: null } });
    const bytes = decodeFirstFont(getBuiltEmbeddedFontFaceCss());
    const font = fontkit.create(bytes) as unknown as { glyphForCodePoint(cp: number): { id: number; advanceWidth: number } };
    const emitted = font.glyphForCodePoint(placement!.puaCodepoint);
    expect(emitted.id).toBeGreaterThan(0);
    expect(emitted.advanceWidth).toBe(500);
    expect(getEmbeddedFontBuildDiagnostics()[0]).toEqual(expect.objectContaining({ selectedBuilder: "hb-subset" }));
  });

  it("rejects an outline-less hvgl source at the capability boundary and falls back (DM-2435)", () => {
    trackGlyphInEmbedFont("hinted-hvgl|w=400|s=0", 1000, 800, -200, 1, TRI, 600,
      { italic: false, weight: 400, hintedSource: { path: hvglPath, faceIndex: 0, variationAxes: null } });
    const bytes = decodeFirstFont(getBuiltEmbeddedFontFaceCss());
    expect(tags(bytes).has("glyf")).toBe(true); // svg2ttf fallback remains renderable
    expect(getEmbeddedFontBuildDiagnostics()[0]).toEqual(expect.objectContaining({
      selectedBuilder: "svg2ttf",
      hintedSourceDisqualifiedReasons: ["cff-or-subset-failure"],
    }));
  });

  it("retains the hinted source outline when synthetic bold is paint-owned", () => {
    trackGlyphInEmbedFont("hinted-synth|w=700|s=0", 1000, 800, -200, 1, TRI, 600,
      { italic: false, weight: 700, hintedSource: { path: staticPath, faceIndex: 0, variationAxes: null } });
    const bytes = decodeFirstFont(getBuiltEmbeddedFontFaceCss());
    expect(tags(bytes).has("fpgm")).toBe(true);
    expect(getEmbeddedFontBuildDiagnostics()[0]).toEqual(expect.objectContaining({
      selectedBuilder: "hb-subset",
      hintedSourceDisqualifiedReasons: [],
      affectedGlyphCount: 1,
      affectedGlyphOccurrenceCount: 1,
    }));
  });

  it("disqualifies an entry whose glyphs disagree on the axis location", () => {
    const variant = { italic: false, weight: 400 };
    trackGlyphInEmbedFont("hinted-mixed|w=400|s=0", 1000, 800, -200, 1, TRI, 600,
      { ...variant, hintedSource: { path: variablePath, faceIndex: 0, variationAxes: { wght: 400 } } });
    trackGlyphInEmbedFont("hinted-mixed|w=400|s=0", 1000, 800, -200, 2, TRI, 600,
      { ...variant, hintedSource: { path: variablePath, faceIndex: 0, variationAxes: { wght: 700 } } });
    const bytes = decodeFirstFont(getBuiltEmbeddedFontFaceCss());
    expect(tags(bytes).has("fpgm")).toBe(false); // fell back to svg2ttf
  });

  it("hinted output is byte-identical run-to-run (DM-902 determinism holds on this path too)", () => {
    const track = () => {
      clearEmbeddedFontBuilder();
      trackGlyphInEmbedFont("hinted-det|w=400|s=0", 1000, 800, -200, 1, TRI, 600,
        { italic: false, weight: 400, hintedSource: { path: staticPath, faceIndex: 0, variationAxes: null } });
      return getBuiltEmbeddedFontFaceCss();
    };
    expect(track()).toBe(track());
  });

  it("synthesizes an OS/2 table when the source font has none (OTS requires one)", () => {
    // the synthesized test font deliberately carries no OS/2 — like macOS's
    // legacy Courier.ttc, whose missing OS/2 got the whole @font-face rejected
    trackGlyphInEmbedFont("hinted-os2|w=700|s=0", 1000, 800, -200, 1, TRI, 600,
      { italic: false, weight: 700, hintedSource: { path: staticPath, faceIndex: 0, variationAxes: null } });
    const bytes = decodeFirstFont(getBuiltEmbeddedFontFaceCss());
    expect(tags(bytes).has("OS/2")).toBe(true);
    // locate OS/2 and check usWeightClass carries the entry weight
    const numTables = bytes.readUInt16BE(4);
    for (let i = 0; i < numTables; i++) {
      const o = 12 + i * 16;
      if (bytes.toString("latin1", o, o + 4) !== "OS/2") continue;
      const off = bytes.readUInt32BE(o + 8);
      expect(bytes.readUInt16BE(off + 4)).toBe(700); // usWeightClass
    }
  });

  it("stays on svg2ttf when the hinted path is explicitly disabled", () => {
    process.env.DOMOTION_HINTED_SUBSET = "0";
    trackGlyphInEmbedFont("hinted-off|w=400|s=0", 1000, 800, -200, 1, TRI, 600,
      { italic: false, weight: 400, hintedSource: { path: staticPath, faceIndex: 0, variationAxes: null } });
    const bytes = decodeFirstFont(getBuiltEmbeddedFontFaceCss());
    expect(tags(bytes).has("fpgm")).toBe(false);
  });

  // A null faceIndex means "the requested PostScript name is not a member of
  // this file, so no index can be named" — the state a CoreText-resolved face
  // reaches, because CoreText loads named INSTANCES that have no physical member
  // of that name. hb_face_create has no way to express that, and given 0 it
  // would subset member zero: a different face, silently. So the entry must fall
  // back to svg2ttf, which emits the outlines actually extracted.
  it("refuses the hinted path when the source member cannot be named (faceIndex null)", () => {
    trackGlyphInEmbedFont("hinted-unnamed|w=400|s=0", 1000, 800, -200, 1, TRI, 600,
      { italic: false, weight: 400, hintedSource: { path: staticPath, faceIndex: null, variationAxes: null } });
    const bytes = decodeFirstFont(getBuiltEmbeddedFontFaceCss());
    // No hinting tables ⇒ this did NOT come from hb-subset of the source file.
    expect(tags(bytes).has("fpgm")).toBe(false);
    expect(tags(bytes).has("prep")).toBe(false);
    // And the emitted outline is the TRACKED one, not the source font's glyph 1
    // rectangle (xMax 550) — proof no member was subset in its place.
    const font = fontkit.create(bytes) as unknown as {
      glyphForCodePoint(cp: number): { bbox: { maxX: number } };
    };
    expect(font.glyphForCodePoint(0xe000).bbox.maxX).not.toBe(550);
  });

  it("disqualifies an entry when a later glyph's member cannot be named", () => {
    // Mixed sequence: a nameable member establishes the entry, then an
    // unnameable one arrives. The subset's gid↔source identity is broken, so the
    // WHOLE entry must drop to svg2ttf rather than subsetting member zero for
    // the glyphs that had no index.
    const KEY = "hinted-mixed|w=400|s=0";
    trackGlyphInEmbedFont(KEY, 1000, 800, -200, 1, TRI, 600,
      { italic: false, weight: 400, hintedSource: { path: staticPath, faceIndex: 0, variationAxes: null } });
    trackGlyphInEmbedFont(KEY, 1000, 800, -200, 2, TRI, 600,
      { italic: false, weight: 400, hintedSource: { path: staticPath, faceIndex: null, variationAxes: null } });
    const bytes = decodeFirstFont(getBuiltEmbeddedFontFaceCss());
    expect(tags(bytes).has("fpgm")).toBe(false);
  });
});

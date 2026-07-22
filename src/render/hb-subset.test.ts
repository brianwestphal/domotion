// DM-1714/DM-1716: the hinting-preserving embedded subset. These tests run
// against fonts synthesized from scratch (tests/synth-fonts.ts) so they are
// platform-independent (no /System/Library/Fonts dependency) and can assert on
// the EXACT hinting bytecode and gvar deltas being preserved.
import { describe, expect, it } from "vitest";
import * as fkNs from "fontkit";
import { hbSubsetRetainGids, injectPuaCmap, sfntHasSubsettableOutlines } from "./hb-subset.js";
import {
  buildStaticHintedFont,
  buildVariableHintedFont,
  wrapInTtc,
  CVT_CONTENTS,
  FPGM_CONTENTS,
  GLYPH_INSTRUCTIONS,
  PREP_CONTENTS,
} from "./synth-test-fonts.js";

const fontkit = (fkNs as { default?: typeof fkNs }).default ?? fkNs;

/** Table tags of a bare (non-TTC) sfnt. */
function tableTags(buf: Buffer): string[] {
  const n = buf.readUInt16BE(4);
  const tags: string[] = [];
  for (let i = 0; i < n; i++) tags.push(buf.toString("latin1", 12 + i * 16, 12 + i * 16 + 4));
  return tags;
}

/** Raw bytes of a named table. */
function tableBytes(buf: Buffer, tag: string): Buffer | null {
  const n = buf.readUInt16BE(4);
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    if (buf.toString("latin1", o, o + 4) !== tag) continue;
    const off = buf.readUInt32BE(o + 8);
    const len = buf.readUInt32BE(o + 12);
    return buf.subarray(off, off + len);
  }
  return null;
}

/** The instruction bytecode of a simple glyph (short- or long-loca sfnt —
 *  hb-subset may rewrite to short loca when offsets fit). */
function glyphInstructions(buf: Buffer, gid: number): Buffer | null {
  const glyf = tableBytes(buf, "glyf");
  const loca = tableBytes(buf, "loca");
  const head = tableBytes(buf, "head");
  if (glyf == null || loca == null || head == null) return null;
  const longLoca = head.readInt16BE(50) === 1;
  const gOff = longLoca ? loca.readUInt32BE(gid * 4) : loca.readUInt16BE(gid * 2) * 2;
  const gEnd = longLoca ? loca.readUInt32BE((gid + 1) * 4) : loca.readUInt16BE((gid + 1) * 2) * 2;
  if (gEnd <= gOff) return null; // empty glyph
  const nc = glyf.readInt16BE(gOff);
  if (nc <= 0) return null; // composite / empty
  const ilOff = gOff + 10 + nc * 2;
  const il = glyf.readUInt16BE(ilOff);
  return glyf.subarray(ilOff + 2, ilOff + 2 + il);
}

describe("hbSubsetRetainGids (DM-1714)", () => {
  it("keeps the hinting program: cvt/fpgm/prep tables + per-glyph instruction bytecode", () => {
    const out = hbSubsetRetainGids(buildStaticHintedFont(), [1, 2]);
    expect(tableBytes(out, "cvt ")).toEqual(CVT_CONTENTS);
    expect(tableBytes(out, "fpgm")).toEqual(FPGM_CONTENTS);
    expect(tableBytes(out, "prep")).toEqual(PREP_CONTENTS);
    expect(glyphInstructions(out, 1)).toEqual(GLYPH_INSTRUCTIONS);
    expect(glyphInstructions(out, 2)).toEqual(GLYPH_INSTRUCTIONS);
  });

  it("keepHinting=false strips the hinting program (the NO_HINTING flag works)", () => {
    const out = hbSubsetRetainGids(buildStaticHintedFont(), [1, 2], 0, false);
    const tags = tableTags(out);
    expect(tags).not.toContain("fpgm");
    expect(tags).not.toContain("prep");
    const instr = glyphInstructions(out, 1);
    expect(instr == null || instr.length === 0).toBe(true);
  });

  it("retains original glyph ids and outlines (RETAIN_GIDS)", () => {
    const out = hbSubsetRetainGids(buildStaticHintedFont(), [2]); // subset to just "B"
    const f = fontkit.create(out);
    // gid 2 is still gid 2 in the subset — the outline is B's rectangle
    const g = f.getGlyph(2);
    expect(g.bbox.maxX).toBe(550);
    expect(g.bbox.maxY).toBe(700);
  });

  it("selects the requested TTC member via faceIndex", () => {
    const ttc = wrapInTtc([
      buildStaticHintedFont(),
      buildStaticHintedFont({ family: "SynthWide", aXMax: 900 }),
    ]);
    const narrow = fontkit.create(hbSubsetRetainGids(ttc, [1], 0));
    const wide = fontkit.create(hbSubsetRetainGids(ttc, [1], 1));
    expect(narrow.getGlyph(1).bbox.maxX).toBe(550);
    expect(wide.getGlyph(1).bbox.maxX).toBe(900);
  });
});

describe("hbSubsetRetainGids variable-axis instancing (DM-1716)", () => {
  it("pins axes to the requested location — outlines match fontkit's getVariation", () => {
    const vf = buildVariableHintedFont();
    const out = hbSubsetRetainGids(vf, [1, 2], 0, true, { wght: 900 });
    const f = fontkit.create(out);
    // gvar deltas at wght=900: A's right edge +100, B's +200
    expect(f.getGlyph(1).bbox.maxX).toBe(650);
    expect(f.getGlyph(2).bbox.maxX).toBe(750);
    // and fontkit agrees (same deltas applied by an independent implementation)
    const ref = fontkit.create(vf).getVariation({ wght: 900 });
    expect(ref.getGlyph(1).bbox.maxX).toBe(650);
    expect(ref.getGlyph(2).bbox.maxX).toBe(750);
  });

  it("emits a fully static font (fvar/gvar dropped) so the consumer browser cannot re-vary axes", () => {
    const out = hbSubsetRetainGids(buildVariableHintedFont(), [1], 0, true, { wght: 900 });
    const tags = tableTags(out);
    expect(tags).not.toContain("fvar");
    expect(tags).not.toContain("gvar");
  });

  it("hinting survives instancing", () => {
    const out = hbSubsetRetainGids(buildVariableHintedFont(), [1], 0, true, { wght: 900 });
    expect(tableBytes(out, "prep")).toEqual(PREP_CONTENTS);
    expect(tableBytes(out, "fpgm")).toEqual(FPGM_CONTENTS);
    expect(glyphInstructions(out, 1)).toEqual(GLYPH_INSTRUCTIONS);
  });

  it("an empty pin location instances at the default master", () => {
    const out = hbSubsetRetainGids(buildVariableHintedFont(), [1, 2], 0, true, {});
    const f = fontkit.create(out);
    expect(f.getGlyph(1).bbox.maxX).toBe(550); // default outline, no deltas
    expect(tableTags(out)).not.toContain("fvar");
  });

  it("throws when a requested axis cannot be pinned (caller falls back to svg2ttf)", () => {
    expect(() => hbSubsetRetainGids(buildVariableHintedFont(), [1], 0, true, { XXXX: 5 })).toThrow(/pin_axis_location/);
  });
});

describe("injectPuaCmap (DM-1714)", () => {
  it("round-trips PUA→gid via fontkit and replaces the original cmap", () => {
    const subset = hbSubsetRetainGids(buildStaticHintedFont(), [1, 2]);
    const out = injectPuaCmap(subset, new Map([[0xe000, 1], [0xe001, 2]]));
    const f = fontkit.create(out);
    expect(f.glyphForCodePoint(0xe000).id).toBe(1);
    expect(f.glyphForCodePoint(0xe001).id).toBe(2);
    // the ORIGINAL codepoints no longer map — the PUA cmap replaced them
    expect(f.glyphForCodePoint(0x41).id).toBe(0);
  });

  it("handles non-contiguous gids and astral PUA-B codepoints", () => {
    const subset = hbSubsetRetainGids(buildStaticHintedFont(), [1, 2]);
    const out = injectPuaCmap(subset, new Map([[0xe000, 2], [0x100000, 1]]));
    const f = fontkit.create(out);
    expect(f.glyphForCodePoint(0xe000).id).toBe(2);
    expect(f.glyphForCodePoint(0x100000).id).toBe(1);
  });
});

describe("sfntHasSubsettableOutlines (DM-1714)", () => {
  it("accepts glyf-flavored sfnts", () => {
    expect(sfntHasSubsettableOutlines(buildStaticHintedFont())).toBe(true);
  });

  it("rejects an outline-less face (e.g. Apple-private hvgl outlines)", () => {
    // minimal sfnt directory whose only table is `hvgl`
    const dir = Buffer.alloc(12 + 16 + 4);
    dir.writeUInt32BE(0x00010000, 0);
    dir.writeUInt16BE(1, 4);
    dir.write("hvgl", 12, "latin1");
    dir.writeUInt32BE(28, 20); // offset
    dir.writeUInt32BE(4, 24); // length
    expect(sfntHasSubsettableOutlines(dir)).toBe(false);
  });

  it("is TTC-aware: checks the requested member's table directory", () => {
    const ttc = wrapInTtc([buildStaticHintedFont(), buildStaticHintedFont({ family: "SynthWide" })]);
    expect(sfntHasSubsettableOutlines(ttc, 0)).toBe(true);
    expect(sfntHasSubsettableOutlines(ttc, 1)).toBe(true);
  });
});

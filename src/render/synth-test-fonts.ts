// DM-1716: deterministic, from-scratch test fonts for the hinting-preserving
// embedded-subset unit tests (hb-subset.test.ts and the hinted branch of
// embedded-font-builder.test.ts).
//
// Why synthesize instead of committing binaries: the tests must run on every
// platform's vitest CI (no `/System/Library/Fonts` dependency), the assertions
// need EXACT knowledge of the hinting bytecode and gvar deltas being preserved,
// and a hand-built font carries no third-party license obligations. Everything
// below is plain sfnt table construction — nothing executes the TrueType
// instructions; the tests only assert the bytes survive subsetting.
//
// `buildStaticHintedFont()` — a 3-glyph TrueType font (.notdef, "A", "B" —
// both simple rectangles) carrying a full hinting program: `cvt `/`fpgm`/`prep`
// tables plus per-glyph instruction bytecode with known contents.
//
// `buildVariableHintedFont()` — the same font plus `fvar` (one `wght` axis,
// min 100 / default 400 / max 900) and `gvar` (at wght=900 the "A" rectangle's
// right edge and advance move +100 units; "B" moves +200). Pinning `wght` must
// bake those deltas into the static outline.
//
// `wrapInTtc()` — wraps any sfnts into a `ttcf` collection (rebasing each
// member's table offsets) for faceIndex-selection tests.

/** Per-glyph TrueType instruction bytecode used by the synthesized fonts:
 *  PUSHB[0] 1, POP — trivially valid, and a distinctive 3-byte signature the
 *  tests can assert survives subsetting. */
export const GLYPH_INSTRUCTIONS = Buffer.from([0xb0, 0x01, 0x21]);
/** `fpgm` contents: PUSHB[0] 0, FDEF, ENDF. */
export const FPGM_CONTENTS = Buffer.from([0xb0, 0x00, 0x2c, 0x2d]);
/** `prep` contents: PUSHB[0] 0, POP. */
export const PREP_CONTENTS = Buffer.from([0xb0, 0x00, 0x21]);
/** `cvt ` contents: four FWORD control values. */
export const CVT_CONTENTS = Buffer.from([0x00, 0x32, 0x00, 0x64, 0x00, 0xc8, 0x01, 0x90]);

const UPEM = 1000;

function pad4(n: number): number { return (n + 3) & ~3; }

function tableChecksum(buf: Buffer): number {
  let s = 0;
  for (let i = 0; i < buf.length; i += 4) {
    let v = 0;
    for (let j = 0; j < 4; j++) v = ((v << 8) | (i + j < buf.length ? buf[i + j] : 0)) >>> 0;
    s = (s + v) >>> 0;
  }
  return s >>> 0;
}

/** Assemble an sfnt from named tables (sorted tag order, padded, checksummed,
 *  `head.checkSumAdjustment` recomputed). */
export function buildSfnt(tables: Record<string, Buffer>): Buffer {
  const tags = Object.keys(tables).sort();
  const n = tags.length;
  const dirLen = 12 + n * 16;
  const dir = Buffer.alloc(dirLen);
  dir.writeUInt32BE(0x00010000, 0); // TrueType sfnt version
  dir.writeUInt16BE(n, 4);
  const es = Math.floor(Math.log2(n));
  const sr = (1 << es) * 16;
  dir.writeUInt16BE(sr, 6); dir.writeUInt16BE(es, 8); dir.writeUInt16BE(n * 16 - sr, 10);
  const body: Buffer[] = [];
  let off = dirLen;
  let di = 12;
  for (const tag of tags) {
    const b = tables[tag];
    const padded = Buffer.concat([b, Buffer.alloc(pad4(b.length) - b.length)]);
    dir.write(tag, di, "latin1");
    dir.writeUInt32BE(tableChecksum(padded), di + 4);
    dir.writeUInt32BE(off, di + 8);
    dir.writeUInt32BE(b.length, di + 12);
    di += 16;
    body.push(padded);
    off += padded.length;
  }
  const font = Buffer.concat([dir, ...body]);
  // head.checkSumAdjustment = 0xB1B0AFBA − checksum(whole font with adj zeroed)
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    if (font.toString("latin1", o, o + 4) === "head") {
      const headOff = font.readUInt32BE(o + 8);
      font.writeUInt32BE(0, headOff + 8);
      font.writeUInt32BE((0xb1b0afba - tableChecksum(font)) >>> 0, headOff + 8);
      break;
    }
  }
  return font;
}

/** A simple one-contour rectangle glyph with the standard 3-byte instruction
 *  signature. Points: (xMin,0) (xMax,0) (xMax,700) (xMin,700), all on-curve,
 *  16-bit coordinate deltas. */
function rectGlyph(xMin: number, xMax: number): Buffer {
  const yMin = 0, yMax = 700;
  const head = Buffer.alloc(10);
  head.writeInt16BE(1, 0); // numberOfContours
  head.writeInt16BE(xMin, 2); head.writeInt16BE(yMin, 4);
  head.writeInt16BE(xMax, 6); head.writeInt16BE(yMax, 8);
  const endPts = Buffer.alloc(2); endPts.writeUInt16BE(3, 0);
  const instrLen = Buffer.alloc(2); instrLen.writeUInt16BE(GLYPH_INSTRUCTIONS.length, 0);
  const flags = Buffer.from([0x01, 0x01, 0x01, 0x01]); // 4 on-curve points, long coords
  const xs = Buffer.alloc(8);
  const dxs = [xMin, xMax - xMin, 0, -(xMax - xMin)];
  dxs.forEach((d, i) => xs.writeInt16BE(d, i * 2));
  const ys = Buffer.alloc(8);
  const dys = [0, 0, 700, 0];
  dys.forEach((d, i) => ys.writeInt16BE(d, i * 2));
  const g = Buffer.concat([head, endPts, instrLen, GLYPH_INSTRUCTIONS, flags, xs, ys]);
  // glyf entries must be 2-byte aligned (short loca stores offset/2; we use
  // long loca, but keep alignment anyway for well-formedness)
  return g.length % 2 === 0 ? g : Buffer.concat([g, Buffer.alloc(1)]);
}

interface SynthOptions {
  /** Font family (name table). Default "SynthHinted". */
  family?: string;
  /** Right edge of the "A" rectangle. Default 550 (advance 600). */
  aXMax?: number;
  /** Extra name records, e.g. the fvar axis name (fontkit requires a
   *  nameID ≥ 256 record to exist before it will decode fvar axis names). */
  extraNameRecords?: Array<[number, string]>;
  /** Add a 4th glyph: gid 3 = a COMPOSITE referencing gid 1 ("A") shifted
   *  +600 x, carrying the standard instruction bytecode, mapped from "C".
   *  For the gid-compaction tests (component walking + id rewriting). */
  withComposite?: boolean;
}

/** Core tables shared by the static and variable synthesized fonts. */
function coreTables(opts: SynthOptions = {}): Record<string, Buffer> {
  const family = opts.family ?? "SynthHinted";
  const aXMax = opts.aXMax ?? 550;
  const numGlyphs = opts.withComposite ? 4 : 3; // .notdef (empty), A, B [, composite-of-A]

  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00010000, 0);      // version 1.0
  head.writeUInt32BE(0x00010000, 4);      // fontRevision
  head.writeUInt32BE(0, 8);               // checkSumAdjustment (patched in buildSfnt)
  head.writeUInt32BE(0x5f0f3cf5, 12);     // magicNumber
  head.writeUInt16BE(0, 16);              // flags
  head.writeUInt16BE(UPEM, 18);           // unitsPerEm
  // created/modified stay zero (deterministic)
  head.writeInt16BE(50, 36);              // xMin
  head.writeInt16BE(0, 38);               // yMin
  head.writeInt16BE(Math.max(aXMax, 550), 40); // xMax
  head.writeInt16BE(700, 42);             // yMax
  head.writeUInt16BE(0, 44);              // macStyle
  head.writeUInt16BE(8, 46);              // lowestRecPPEM
  head.writeInt16BE(2, 48);               // fontDirectionHint
  head.writeInt16BE(1, 50);               // indexToLocFormat: long
  head.writeInt16BE(0, 52);               // glyphDataFormat

  const hhea = Buffer.alloc(36);
  hhea.writeUInt32BE(0x00010000, 0);
  hhea.writeInt16BE(800, 4);              // ascender
  hhea.writeInt16BE(-200, 6);             // descender
  hhea.writeInt16BE(0, 8);                // lineGap
  hhea.writeUInt16BE(700, 10);            // advanceWidthMax
  hhea.writeInt16BE(50, 12);              // minLeftSideBearing
  hhea.writeInt16BE(50, 14);              // minRightSideBearing
  hhea.writeInt16BE(Math.max(aXMax, 550), 16); // xMaxExtent
  hhea.writeInt16BE(1, 18);               // caretSlopeRise
  hhea.writeInt16BE(0, 20);               // caretSlopeRun
  // caretOffset + 4 reserved stay zero
  hhea.writeInt16BE(0, 32);               // metricDataFormat
  hhea.writeUInt16BE(numGlyphs, 34);      // numberOfHMetrics

  const maxp = Buffer.alloc(32);
  maxp.writeUInt32BE(0x00010000, 0);
  maxp.writeUInt16BE(numGlyphs, 4);
  maxp.writeUInt16BE(4, 6);               // maxPoints
  maxp.writeUInt16BE(1, 8);               // maxContours
  maxp.writeUInt16BE(0, 10); maxp.writeUInt16BE(0, 12); // composite
  maxp.writeUInt16BE(2, 14);              // maxZones
  maxp.writeUInt16BE(4, 16);              // maxTwilightPoints
  maxp.writeUInt16BE(4, 18);              // maxStorage
  maxp.writeUInt16BE(4, 20);              // maxFunctionDefs
  maxp.writeUInt16BE(0, 22);              // maxInstructionDefs
  maxp.writeUInt16BE(64, 24);             // maxStackElements
  maxp.writeUInt16BE(32, 26);             // maxSizeOfInstructions
  // maxComponentElements / Depth stay zero

  const hmtx = Buffer.alloc(numGlyphs * 4);
  const advances = [500, aXMax + 50, 600, 1200];
  const lsbs = [0, 50, 50, 650];
  for (let i = 0; i < numGlyphs; i++) { hmtx.writeUInt16BE(advances[i], i * 4); hmtx.writeInt16BE(lsbs[i], i * 4 + 2); }

  // glyf + long loca: gid0 empty, gid1 "A" rect, gid2 "B" rect
  // [, gid3 composite: gid1 shifted +600 x, with instruction bytecode]
  const gA = rectGlyph(50, aXMax);
  const gB = rectGlyph(50, 550);
  const glyphs: Buffer[] = [gA, gB];
  if (opts.withComposite) {
    const comp = Buffer.alloc(10 + 8 + 2 + GLYPH_INSTRUCTIONS.length);
    comp.writeInt16BE(-1, 0);             // numberOfContours: composite
    comp.writeInt16BE(650, 2); comp.writeInt16BE(0, 4);           // bbox
    comp.writeInt16BE(aXMax + 600, 6); comp.writeInt16BE(700, 8);
    comp.writeUInt16BE(0x0001 | 0x0002 | 0x0100, 10); // WORDS | XY_VALUES | INSTRUCTIONS
    comp.writeUInt16BE(1, 12);            // component: gid 1
    comp.writeInt16BE(600, 14);           // dx
    comp.writeInt16BE(0, 16);             // dy
    comp.writeUInt16BE(GLYPH_INSTRUCTIONS.length, 18);
    GLYPH_INSTRUCTIONS.copy(comp, 20);
    glyphs.push(comp.length % 2 === 0 ? comp : Buffer.concat([comp, Buffer.alloc(1)]));
  }
  const glyf = Buffer.concat(glyphs);
  const loca = Buffer.alloc((numGlyphs + 1) * 4);
  loca.writeUInt32BE(0, 0);               // .notdef: zero length
  loca.writeUInt32BE(0, 4);
  let acc = 0;
  glyphs.forEach((g, i) => { acc += g.length; loca.writeUInt32BE(acc, (i + 2) * 4); });

  // cmap: format 4, 'A'(0x41)→gid1, 'B'(0x42)→gid2 [, 'C'(0x43)→gid3]
  const lastCp = opts.withComposite ? 0x43 : 0x42;
  const segCount = 2; // [0x41..lastCp], [0xFFFF terminator]
  const sub = Buffer.alloc(16 + segCount * 8);
  sub.writeUInt16BE(4, 0);                // format
  sub.writeUInt16BE(sub.length, 2);
  sub.writeUInt16BE(0, 4);                // language
  sub.writeUInt16BE(segCount * 2, 6);     // segCountX2
  sub.writeUInt16BE(2, 8);                // searchRange
  sub.writeUInt16BE(1, 10);               // entrySelector
  sub.writeUInt16BE(2, 12);               // rangeShift
  let p = 14;
  sub.writeUInt16BE(lastCp, p); sub.writeUInt16BE(0xffff, p + 2); p += 4; // endCodes
  p += 2;                                   // reservedPad
  sub.writeUInt16BE(0x41, p); sub.writeUInt16BE(0xffff, p + 2); p += 4; // startCodes
  sub.writeInt16BE(1 - 0x41, p); sub.writeInt16BE(1, p + 2); p += 4;    // idDelta (gid1 at 0x41; 0xFFFF maps to gid0)
  sub.writeUInt16BE(0, p); sub.writeUInt16BE(0, p + 2);                 // idRangeOffsets
  const cmapHdr = Buffer.alloc(12);
  cmapHdr.writeUInt16BE(0, 0); cmapHdr.writeUInt16BE(1, 2);
  cmapHdr.writeUInt16BE(3, 4); cmapHdr.writeUInt16BE(1, 6);  // (3,1) Windows BMP
  cmapHdr.writeUInt32BE(12, 8);
  const cmap = Buffer.concat([cmapHdr, sub]);

  const post = Buffer.alloc(32);
  post.writeUInt32BE(0x00030000, 0);      // version 3.0 (no glyph names)
  post.writeInt16BE(-75, 8);              // underlinePosition
  post.writeInt16BE(50, 10);              // underlineThickness

  // name: family(1), subfamily(2), full(4), postscript(6) — Windows (3,1) en-US
  const nameRecords: Array<[number, string]> = [
    [1, family], [2, "Regular"], [4, family], [6, family.replace(/\s+/g, "")],
    ...(opts.extraNameRecords ?? []),
  ];
  const strs = nameRecords.map(([, s]) => Buffer.from(s, "utf16le").swap16());
  const nameHdr = Buffer.alloc(6 + nameRecords.length * 12);
  nameHdr.writeUInt16BE(0, 0);
  nameHdr.writeUInt16BE(nameRecords.length, 2);
  nameHdr.writeUInt16BE(6 + nameRecords.length * 12, 4);
  let strOff = 0;
  nameRecords.forEach(([id], i) => {
    const o = 6 + i * 12;
    nameHdr.writeUInt16BE(3, o);          // platformID
    nameHdr.writeUInt16BE(1, o + 2);      // encodingID
    nameHdr.writeUInt16BE(0x409, o + 4);  // languageID en-US
    nameHdr.writeUInt16BE(id, o + 6);
    nameHdr.writeUInt16BE(strs[i].length, o + 8);
    nameHdr.writeUInt16BE(strOff, o + 10);
    strOff += strs[i].length;
  });
  const name = Buffer.concat([nameHdr, ...strs]);

  return {
    head, hhea, maxp, hmtx, glyf, loca, cmap, post, name,
    "cvt ": Buffer.from(CVT_CONTENTS),
    fpgm: Buffer.from(FPGM_CONTENTS),
    prep: Buffer.from(PREP_CONTENTS),
  };
}

/** Static hinted TrueType font: .notdef + "A" + "B" rectangles, cvt/fpgm/prep
 *  + per-glyph instructions. */
export function buildStaticHintedFont(opts: SynthOptions = {}): Buffer {
  return buildSfnt(coreTables(opts));
}

/** The static font plus a `wght` variation axis (100..400..900). gvar deltas
 *  at wght=900 (normalized +1.0): "A" right edge/advance +100 units, "B" +200.
 *  Pinning wght=900 must bake those into the outline; wght=650 → half. */
export function buildVariableHintedFont(opts: SynthOptions = {}): Buffer {
  const tables = coreTables({
    ...opts,
    // fontkit only decodes fvar axis names when a nameID ≥ 256 record exists
    // (its `records.fontFeatures` group) — provide the wght axis name.
    extraNameRecords: [...(opts.extraNameRecords ?? []), [256, "Weight"]],
  });

  // fvar: one axis, no named instances
  const fvar = Buffer.alloc(16 + 20);
  fvar.writeUInt16BE(1, 0); fvar.writeUInt16BE(0, 2);   // version 1.0
  fvar.writeUInt16BE(16, 4);                            // axesArrayOffset
  fvar.writeUInt16BE(2, 6);                             // reserved
  fvar.writeUInt16BE(1, 8);                             // axisCount
  fvar.writeUInt16BE(20, 10);                           // axisSize
  fvar.writeUInt16BE(0, 12);                            // instanceCount
  fvar.writeUInt16BE(8, 14);                            // instanceSize
  fvar.write("wght", 16, "latin1");
  fvar.writeInt32BE(100 << 16, 20);                     // min 100.0
  fvar.writeInt32BE(400 << 16, 24);                     // default 400.0
  fvar.writeInt32BE(900 << 16, 28);                     // max 900.0
  fvar.writeUInt16BE(0, 32);                            // flags
  fvar.writeUInt16BE(256, 34);                          // axisNameID
  tables.fvar = fvar;

  // gvar: per-glyph tuple variation data with one embedded-peak tuple at
  // wght=+1.0, private "all points" numbers, byte-packed X deltas, zero Y.
  const glyphVarData = (dx: number): Buffer => {
    // serialized data: point numbers (0x00 = all points) + packed deltas.
    // All points = 4 glyph points + 4 phantom points = 8 deltas per axis.
    // X: [0, dx, dx, 0] for the rect + [0, dx, 0, 0] for the phantoms
    // (advance-width phantom moves with the right edge). Y: all zero.
    // Deltas are packed as int16 words (control 0x40 | count−1) so dx > 127
    // round-trips — byte-packed deltas are SIGNED int8.
    const xDeltas = [0, dx, dx, 0, 0, dx, 0, 0];
    const xPacked = Buffer.alloc(1 + xDeltas.length * 2);
    xPacked.writeUInt8(0x40 | (xDeltas.length - 1), 0);
    xDeltas.forEach((d, i) => xPacked.writeInt16BE(d, 1 + i * 2));
    const serialized = Buffer.concat([
      Buffer.from([0x00]),                              // point numbers: all
      xPacked,                                          // X: 8 word-size deltas
      Buffer.from([0x87]),                              // Y: 8 zero deltas
    ]);
    const hdr = Buffer.alloc(4 + 4 + 2);
    hdr.writeUInt16BE(1, 0);                            // tupleVariationCount
    hdr.writeUInt16BE(hdr.length, 2);                   // offset to serialized data
    hdr.writeUInt16BE(serialized.length, 4);            // variationDataSize
    hdr.writeUInt16BE(0x8000 | 0x2000, 6);              // EMBEDDED_PEAK | PRIVATE_POINTS
    hdr.writeInt16BE(0x4000, 8);                        // peak tuple: wght = +1.0 (F2DOT14)
    const data = Buffer.concat([hdr, serialized]);
    return data.length % 2 === 0 ? data : Buffer.concat([data, Buffer.alloc(1)]);
  };
  const gA = glyphVarData(100);
  const gB = glyphVarData(200);
  const gvarHdr = Buffer.alloc(20 + 4 * 4);             // header + (glyphCount+1) long offsets
  gvarHdr.writeUInt16BE(1, 0); gvarHdr.writeUInt16BE(0, 2); // version 1.0
  gvarHdr.writeUInt16BE(1, 4);                          // axisCount
  gvarHdr.writeUInt16BE(0, 6);                          // sharedTupleCount
  gvarHdr.writeUInt32BE(20 + 4 * 4, 8);                 // sharedTuplesOffset (empty, points at data)
  gvarHdr.writeUInt16BE(3, 12);                         // glyphCount
  gvarHdr.writeUInt16BE(1, 14);                         // flags: long offsets
  gvarHdr.writeUInt32BE(20 + 4 * 4, 16);                // glyphVariationDataArrayOffset
  gvarHdr.writeUInt32BE(0, 20);                         // gid0: empty
  gvarHdr.writeUInt32BE(0, 24);
  gvarHdr.writeUInt32BE(gA.length, 28);
  gvarHdr.writeUInt32BE(gA.length + gB.length, 32);
  tables.gvar = Buffer.concat([gvarHdr, gA, gB]);

  return buildSfnt(tables);
}

/** Wrap sfnts into a `ttcf` collection, rebasing each member's table-record
 *  offsets to their position in the collection file. */
export function wrapInTtc(fonts: Buffer[]): Buffer {
  const headerLen = 12 + fonts.length * 4;
  const header = Buffer.alloc(headerLen);
  header.write("ttcf", 0, "latin1");
  header.writeUInt16BE(1, 4); header.writeUInt16BE(0, 6); // version 1.0
  header.writeUInt32BE(fonts.length, 8);
  const rebased: Buffer[] = [];
  let base = headerLen;
  fonts.forEach((f, i) => {
    header.writeUInt32BE(base, 12 + i * 4);
    const copy = Buffer.from(f);
    const numTables = copy.readUInt16BE(4);
    for (let t = 0; t < numTables; t++) {
      const o = 12 + t * 16;
      copy.writeUInt32BE(copy.readUInt32BE(o + 8) + base, o + 8);
    }
    rebased.push(copy);
    base += copy.length;
  });
  return Buffer.concat([header, ...rebased]);
}

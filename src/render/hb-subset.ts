// DM-1714 (spike): hinting-preserving embedded-font subset via harfbuzz's
// hb-subset (ships as `harfbuzz-subset.wasm` inside the harfbuzzjs dep).
//
// The default embedded-font path builds the glyph subset with svg2ttf, which
// writes `glyf` from OUTLINES ONLY — no TrueType hinting program. On Windows
// (DirectWrite/ClearType) and Linux (FreeType) the consumer browser renders the
// unhinted subset without grid-fitting, so it diverges from Chrome's HTML (which
// uses the original hinted font) — the documented per-platform "hinting floor".
//
// hb-subset preserves hinting by default (dropping it is the opt-in NO_HINTING
// flag) and keeps `cvt`/`fpgm`/`prep` + per-glyph instructions + `gasp`/`hdmx`.
// We subset with RETAIN_GIDS (so glyph ids stay = the original font's ids, which
// the embedded builder already tracks), then REPLACE the cmap with one mapping
// Domotion's private-use codepoints → those gids — so the rest of the embedded
// pipeline (PUA `<text>`, explicit per-glyph x) is unchanged; only the glyph
// bytes gain hinting.
//
// This is behind the `DOMOTION_HINTED_SUBSET` flag while we measure the payoff.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const HB_MEMORY_MODE_READONLY = 1;
const HB_SUBSET_FLAGS_NO_HINTING = 0x01;
const HB_SUBSET_FLAGS_RETAIN_GIDS = 0x02;
/** Keep the `.notdef` glyph's OUTLINE (hb-subset empties it by default). The
 *  embedded pipeline renders the primary font's notdef box for uncovered
 *  codepoints, so the box outline must survive the subset. */
const HB_SUBSET_FLAGS_NOTDEF_OUTLINE = 0x40;

interface HbSubsetExports {
  memory: WebAssembly.Memory;
  malloc(n: number): number;
  free(p: number): void;
  hb_blob_create(dataPtr: number, len: number, mode: number, userData: number, destroy: number): number;
  hb_blob_destroy(p: number): void;
  hb_blob_get_length(p: number): number;
  hb_blob_get_data(p: number, lenPtr: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(p: number): void;
  hb_face_reference_blob(p: number): number;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(p: number): void;
  hb_subset_input_glyph_set(input: number): number;
  hb_subset_input_set_flags(input: number, flags: number): void;
  hb_set_add(set: number, cp: number): void;
  hb_subset_or_fail(face: number, input: number): number;
  /** Pin every variation axis to its default (full instancing). Returns 0 on a
   *  non-variable face (harmless no-op — the subset still succeeds). */
  hb_subset_input_pin_all_axes_to_default(input: number, face: number): number;
  /** Pin one axis to a specific value (overrides a prior pin_all default for
   *  that tag). Returns 0 when the face doesn't expose the axis. */
  hb_subset_input_pin_axis_location(input: number, face: number, axisTag: number, value: number): number;
}

/** Big-endian 4-char OpenType tag as uint32 (hb_tag_t). */
function hbTag(tag: string): number {
  return ((tag.charCodeAt(0) << 24) | (tag.charCodeAt(1) << 16) | (tag.charCodeAt(2) << 8) | tag.charCodeAt(3)) >>> 0;
}

let cachedExports: HbSubsetExports | null = null;
function hb(): HbSubsetExports {
  if (cachedExports != null) return cachedExports;
  const require = createRequire(import.meta.url);
  // harfbuzzjs's `exports` map only exposes ".", so the wasm subpath can't be
  // require.resolve'd directly — resolve the package entry and join to its dist.
  const wasmPath = join(dirname(require.resolve("harfbuzzjs")), "harfbuzz-subset.wasm");
  const mod = new WebAssembly.Module(readFileSync(wasmPath));
  const inst = new WebAssembly.Instance(mod, {});
  cachedExports = inst.exports as unknown as HbSubsetExports;
  return cachedExports;
}

/** hb-subset `fontBytes` to `gids` (original glyph ids), keeping hinting +
 *  RETAIN_GIDS so the output's glyph ids equal the input's. `faceIndex` selects
 *  a TTC member. Returns the subset TTF/OTF bytes (still has the ORIGINAL cmap;
 *  call `injectPuaCmap` to remap to private-use codepoints).
 *
 *  `pinAxes` (non-null ⇒ the source is a VARIABLE font): fully instance the
 *  face at that axis location — every axis is pinned to its default, then each
 *  `pinAxes` entry overrides its tag — so the output is a STATIC font whose
 *  outlines match what the run shaped with (fontkit `getVariation` and hb apply
 *  the same gvar deltas), with `fvar`/`gvar` dropped. Full pinning is
 *  deliberate: leaving any axis variable would let the consumer browser re-vary
 *  it (e.g. `font-optical-sizing: auto` re-applying `opsz`) on top of outlines
 *  we already resolved. hb's instancer RETAINS the hinting program
 *  (`cvt`/`fpgm`/`prep` + per-glyph instructions) across instancing. An empty
 *  object pins everything to defaults (the run shaped with the default master).
 *  Throws when a requested axis can't be pinned — outlines would silently be
 *  the wrong master; the caller falls back to svg2ttf, which bakes the correct
 *  instantiated outline (unhinted). */
export function hbSubsetRetainGids(fontBytes: Buffer, gids: number[], faceIndex = 0, keepHinting = true, pinAxes: Record<string, number> | null = null): Buffer {
  const w = hb();
  const heap = (): Uint8Array => new Uint8Array(w.memory.buffer);
  const fontPtr = w.malloc(fontBytes.length);
  heap().set(fontBytes, fontPtr);
  const blob = w.hb_blob_create(fontPtr, fontBytes.length, HB_MEMORY_MODE_READONLY, 0, 0);
  const face = w.hb_face_create(blob, faceIndex);
  const input = w.hb_subset_input_create_or_fail();
  const gset = w.hb_subset_input_glyph_set(input);
  for (const g of gids) w.hb_set_add(gset, g);
  let flags = HB_SUBSET_FLAGS_RETAIN_GIDS | HB_SUBSET_FLAGS_NOTDEF_OUTLINE;
  if (!keepHinting) flags |= HB_SUBSET_FLAGS_NO_HINTING;
  w.hb_subset_input_set_flags(input, flags);
  if (pinAxes != null) {
    if (w.hb_subset_input_pin_all_axes_to_default(input, face) === 0) {
      cleanupInput();
      throw new Error("pin_all_axes_to_default failed (face reports no variation axes?)");
    }
    for (const [tag, value] of Object.entries(pinAxes)) {
      if (w.hb_subset_input_pin_axis_location(input, face, hbTag(tag), value) === 0) {
        cleanupInput();
        throw new Error(`pin_axis_location failed for axis "${tag}"`);
      }
    }
  }
  function cleanupInput(): void {
    w.hb_subset_input_destroy(input);
    w.hb_face_destroy(face);
    w.hb_blob_destroy(blob);
    w.free(fontPtr);
  }
  const rface = w.hb_subset_or_fail(face, input);
  try {
    if (rface === 0) throw new Error("hb_subset_or_fail returned null");
    const outBlob = w.hb_face_reference_blob(rface);
    const len = w.hb_blob_get_length(outBlob);
    const dataPtr = w.hb_blob_get_data(outBlob, 0);
    const out = Buffer.from(heap().slice(dataPtr, dataPtr + len));
    w.hb_blob_destroy(outBlob);
    // Defense in depth: this wasm build silently DROPS tables it can't subset
    // (observed: `CFF ` on macOS OTTO faces). An outline-less "subset" parses in
    // fontkit but fails the consumer browser's OTS sanitizer — every glyph of
    // the @font-face tofu-boxes. Throw instead so the caller falls back to
    // svg2ttf.
    if (!sfntHasOutlineTable(out)) throw new Error("subset output has no outline table (glyf/CFF dropped by hb-subset)");
    return out;
  } finally {
    if (rface !== 0) w.hb_face_destroy(rface);
    w.hb_subset_input_destroy(input);
    w.hb_face_destroy(face);
    w.hb_blob_destroy(blob);
    w.free(fontPtr);
  }
}

/** True when the face carries TrueType `glyf` outlines — the only flavor the
 *  hinted-subset path accepts.
 *
 *  CFF/CFF2 (`OTTO`) faces are deliberately EXCLUDED even though hb-subset can
 *  nominally subset them: the harfbuzz-subset.wasm build bundled in harfbuzzjs
 *  silently DROPS the `CFF ` table (verified on macOS ITFDevanagari.ttc — the
 *  "subset" came back with no outline table at all, which Chrome's OTS rejects,
 *  tofu-boxing every glyph of the entry). CFF faces keep the svg2ttf path,
 *  which already converts their cubic outlines to quadratic `glyf` — also the
 *  flavor we want emitted (overlapping-contour CFF subsets rendered even-odd,
 *  holing glyphs).
 *
 *  Also false for outline-less files whose glyphs come from a platform-private
 *  table (e.g. Apple `hvgl` in PingFang). TTC-aware: `faceIndex` selects the
 *  collection member whose table directory is checked (the raw file the
 *  embedded builder reads may be a `ttcf` collection, not a bare sfnt). */
export function sfntHasSubsettableOutlines(fontBytes: Buffer, faceIndex = 0): boolean {
  if (fontBytes.length < 12) return false;
  let dirOff = 0; // offset of the sfnt table directory to inspect
  if (fontBytes.toString("latin1", 0, 4) === "ttcf") {
    const numFonts = fontBytes.readUInt32BE(8);
    const idx = faceIndex >= 0 && faceIndex < numFonts ? faceIndex : 0;
    dirOff = fontBytes.readUInt32BE(12 + idx * 4);
  }
  if (dirOff + 12 > fontBytes.length) return false;
  const numTables = fontBytes.readUInt16BE(dirOff + 4);
  for (let i = 0; i < numTables; i++) {
    const o = dirOff + 12 + i * 16;
    if (o + 4 > fontBytes.length) break;
    if (fontBytes.toString("latin1", o, o + 4) === "glyf") return true;
  }
  return false;
}

/** Does a bare (non-TTC) sfnt's directory carry an outline table? Used to
 *  validate hb-subset OUTPUT — a subset with no outlines would pass fontkit but
 *  be rejected by the consumer browser's OTS sanitizer, tofu-boxing the text. */
function sfntHasOutlineTable(fontBytes: Buffer): boolean {
  if (fontBytes.length < 12) return false;
  const numTables = fontBytes.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    if (o + 4 > fontBytes.length) break;
    const tag = fontBytes.toString("latin1", o, o + 4);
    if (tag === "glyf" || tag === "CFF " || tag === "CFF2") return true;
  }
  return false;
}

// ── sfnt glyph-copy surgery (gid-0 addressing) ──
//
// A cmap entry mapping a codepoint to glyph id 0 means "NOT COVERED" — the
// consumer browser cascades right past the font and the codepoint renders as
// nothing (observed on macOS: the tofu box Chrome paints for an uncovered cell
// disappeared entirely). But the embedded pipeline legitimately tracks gid 0
// when a run renders the primary font's `.notdef` box for an uncovered
// codepoint. `appendGlyphCopy` clones a glyph's `glyf` data at a NEW glyph id
// (numGlyphs) so the PUA codepoint can address the same outline through a
// nonzero gid: glyf/loca gain the copy, maxp.numGlyphs bumps, hmtx is expanded
// to full metrics with the source glyph's advance, and loca is rewritten long.

/** Append a copy of `srcGid`'s glyph to a bare glyf-flavored sfnt. Returns the
 *  rewritten font and the new glyph's id. Throws when the font has no glyf or
 *  the source glyph is out of range (an EMPTY source glyph is fine — the copy
 *  is empty too, preserving invisible-notdef semantics). */
export function appendGlyphCopy(fontBytes: Buffer, srcGid: number): { bytes: Buffer; newGid: number } {
  const numTables = fontBytes.readUInt16BE(4);
  const tables: Record<string, Buffer> = {};
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    const tag = fontBytes.toString("latin1", o, o + 4);
    const off = fontBytes.readUInt32BE(o + 8);
    const len = fontBytes.readUInt32BE(o + 12);
    tables[tag] = Buffer.from(fontBytes.subarray(off, off + len));
  }
  const glyf = tables["glyf"], loca = tables["loca"], head = tables["head"], maxp = tables["maxp"], hhea = tables["hhea"], hmtx = tables["hmtx"];
  if (glyf == null || loca == null || head == null || maxp == null || hhea == null || hmtx == null) {
    throw new Error("appendGlyphCopy: missing required table (glyf/loca/head/maxp/hhea/hmtx)");
  }
  const numGlyphs = maxp.readUInt16BE(4);
  if (srcGid < 0 || srcGid >= numGlyphs) throw new Error(`appendGlyphCopy: srcGid ${srcGid} out of range (${numGlyphs} glyphs)`);
  const longLoca = head.readInt16BE(50) === 1;
  const locaAt = (i: number): number => longLoca ? loca.readUInt32BE(i * 4) : loca.readUInt16BE(i * 2) * 2;
  const srcStart = locaAt(srcGid), srcEnd = locaAt(srcGid + 1);
  const copy = glyf.subarray(srcStart, srcEnd);
  const glyfEnd = locaAt(numGlyphs);
  // append (2-byte aligned) copy to glyf
  const alignPad = glyfEnd % 2 === 0 ? 0 : 1;
  tables["glyf"] = Buffer.concat([glyf.subarray(0, glyfEnd), Buffer.alloc(alignPad), copy]);
  // rewrite loca as LONG for numGlyphs+1 glyphs
  const newLoca = Buffer.alloc((numGlyphs + 2) * 4);
  for (let i = 0; i <= numGlyphs; i++) newLoca.writeUInt32BE(locaAt(i), i * 4);
  newLoca.writeUInt32BE(glyfEnd + alignPad, numGlyphs * 4);         // new glyph starts after pad
  newLoca.writeUInt32BE(glyfEnd + alignPad + copy.length, (numGlyphs + 1) * 4);
  // (entry numGlyphs was the old end-sentinel; overwrite it with the new
  // glyph's start and add the new end-sentinel — done above.)
  tables["loca"] = newLoca;
  head.writeInt16BE(1, 50); // indexToLocFormat: long
  maxp.writeUInt16BE(numGlyphs + 1, 4);
  // expand hmtx to full (advance,lsb) pairs for all glyphs + the copy
  const numHM = hhea.readUInt16BE(34);
  const newHmtx = Buffer.alloc((numGlyphs + 1) * 4);
  let lastAdv = 0;
  for (let i = 0; i < numGlyphs; i++) {
    let adv: number, lsb: number;
    if (i < numHM) {
      adv = hmtx.readUInt16BE(i * 4);
      lsb = hmtx.readInt16BE(i * 4 + 2);
      lastAdv = adv;
    } else {
      adv = lastAdv;
      lsb = hmtx.readInt16BE(numHM * 4 + (i - numHM) * 2);
    }
    newHmtx.writeUInt16BE(adv, i * 4);
    newHmtx.writeInt16BE(lsb, i * 4 + 2);
  }
  // the copy inherits srcGid's metrics
  newHmtx.writeUInt16BE(newHmtx.readUInt16BE(srcGid * 4), numGlyphs * 4);
  newHmtx.writeInt16BE(newHmtx.readInt16BE(srcGid * 4 + 2), numGlyphs * 4 + 2);
  tables["hmtx"] = newHmtx;
  hhea.writeUInt16BE(numGlyphs + 1, 34);
  return { bytes: rebuildSfnt(fontBytes.readUInt32BE(0), tables), newGid: numGlyphs };
}

// ── glyph-id compaction (DM-1718) ──
//
// The RETAIN_GIDS subset keeps the source font's glyph id space, which pads
// `loca` + `hmtx` to the max retained gid — ~178 KB EACH for a CJK font whose
// retained gids sit near 52k (STHeiti), making a 48-glyph entry ~389 KB. The
// bundled wasm exposes no subset-plan API (no old→new mapping), so we compact
// OURSELVES, which needs no hb internals: the keep-set is exactly the gids the
// builder requested plus the composite components those glyphs reference
// (walkable from the subset's own `glyf`), renumbered in ascending order with
// `.notdef` staying gid 0. Composite glyphs get their component ids rewritten
// in place (field sizes are unchanged, so the glyph data length is stable).

/** Read the component glyph ids referenced by a composite glyph's data. */
function compositeComponentGids(glyph: Buffer): number[] {
  const gids: number[] = [];
  let p = 10; // past numberOfContours + bbox
  for (;;) {
    const flags = glyph.readUInt16BE(p);
    gids.push(glyph.readUInt16BE(p + 2));
    p += 4;
    p += (flags & 0x0001) ? 4 : 2;         // ARG_1_AND_2_ARE_WORDS
    if (flags & 0x0008) p += 2;            // WE_HAVE_A_SCALE
    else if (flags & 0x0040) p += 4;       // X_AND_Y_SCALE
    else if (flags & 0x0080) p += 8;       // TWO_BY_TWO
    if (!(flags & 0x0020)) break;          // MORE_COMPONENTS
  }
  return gids;
}

/** Rewrite a composite glyph's component ids through `gidMap` (in place on a
 *  copy — field sizes are unchanged). */
function remapCompositeComponents(glyph: Buffer, gidMap: Map<number, number>): Buffer {
  const out = Buffer.from(glyph);
  let p = 10;
  for (;;) {
    const flags = out.readUInt16BE(p);
    const oldGid = out.readUInt16BE(p + 2);
    const newGid = gidMap.get(oldGid);
    if (newGid == null) throw new Error(`compactGlyphIds: composite references unmapped gid ${oldGid}`);
    out.writeUInt16BE(newGid, p + 2);
    p += 4;
    p += (flags & 0x0001) ? 4 : 2;
    if (flags & 0x0008) p += 2;
    else if (flags & 0x0040) p += 4;
    else if (flags & 0x0080) p += 8;
    if (!(flags & 0x0020)) break;
  }
  return out;
}

/**
 * Compact a (bare, glyf-flavored) sfnt's glyph id space to `wantedGids` plus
 * the composite components they reference. Returns the rewritten font and the
 * old→new gid map (gid 0 always maps to 0). `glyf`/`loca` keep only the kept
 * glyphs (loca rewritten LONG), `hmtx` becomes full pairs for the kept glyphs,
 * `maxp.numGlyphs` / `hhea.numberOfHMetrics` shrink to match. Per-glyph
 * hinting bytecode travels inside each glyph's data, untouched.
 */
export function compactGlyphIds(fontBytes: Buffer, wantedGids: number[]): { bytes: Buffer; gidMap: Map<number, number> } {
  const numTables = fontBytes.readUInt16BE(4);
  const tables: Record<string, Buffer> = {};
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    const tag = fontBytes.toString("latin1", o, o + 4);
    const off = fontBytes.readUInt32BE(o + 8);
    const len = fontBytes.readUInt32BE(o + 12);
    tables[tag] = Buffer.from(fontBytes.subarray(off, off + len));
  }
  const glyf = tables["glyf"], loca = tables["loca"], head = tables["head"], maxp = tables["maxp"], hhea = tables["hhea"], hmtx = tables["hmtx"];
  if (glyf == null || loca == null || head == null || maxp == null || hhea == null || hmtx == null) {
    throw new Error("compactGlyphIds: missing required table (glyf/loca/head/maxp/hhea/hmtx)");
  }
  const numGlyphs = maxp.readUInt16BE(4);
  const longLoca = head.readInt16BE(50) === 1;
  const locaAt = (i: number): number => longLoca ? loca.readUInt32BE(i * 4) : loca.readUInt16BE(i * 2) * 2;
  const glyphData = (gid: number): Buffer => glyf.subarray(locaAt(gid), locaAt(gid + 1));

  // Keep-set: notdef + wanted + (recursively) composite components.
  const keep = new Set<number>([0]);
  const queue = wantedGids.filter((g) => g >= 0 && g < numGlyphs);
  for (const g of queue) keep.add(g);
  while (queue.length > 0) {
    const gid = queue.pop()!;
    const data = glyphData(gid);
    if (data.length >= 10 && data.readInt16BE(0) < 0) {
      for (const comp of compositeComponentGids(data)) {
        if (!keep.has(comp)) { keep.add(comp); queue.push(comp); }
      }
    }
  }
  const kept = [...keep].sort((a, b) => a - b);
  const gidMap = new Map<number, number>();
  kept.forEach((oldGid, newGid) => gidMap.set(oldGid, newGid));

  // Rebuild glyf + long loca over the kept glyphs (2-byte aligned entries).
  const newLoca = Buffer.alloc((kept.length + 1) * 4);
  const parts: Buffer[] = [];
  let off = 0;
  kept.forEach((oldGid, newGid) => {
    let data = glyphData(oldGid);
    if (data.length >= 10 && data.readInt16BE(0) < 0) data = remapCompositeComponents(data, gidMap);
    newLoca.writeUInt32BE(off, newGid * 4);
    parts.push(data);
    off += data.length;
    if (off % 2 === 1) { parts.push(Buffer.alloc(1)); off += 1; }
  });
  newLoca.writeUInt32BE(off, kept.length * 4);
  tables["glyf"] = Buffer.concat(parts);
  tables["loca"] = newLoca;
  head.writeInt16BE(1, 50); // long loca

  // hmtx → full pairs for the kept glyphs.
  const numHM = hhea.readUInt16BE(34);
  const metric = (gid: number): { adv: number; lsb: number } => {
    if (gid < numHM) return { adv: hmtx.readUInt16BE(gid * 4), lsb: hmtx.readInt16BE(gid * 4 + 2) };
    const lastAdv = numHM > 0 ? hmtx.readUInt16BE((numHM - 1) * 4) : 0;
    const lsbOff = numHM * 4 + (gid - numHM) * 2;
    return { adv: lastAdv, lsb: lsbOff + 2 <= hmtx.length ? hmtx.readInt16BE(lsbOff) : 0 };
  };
  const newHmtx = Buffer.alloc(kept.length * 4);
  kept.forEach((oldGid, newGid) => {
    const m = metric(oldGid);
    newHmtx.writeUInt16BE(m.adv, newGid * 4);
    newHmtx.writeInt16BE(m.lsb, newGid * 4 + 2);
  });
  tables["hmtx"] = newHmtx;
  hhea.writeUInt16BE(kept.length, 34);
  maxp.writeUInt16BE(kept.length, 4);

  return { bytes: rebuildSfnt(fontBytes.readUInt32BE(0), tables), gidMap };
}

// ── sfnt cmap replacement ──
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

/** Build a Windows (3,10) format-12 cmap mapping each codepoint → gid (gids may
 *  be arbitrary; contiguous cp+gid runs are coalesced). Handles PUA-A (BMP) and
 *  astral PUA-B alike. */
function buildFormat12Cmap(cpToGid: Map<number, number>): Buffer {
  const entries = [...cpToGid.entries()].sort((a, b) => a[0] - b[0]);
  const groups: Array<{ startCp: number; endCp: number; startGid: number }> = [];
  for (const [cp, gid] of entries) {
    const l = groups[groups.length - 1];
    if (l != null && cp === l.endCp + 1 && gid === l.startGid + (cp - l.startCp)) l.endCp = cp;
    else groups.push({ startCp: cp, endCp: cp, startGid: gid });
  }
  const sub = Buffer.alloc(16 + groups.length * 12);
  sub.writeUInt16BE(12, 0); sub.writeUInt16BE(0, 2); sub.writeUInt32BE(sub.length, 4);
  sub.writeUInt32BE(0, 8); sub.writeUInt32BE(groups.length, 12);
  let p = 16;
  for (const g of groups) { sub.writeUInt32BE(g.startCp, p); sub.writeUInt32BE(g.endCp, p + 4); sub.writeUInt32BE(g.startGid, p + 8); p += 12; }
  const hdr = Buffer.alloc(12);
  hdr.writeUInt16BE(0, 0); hdr.writeUInt16BE(1, 2);
  hdr.writeUInt16BE(3, 4); hdr.writeUInt16BE(10, 6); hdr.writeUInt32BE(12, 8);
  return Buffer.concat([hdr, sub]);
}

/** Reassemble a bare sfnt from named tables: sorted tag order, 4-byte padding,
 *  per-table checksums, and a recomputed `head.checkSumAdjustment`. */
function rebuildSfnt(sfntVersion: number, tables: Record<string, Buffer>): Buffer {
  const tags = Object.keys(tables).sort();
  const n = tags.length;
  const dirLen = 12 + n * 16;
  const dir = Buffer.alloc(dirLen);
  dir.writeUInt32BE(sfntVersion, 0);
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
  let headOff = -1;
  for (let i = 0; i < n; i++) { const o = 12 + i * 16; if (font.toString("latin1", o, o + 4) === "head") { headOff = font.readUInt32BE(o + 8); break; } }
  if (headOff >= 0) {
    font.writeUInt32BE(0, headOff + 8);
    font.writeUInt32BE((0xB1B0AFBA - tableChecksum(font)) >>> 0, headOff + 8);
  }
  return font;
}

/** The only tables the embedded `<text>` pipeline needs. The PUA stream does
 *  ZERO shaping in the consumer browser (fontkit already shaped at capture
 *  time) and every glyph gets an explicit x — so GSUB/GPOS/GDEF/kern are dead
 *  weight, and vertical/device-metric tables are worse than dead weight:
 *  Chrome's OTS sanitizer REJECTED STHeiti's subset over its `vmtx` (tofu-boxing
 *  the whole entry), and its `hdmx` alone was ~1 MB (per-glyph device records ×
 *  a RETAIN_GIDS-padded 52k-glyph id space). Keep outlines, metrics, hinting,
 *  and identity; drop the rest. */
const EMBEDDED_KEEP_TABLES = new Set([
  "head", "hhea", "hmtx", "maxp", "glyf", "loca",  // outlines + metrics
  "cvt ", "fpgm", "prep", "gasp",                  // the hinting program
  "OS/2", "post", "name",                          // identity + line metrics
]);

/** Minimal OS/2 (version 4) synthesized from `hhea` metrics + the entry's
 *  weight/italic. Legacy Apple TrueType collections (Courier.ttc, …) carry no
 *  OS/2 at all, and Chrome's OTS REQUIRES one — without it the whole
 *  `@font-face` is rejected and every glyph tofu-boxes. */
function synthesizeOs2(hhea: Buffer, weight: number, italic: boolean): Buffer {
  const ascender = hhea.readInt16BE(4);
  const descender = hhea.readInt16BE(6);
  const lineGap = hhea.readInt16BE(8);
  const advanceMax = hhea.readUInt16BE(10);
  const os2 = Buffer.alloc(96);
  os2.writeUInt16BE(4, 0);                            // version
  os2.writeInt16BE(advanceMax >> 1, 2);               // xAvgCharWidth (cosmetic)
  os2.writeUInt16BE(weight, 4);                       // usWeightClass
  os2.writeUInt16BE(5, 6);                            // usWidthClass: medium
  // fsType 0 (installable), subscript/superscript/strikeout metrics left 0 —
  // the embedded pipeline positions everything explicitly.
  os2.write("DMTN", 58, "latin1");                    // achVendID
  const bold = weight >= 600;
  os2.writeUInt16BE((italic ? 0x01 : 0) | (bold ? 0x20 : 0) | (!italic && !bold ? 0x40 : 0), 62); // fsSelection
  os2.writeUInt16BE(0xffff, 64);                      // usFirstCharIndex (PUA — capped)
  os2.writeUInt16BE(0xffff, 66);                      // usLastCharIndex
  os2.writeInt16BE(ascender, 68);                     // sTypoAscender
  os2.writeInt16BE(descender, 70);                    // sTypoDescender
  os2.writeInt16BE(lineGap, 72);                      // sTypoLineGap
  os2.writeUInt16BE(Math.max(0, ascender), 74);       // usWinAscent
  os2.writeUInt16BE(Math.max(0, -descender), 76);     // usWinDescent
  os2.writeUInt16BE(32, 92);                          // usBreakChar
  os2.writeUInt16BE(1, 94);                           // usMaxContext
  return os2;
}

/** Replace the `cmap` table of an sfnt with a PUA→gid one, dropping every table
 *  outside EMBEDDED_KEEP_TABLES, synthesizing OS/2 when the source has none,
 *  and rebuilding the directory + checksums + `head.checkSumAdjustment`. */
export function injectPuaCmap(fontBytes: Buffer, puaToGid: Map<number, number>, variant: { weight?: number; italic?: boolean } = {}): Buffer {
  const numTables = fontBytes.readUInt16BE(4);
  const tables: Record<string, Buffer> = {};
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    const tag = fontBytes.toString("latin1", o, o + 4);
    if (!EMBEDDED_KEEP_TABLES.has(tag)) continue;
    const off = fontBytes.readUInt32BE(o + 8);
    const len = fontBytes.readUInt32BE(o + 12);
    tables[tag] = fontBytes.subarray(off, off + len);
  }
  tables["cmap"] = buildFormat12Cmap(puaToGid);
  if (tables["OS/2"] == null && tables["hhea"] != null) {
    tables["OS/2"] = synthesizeOs2(tables["hhea"], variant.weight ?? 400, variant.italic ?? false);
  }
  return rebuildSfnt(fontBytes.readUInt32BE(0), tables);
}

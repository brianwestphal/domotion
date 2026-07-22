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
  let flags = HB_SUBSET_FLAGS_RETAIN_GIDS;
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
    return out;
  } finally {
    if (rface !== 0) w.hb_face_destroy(rface);
    w.hb_subset_input_destroy(input);
    w.hb_face_destroy(face);
    w.hb_blob_destroy(blob);
    w.free(fontPtr);
  }
}

/** True when the face carries hb-subsettable outlines (`glyf`/`CFF `/`CFF2`).
 *  False for outline-less files whose glyphs come from a platform-private table
 *  (e.g. Apple `hvgl` in PingFang) — those must keep the svg2ttf/helper path,
 *  since hb-subset would emit empty glyphs. TTC-aware: `faceIndex` selects the
 *  collection member whose table directory is checked (the raw file the embedded
 *  builder reads may be a `ttcf` collection, not a bare sfnt). */
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
    const tag = fontBytes.toString("latin1", o, o + 4);
    if (tag === "glyf" || tag === "CFF " || tag === "CFF2") return true;
  }
  return false;
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

/** Replace the `cmap` table of an sfnt with a PUA→gid one, rebuilding the table
 *  directory + checksums + `head.checkSumAdjustment`. */
export function injectPuaCmap(fontBytes: Buffer, puaToGid: Map<number, number>): Buffer {
  const numTables = fontBytes.readUInt16BE(4);
  const tables: Record<string, Buffer> = {};
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    const tag = fontBytes.toString("latin1", o, o + 4);
    const off = fontBytes.readUInt32BE(o + 8);
    const len = fontBytes.readUInt32BE(o + 12);
    tables[tag] = fontBytes.subarray(off, off + len);
  }
  tables["cmap"] = buildFormat12Cmap(puaToGid);
  const tags = Object.keys(tables).sort();
  const n = tags.length;
  const dirLen = 12 + n * 16;
  const dir = Buffer.alloc(dirLen);
  dir.writeUInt32BE(fontBytes.readUInt32BE(0), 0);
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

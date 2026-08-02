// DM-1197: HarfBuzz shaping for the narrow set of complex-script runs where
// Domotion's macOS shaping (the CoreText glyph-helper) diverges from Chrome's.
//
// Chrome shapes complex text with HarfBuzz. For a precomposed complex-script
// letter that has a canonical base+mark decomposition (e.g. Kaithi U+110AB VA =
// U+110A5 BA + U+110BA NUKTA), HarfBuzz's USE shaper decomposes it and paints a
// base + separately-positioned nukta (the nukta sits ~3px below the base, from
// its own glyph outline). macOS CoreText instead recomposes to the precomposed
// glyph, whose built-in nukta is ~3px higher — so Domotion (which routes the
// Indic Noto fonts through the CoreText helper, because fontkit OOM-crashes on
// their GSUB tables — DM-983) paints the nukta in the wrong place.
//
// This module shapes such a run with the ACTUAL HarfBuzz library (harfbuzzjs is
// the same engine Chrome embeds), so the output is byte-identical to Chrome's:
// `hb-shape NotoSansKaithi U+110AB` → `[ktBa=0+568 | ktNukta=0@-11,0+0]`, and
// harfbuzzjs returns the same glyphs, advances and offsets, plus the outlines.
// It's robust where fontkit isn't (no GSUB-parser crash). Scoped at the call
// site (`resolveFontForCodepoint`) to ONLY the divergent codepoints, so the rest
// of the calibrated text pipeline is untouched.
//
// The import is a VENDORED harfbuzzjs, not the published one: the npm build is
// `-DHB_TINY`, which compiles out Apple Advanced Typography entirely, and
// macOS ships system faces (GeezaPro, Helvetica, Al Nile, Baghdad) with a
// `morx` table and no `GSUB` at all. `vendor/harfbuzzjs/` is v1.4.0 with the
// wasm rebuilt using the configuration Chromium ships; see its README.
import * as hb from "../../vendor/harfbuzzjs/dist/index.mjs";
import { readFileSync } from "node:fs";

type PathCommand = { command: string; args: number[] };

interface ShapedGlyph {
  id: number;
  path: { commands: PathCommand[] };
  advanceWidth: number;
  codePoints?: number[];
}

interface ShapeResult {
  glyphs: ShapedGlyph[];
  positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }>;
  /** UTF-16 source-cluster index per glyph — lets the embedded-font emit loop
   *  anchor each cluster at its captured xOffset (the DM-1028 cluster path). */
  clusters: number[];
}

// One HarfBuzz font per (file path × PostScript name), with a per-glyph outline
// cache (glyphToPath is the hot call). The font/face/blob are retained for the
// process lifetime — this only fires for the rare divergent codepoints, so the
// footprint is tiny.
//
// The PostScript name is part of the key because a path alone does not identify
// a face: macOS ships most system families as `.ttc` collections, and the cut we
// resolve is usually not the first member (see `faceIndexForPostScriptName`).
interface HbEntry { font: { glyphToPath(id: number): string }; pathCache: Map<number, PathCommand[]> }
const hbFontCache = new Map<string, HbEntry | null>();

// Mirror of `glyph-helper.ts::parseSvgPath` — HarfBuzz's glyphToPath emits the
// same absolute M/L/Q/C/Z grammar the CoreText helper does (TrueType outlines
// are quadratic, so Q dominates; C handled defensively).
function parseSvgPath(d: string): PathCommand[] {
  if (d.length === 0) return [];
  const tokens = d.match(/[MLQCZ]|-?\d+(?:\.\d+)?/g) ?? [];
  const out: PathCommand[] = [];
  let i = 0;
  const num = (): number => Number(tokens[i++]);
  while (i < tokens.length) {
    const t = tokens[i++];
    switch (t) {
      case "M": out.push({ command: "moveTo", args: [num(), num()] }); break;
      case "L": out.push({ command: "lineTo", args: [num(), num()] }); break;
      case "Q": out.push({ command: "quadraticCurveTo", args: [num(), num(), num(), num()] }); break;
      case "C": out.push({ command: "bezierCurveTo", args: [num(), num(), num(), num(), num(), num()] }); break;
      case "Z": out.push({ command: "closePath", args: [] }); break;
    }
  }
  return out;
}

/**
 * Number of faces in `data`, by the rule HarfBuzz itself applies.
 *
 * harfbuzzjs does not expose `hb_face_count`, so this reads the one field that
 * function ends up returning. `OT::OpenTypeFontFile::get_face_count`
 * (`external/harfbuzz/src/hb-open-file.hh:470-479`, rev 4de187d) switches on the
 * leading tag: every non-collection sfnt tag (`OTTO` / `true` / `typ1` /
 * 0x00010000) answers 1, and `ttcf` defers to `TTCHeader`, whose version-1 and
 * version-2 layouts share `Array32Of<…> table` at offset 8 and answer
 * `table.len` (`:219-241` — `DEFINE_SIZE_ARRAY(12, table)`, i.e. 4-byte tag +
 * 4-byte version + the 4-byte count).
 *
 * Not ported: the `dfont` resource-fork container, which HarfBuzz also counts
 * (`:478`). No font this project routes is one — the platform tables in
 * `font-resolution.ts` carry no `.dfont` path on any of the three OSes — and its
 * count lives behind a resource map rather than a header field. Stated rather
 * than left implicit: a `.dfont` collection would be counted as 1 here and so
 * would only ever shape its first member.
 */
function faceCount(data: Uint8Array): number {
  if (data.length < 12) return 0;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const TTCF = 0x74746366; // 'ttcf'
  if (dv.getUint32(0) !== TTCF) return 1;
  return dv.getUint32(8);
}

/**
 * AAT faces shape here too, and that is the point of the vendored build.
 *
 * `_hb_apply_morx` (`external/harfbuzz/src/hb-ot-shape.cc:60-65`, rev 4de187d)
 * decides by the FACE, not the script:
 *
 *     return hb_aat_layout_has_substitution (face) &&
 *            (HB_DIRECTION_IS_HORIZONTAL (props.direction) || !hb_ot_layout_has_substitution (face));
 *
 * Every run reaching this module is horizontal (vertical text takes the raster
 * path), so this reduces to "the face has a `morx` table" — and when it does,
 * HarfBuzz applies `morx` and ignores `GSUB` even where both are present.
 *
 * That rule used to be a REFUSAL here. The published harfbuzzjs is built
 * `-DHB_TINY`, and `hb-config.hh` chains that to no AAT at all — `HB_TINY`
 * defines `HB_MINI` (`:44-46`), which defines `HB_NO_AAT` (`:95-96`), which
 * defines `HB_NO_AAT_SHAPE` (`:132-134`), the guard around `apply_morx` in the
 * shaping plan (`hb-ot-shape.cc:90`, `:98-100`). macOS ships GeezaPro,
 * Helvetica, Al Nile and Baghdad with `morx` and no `GSUB` whatsoever, so that
 * build returned isolated forms for Arabic — well-formed, and a different word.
 *
 * The build in `vendor/harfbuzzjs/` carries none of those defines, because
 * Chromium's does not either: its HarfBuzz `README.chromium` says outright that
 * Chrome no longer builds `hb-coretext` "as we rely on HarfBuzz' built-in AAT
 * shaping". Measured on GeezaPro, one Arabic word, advances in font units:
 *
 *     hb-shape 14.x, and Chrome    647  656 1359  700  971
 *     harfbuzzjs as published      647 1415 1292  902  900
 *     vendored build               647  656 1359  700  971
 */
function getHbEntry(fontPath: string, faceIndex: number | null): HbEntry | null {
  const cacheKey = `${fontPath}#${faceIndex ?? "?"}`;
  if (hbFontCache.has(cacheKey)) return hbFontCache.get(cacheKey)!;
  let entry: HbEntry | null = null;
  try {
    // A face the caller could not identify is not shaped at all. Falling back to
    // index 0 is exactly the defect this replaced: on a collection that silently
    // shapes with a DIFFERENT face. Refusing leaves the caller on its existing
    // CoreText / fontkit shaping — a different shaper, but the right font.
    if (faceIndex == null) throw new Error("unidentified face");
    const data = readFileSync(fontPath);
    // `hb.Blob` wants an ArrayBuffer; a Node Buffer is a view onto a (possibly
    // larger, pooled) ArrayBuffer, so slice out exactly this file's bytes.
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const blob = new hb.Blob(ab);
    // Blink's bounds check, in effect verbatim. `HbFaceFromSkTypeface`
    // (`external/chromium/.../fonts/shaping/harfbuzz_face_from_typeface.cc:38-42`,
    // rev 7d859f27) does
    //
    //     unsigned int num_hb_faces = hb_face_count(face_blob.get());
    //     if (0 < num_hb_faces && static_cast<unsigned>(ttc_index) < num_hb_faces) {
    //       return_face = hb::unique_ptr<hb_face_t>(hb_face_create(face_blob.get(), ttc_index));
    //     }
    //
    // and returns a NULL face otherwise, so its caller falls back. Worth keeping
    // even though the index came from a lookup over this same file: it is what
    // turns a resolver that has drifted from the bytes on disk into a fall-back
    // rather than an out-of-range face that shapes to nothing.
    const count = faceCount(data);
    if (count > 0 && faceIndex >= 0 && faceIndex < count) {
      const face = new hb.Face(blob, faceIndex);
      const font = new hb.Font(face);
      entry = { font: font as unknown as { glyphToPath(id: number): string }, pathCache: new Map() };
    }
  } catch {
    entry = null; // unreadable / non-file path — caller falls back to normal shaping
  }
  hbFontCache.set(cacheKey, entry);
  return entry;
}

/** Test seam: drop the memoised faces so a test can re-open the same path. */
/** base instance → (path#face|size|axes) → proxy. Weak on the base so an
 *  instance that goes away takes its proxies with it. See the identity note in
 *  `makeHarfbuzzShapingInstance`. */
const hbProxyCache = new WeakMap<object, Map<string, ShapingFontView>>();

export function _clearHbFontCache(): void { hbFontCache.clear(); }

/**
 * Shape `text` with HarfBuzz using the font at `fontPath`. Returns glyphs (with
 * outlines), GPOS positions, and per-glyph source clusters — the same shape the
 * `FontInstance.layout` consumers expect. Returns null when the font can't be
 * opened (caller keeps its existing shaping). Coordinates are font design units,
 * y-up (matching fontkit / the CoreText helper).
 */
export function harfbuzzShapeRun(
  fontPath: string,
  /**
   * Which member of `fontPath` to shape with — 0 for a single-face file, and
   * for a collection the index of the member the caller resolved (`shapingFaceFor`
   * in `font-resolution.ts`). `null` means the caller could not identify the
   * face, and shaping is then declined rather than guessed.
   *
   * Required rather than optional on purpose: it is the argument a call site can
   * most easily omit, and omitting it used to mean "whatever face is first in
   * the file", which fails silently — same glyph count, wrong advances.
   */
  faceIndex: number | null,
  text: string,
  /**
   * The bidi run's direction. Blink sets this on the buffer EXPLICITLY and
   * never lets HarfBuzz infer it (`platform/fonts/shaping/harfbuzz_shaper.cc:339-341`,
   * rev 7d859f27):
   *
   *     hb_buffer_set_language(buffer, language);
   *     hb_buffer_set_script(buffer, ICUScriptToHBScript(current_run_script));
   *     hb_buffer_set_direction(buffer, direction);
   *
   * with `direction` supplied by the caller from the resolved bidi level
   * (`:1147`). Inference is exactly what CSS `unicode-bidi: bidi-override`
   * exists to suppress, so a shaper that guesses cannot honour it — which is
   * the defect this parameter closes. Omitted means "infer", which stays
   * correct for every run whose direction the content already implies.
   */
  direction?: "ltr" | "rtl",
  /**
   * The run's CSS pixel size, which is what HarfBuzz uses to look up the AAT
   * `trak` tracking amount. Blink sets it on every shaped run
   * (`platform/fonts/shaping/harfbuzz_face.cc:641-647`, rev 7d859f27):
   *
   *     // Setting ptem here is critical for HarfBuzz to know where to lookup
   *     // spacing offset in the AAT trak table, the unit pt in ptem here means
   *     // "CoreText" points. [...] the meaning of HarfBuzz' hb_font_set_ptem
   *     // API was changed to expect the equivalent of CSS pixels here.
   *     hb_font_set_ptem(unscaled_font, specified_size > 0 ? specified_size
   *                                                        : platform_data_->size());
   *
   * `trak` is applied whenever the face carries both `trak` and `STAT`
   * (`hb-ot-shape.cc:216-220`) — on macOS that is Helvetica, Times, SF Pro and
   * every PingFang cut, i.e. most body text. Leaving ptem at 0 applies NO
   * tracking, which is a different answer from Chrome's rather than a neutral
   * one. Measured on PingFang, "fi fl ffi", first advance in font units:
   *
   *     ptem    0   398      (what we used to produce)
   *     ptem   16   397      (what Chrome produces for a 16px run)
   *     ptem   32   386
   *     ptem 1000   381      (what the CoreText helper produces, since it opens
   *                           the face at size = unitsPerEm)
   *
   * Omitted means "no tracking", which stays correct for a face without `trak`
   * and is the honest default for a caller that genuinely has no size.
   */
  fontSizePx?: number,
  /**
   * The run's resolved variable-axis location, or null/undefined for a static
   * face. Blink does not hand HarfBuzz an unvaried face and let it guess: it
   * clones the typeface at the resolved coordinates first
   * (`mac/font_platform_data_mac.mm:169-185`, rev 7d859f27), and Skia applies
   * and re-clamps them (`ctvariation_from_SkFontArguments`,
   * `SkTypeface_mac_ct.cpp:1147`).
   *
   * Without this a variable file shapes at its DEFAULT fvar instance whatever
   * weight, width or optical size the run resolved to — which is not a small
   * error. Measured on the SF faces before this was applied, advances were 20%+
   * off, and the shape of the difference (fractional on the platform side,
   * integral here) is the signature of an interpolated location versus none.
   *
   * Callers get the location from `shapingFaceFor(key, weight, size, slant, …)`,
   * which routes it through the same `resolveAxisLocationForFile` the native
   * outline path already uses — so the shaper and the outlines agree by
   * construction rather than by two parallel derivations.
   */
  axes?: Record<string, number> | null,
): ShapeResult | null {
  const entry = getHbEntry(fontPath, faceIndex);
  if (entry == null) return null;
  const { font, pathCache } = entry;
  // Set (or clear) tracking BEFORE shaping, on every call — the font object is
  // cached per (file, face index) and shared across runs of different sizes, so
  // a ptem left over from a previous run would silently track this one at the
  // wrong size. Passing 0 for an absent size restores "no tracking", which is
  // what HarfBuzz does with an unset ptem.
  (font as unknown as { setPtem(p: number): void }).setPtem(fontSizePx != null && fontSizePx > 0 ? fontSizePx : 0);
  // Same reasoning as ptem: the font is cached per (file, face index) and shared
  // across runs, so the axis location is state crossing that boundary. An empty
  // list resets every axis to its default, which is what a static face — or a
  // caller with no location — must see, rather than the previous run's.
  const varList = axes == null ? [] : Object.entries(axes).map(([tag, v]) => new hb.Variation(tag, v));
  (font as unknown as { setVariations(v: hb.Variation[]): void }).setVariations(varList);
  // harfbuzzjs frees the buffer's WASM memory automatically via a
  // FinalizationRegistry (no manual destroy/free); this only fires for the rare
  // divergent codepoints, so the per-call allocation is negligible.
  const buf = new hb.Buffer();
  buf.addText(text);
  // Infer script + language from content, as Blink does via ICU, then override
  // the direction when the caller knows it. Order matters: guessing also sets a
  // direction, so the explicit set has to come second or it is overwritten.
  buf.guessSegmentProperties();
  // harfbuzzjs takes HarfBuzz's numeric hb_direction_t, not a string:
  // HB_DIRECTION_LTR = 4, HB_DIRECTION_RTL = 5 (`hb.Direction`).
  if (direction != null) buf.setDirection(direction === "rtl" ? hb.Direction.RTL : hb.Direction.LTR);
  hb.shape(font as unknown as hb.Font, buf);
  const infos = buf.getGlyphInfosAndPositions();
  const glyphs: ShapedGlyph[] = [];
  const positions: ShapeResult["positions"] = [];
  const clusters: number[] = [];
  for (const g of infos) {
    const gid = g.codepoint;
    let cmds = pathCache.get(gid);
    if (cmds == null) {
      cmds = parseSvgPath(font.glyphToPath(gid));
      pathCache.set(gid, cmds);
    }
    const srcCp = text.codePointAt(g.cluster);
    glyphs.push({
      id: gid,
      path: { commands: cmds },
      advanceWidth: g.xAdvance ?? 0,
      codePoints: srcCp != null ? [srcCp] : [],
    });
    positions.push({
      xAdvance: g.xAdvance ?? 0,
      yAdvance: g.yAdvance ?? 0,
      xOffset: g.xOffset ?? 0,
      yOffset: g.yOffset ?? 0,
    });
    clusters.push(g.cluster);
  }
  return { glyphs, positions, clusters };
}

/** A minimal FontInstance-shaped view used by the renderer. Declared loosely so
 *  this module doesn't depend on text-to-path's internal interface. */
interface ShapingFontView {
  layout(text: string, features?: string[], script?: string, language?: string, direction?: "ltr" | "rtl"): {
    glyphs: ShapedGlyph[];
    positions: ShapeResult["positions"];
    clusters?: number[];
  };
  unitsPerEm: number;
  ascent: number;
  descent: number;
  underlinePosition: number;
  underlineThickness: number;
  availableFeatures?: string[];
  "OS/2"?: { yStrikeoutPosition?: number; yStrikeoutSize?: number };
  glyphForCodePoint(codePoint: number): { id: number; advanceWidth?: number; codePoints?: number[] };
  warmGlyphs?(codePoints: number[]): void;
  warmShapes?(texts: string[]): void;
}

/**
 * Wrap a base font instance so its `layout()` shapes via HarfBuzz (matching
 * Chrome) while every metric / coverage query delegates to the base instance
 * (which already loads the right file via the CoreText helper). Used ONLY for
 * the narrow divergent-codepoint runs; returns the base unchanged when the font
 * file can't be opened by HarfBuzz.
 */
export function makeHarfbuzzShapingInstance<T extends ShapingFontView>(
  base: T,
  fontPath: string,
  /** See `harfbuzzShapeRun`. Required so a call site cannot silently inherit
   *  face index 0 for a collection. */
  faceIndex: number | null,
  /** The run's CSS pixel size — drives AAT `trak` tracking. See
   *  `harfbuzzShapeRun`; omitting it applies none, which is a different answer
   *  from Chrome's on any face carrying `trak` + `STAT`. */
  fontSizePx?: number,
  /** The run's resolved variable-axis location. See `harfbuzzShapeRun`. */
  axes?: Record<string, number> | null,
): T {
  if (getHbEntry(fontPath, faceIndex) == null) return base;
  // Memoized on the exact arguments, because the RESULT'S IDENTITY IS LOAD-BEARING
  // upstream. `renderTextAsPath` groups codepoints into runs with
  // `useFontOverride !== curFontOverride` — an identity comparison — so a fresh
  // proxy per codepoint would end the run at every character and hand the shaper
  // one-character runs. For a script whose whole point is contextual shaping that
  // is not a subtle regression: it silently disables the thing being routed here.
  //
  // Harmless for the original per-codepoint callers (an isolated mark or a single
  // NFD letter is its own run either way), which is why it went unnoticed; it
  // becomes load-bearing the moment a whole run routes through.
  const memoKey = `${fontPath}#${faceIndex ?? "?"}|${fontSizePx ?? ""}|${axes == null ? "" : JSON.stringify(axes)}`;
  let perBase = hbProxyCache.get(base as object);
  if (perBase == null) { perBase = new Map(); hbProxyCache.set(base as object, perBase); }
  const memo = perBase.get(memoKey);
  if (memo != null) return memo as T;
  const proxy: ShapingFontView = {
    layout(text: string, features?: string[], script?: string, language?: string, direction?: "ltr" | "rtl") {
      const res = harfbuzzShapeRun(fontPath, faceIndex, text, direction, fontSizePx, axes);
      if (res == null) return base.layout(text); // defensive — shouldn't happen post-getHbEntry
      return res;
    },
    get unitsPerEm() { return base.unitsPerEm; },
    get ascent() { return base.ascent; },
    get descent() { return base.descent; },
    get underlinePosition() { return base.underlinePosition; },
    get underlineThickness() { return base.underlineThickness; },
    get availableFeatures() { return base.availableFeatures; },
    get "OS/2"() { return base["OS/2"]; },
    glyphForCodePoint(cp: number) { return base.glyphForCodePoint(cp); },
    warmGlyphs: base.warmGlyphs?.bind(base),
    warmShapes: base.warmShapes?.bind(base),
  };
  perBase.set(memoKey, proxy);
  return proxy as T;
}

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
import bidiFactory from "bidi-js";
import { getScript } from "unicode-properties";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";

type PathCommand = { command: string; args: number[] };

interface ShapedGlyph {
  id: number;
  path: { commands: PathCommand[] };
  advanceWidth: number;
  codePoints?: number[];
}

export interface ShapeResult {
  glyphs: ShapedGlyph[];
  positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }>;
  /** UTF-16 source-cluster index per glyph — lets the embedded-font emit loop
   *  anchor each cluster at its captured xOffset (the DM-1028 cluster path). */
  clusters: number[];
  /** Raw `hb_glyph_flags_t` per glyph. Bit 0 is UNSAFE_TO_BREAK. */
  glyphFlags: number[];
}

// One HarfBuzz font per (file path × PostScript name), with a per-glyph outline
// cache (glyphToPath is the hot call). The font/face/blob are retained for the
// process lifetime — this only fires for the rare divergent codepoints, so the
// footprint is tiny.
//
// The PostScript name is part of the key because a path alone does not identify
// a face: macOS ships most system families as `.ttc` collections, and the cut we
// resolve is usually not the first member (see `faceIndexForPostScriptName`).
interface HbEntry {
  font: {
    glyphToPath(id: number): string;
    /** hb_font_get_nominal_glyph — undefined when the cmap has no entry. */
    nominalGlyph(unicode: number): number | undefined;
    /** hb_font_get_variation_glyph — the cmap-14 sequence lookup Blink's
     *  variation-selector handling consults; undefined when the face carries no
     *  glyph for (base, selector). */
    variationGlyph(unicode: number, variationSelector: number): number | undefined;
  };
  pathCache: Map<number, PathCommand[]>;
}
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
/**
 * DM-1964: font sources that exist only as BYTES, addressed by a synthetic
 * `fontPath`.
 *
 * A webfont registered from an `@font-face` is held as a Buffer and never
 * written to disk, so `shapingFaceFor` — which resolves a font key to a file —
 * returns null for it and every HarfBuzz reroute declined. The consequence was
 * silent and wrong rather than merely absent: `font-feature-settings: "liga" 0`
 * on a webfont kept its fontkit shaping, and fontkit's `layout` is enable-only,
 * so the disable was dropped and the ligature painted.
 *
 * `hb.Blob` takes an ArrayBuffer, so the byte source is all HarfBuzz ever
 * needed. The synthetic id lets it travel through the existing `fontPath`
 * plumbing — including the proxy memo key, whose STABILITY is load-bearing
 * (`renderTextAsPath` groups runs by proxy identity, so a fresh id per call
 * would end the run at every character and hand a contextual shaper
 * one-character runs). Hence the id is memoized on the buffer's identity.
 */
const hbBufferSources = new Map<string, Uint8Array>();
const hbBufferIds = new WeakMap<object, string>();
const HB_BUFFER_PREFIX = "\u0000hbbuf:";

/**
 * Register font bytes as a shapeable source and return the synthetic
 * `fontPath` that `makeHarfbuzzShapingInstance` accepts for them. Idempotent
 * per buffer identity — the same buffer always yields the same id.
 */
export function registerHbBufferSource(bytes: Uint8Array): string {
  const existing = hbBufferIds.get(bytes);
  if (existing != null) return existing;
  const id = `${HB_BUFFER_PREFIX}${hbBufferSources.size}`;
  hbBufferIds.set(bytes, id);
  hbBufferSources.set(id, bytes);
  return id;
}

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
    // A registered buffer supplies its own bytes; everything else is a file.
    const registered = hbBufferSources.get(fontPath);
    const data = registered ?? readFileSync(fontPath);
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
      entry = { font: font as unknown as HbEntry["font"], pathCache: new Map() };
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

/** proxy → the base instance it wraps. Lets a second wrapper (e.g. the
 *  feature-list reroute over a run the script reroute already wrapped) build
 *  its proxy over the TRUE base instead of stacking proxies — a
 *  proxy-over-proxy has no `getGlyph`, so `outlinesFromBase` would silently
 *  fall back to HarfBuzz's own `glyphToPath` and swap the outline engine. */
const hbProxyBase = new WeakMap<object, object>();

/** The instance a HarfBuzz shaping proxy wraps, or `view` itself when it is
 *  not one (including instances rerouted in place by `installHarfbuzzShaping`,
 *  which keep their own identity and their own `getGlyph`). */
export function hbShapingBaseOf<T extends object>(view: T): T {
  return (hbProxyBase.get(view) as T | undefined) ?? view;
}

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
  direction?: "ltr" | "rtl" | "ttb" | "btt",
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
   * (`hb-ot-shape.cc:216-220`; see `faceHasTrakAndStat`). Swept over the 229
   * faces in the macOS routing table, 13 carry the pair — SF Pro and SF Pro
   * Italic, SF Compact, SF Hebrew, SF Pro Text, and every PingFang cut.
   * Helvetica and Times do NOT, against an earlier claim here: their collection
   * members carry `morx` and `kern` and neither table.
   *
   * Of those 13, **9 are actually routed** here: the 8 PingFang cuts and SF
   * Compact. The gate is not the tables but `extractor: "native"` — only such a
   * face reaches `createGlyphHelperFont` at all, and the rest (SF Pro, SF Pro
   * Italic, SF Hebrew, SF Pro Text) are opened by fontkit, which has no
   * `shapeFallback` seam and no AAT tracking of its own. So `system-ui` Latin
   * text is NOT tracked today; that gap is tracked separately.
   *
   * Leaving ptem at 0 applies NO
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
  /**
   * The run's OpenType features as HarfBuzz feature strings (`liga`, `-liga`,
   * `aalt=2` — the `hb_feature_from_string` grammar). Passed to `hb_shape` the
   * way Blink passes them: every author setting with its value intact
   * (`FontFeatureRange::FromFontDescription`,
   * `platform/fonts/shaping/font_features.cc:203-225`, rev 7d859f27). A zero
   * value is honored on a GSUB face by leaving the feature's lookup mask unset
   * and on an AAT face by selecting the feature's OFF selector
   * (`hb-aat-map.cc:79`, rev 4de187d: `feature.value ? selectorToEnable :
   * selectorToDisable`) — which is what makes `"liga" 0` remove Times'
   * morx common ligatures exactly as Chrome does. Omitted = default features.
   */
  features?: string[],
  /**
   * Blink-parity buffer options for the cluster-granularity splitter
   * (`cluster-fallback.ts`). All optional; existing callers are unchanged.
   */
  opts?: {
    /**
     * The full surrounding text plus the item bounds of the slice to shape.
     * Blink fills the WHOLE text into the hb buffer with an item offset/length
     * (`CaseMappingHarfBuzzBufferFiller` → `hb_buffer_add_utf16(span, size,
     * start_index, num_characters)`, `harfbuzz_shaper.cc:1092-1094`, rev
     * 7d859f27), so a re-queued range keeps its joining/normalization context —
     * a lam re-queued off the end of an Arabic word still takes its init/medial
     * form. `text` must equal `fullText.slice(itemOffset, itemOffset +
     * itemLength)`; the returned `clusters` are then indices into `fullText`.
     */
    context?: { fullText: string; itemOffset: number; itemLength: number };
    /**
     * ISO 15924 script tag for `hb_buffer_set_script`. Blink sets the
     * RunSegmenter segment's script explicitly and never lets HarfBuzz guess
     * (`ShapeRange` ← `harfbuzz_shaper.cc:1120-1123` → `:339-341`).
     */
    script?: string;
    /** BCP-47 language for `hb_buffer_set_language` (same Blink cite). */
    language?: string;
    /** Raw `hb_buffer_flags_t`, used by the exact oracle and BOT/EOT runs. */
    bufferFlags?: number;
    /** Raw `hb_buffer_cluster_level_t`; Blink uses monotone characters. */
    clusterLevel?: number;
    /**
     * Skip outline extraction — the cluster-granularity splitter only needs
     * glyph ids and clusters for its shaped/notdef verdict, and `glyphToPath`
     * is the expensive call.
     */
    verdictOnly?: boolean;
  },
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
  // With a context, fill the WHOLE text and clamp the shaped item to its
  // bounds — `hb_buffer_add_utf16`'s item_offset/item_length, the same call
  // Blink's buffer filler makes. Cluster values are then absolute indices
  // into `fullText`.
  const ctx = opts?.context;
  if (ctx != null) buf.addText(ctx.fullText, ctx.itemOffset, ctx.itemLength);
  else buf.addText(text);
  // Infer script + language from content, as Blink does via ICU, then override
  // the direction when the caller knows it. Order matters: guessing also sets a
  // direction, so the explicit set has to come second or it is overwritten.
  buf.guessSegmentProperties();
  // Explicit script/language when the caller (the run segmenter) resolved
  // them — Blink's hb_buffer_set_script / hb_buffer_set_language, applied
  // after the guess for the same override-ordering reason as direction.
  if (opts?.script != null) buf.setScript(opts.script);
  if (opts?.language != null) buf.setLanguage(opts.language);
  if (opts?.bufferFlags != null) buf.setFlags(opts.bufferFlags);
  if (opts?.clusterLevel != null) buf.setClusterLevel(opts.clusterLevel as hb.ClusterLevel);
  // harfbuzzjs takes HarfBuzz's numeric hb_direction_t, not a string:
  // HB_DIRECTION_LTR = 4, HB_DIRECTION_RTL = 5 (`hb.Direction`).
  if (direction != null) {
    const hbDirection = direction === "rtl" ? hb.Direction.RTL
      : direction === "ttb" ? hb.Direction.TTB
        : direction === "btt" ? hb.Direction.BTT : hb.Direction.LTR;
    buf.setDirection(hbDirection);
  }
  // Feature strings parse through HarfBuzz's own `hb_feature_from_string`
  // (`hb.Feature.fromString`), so the grammar here IS the library's, not a
  // re-implementation; an entry it rejects is dropped rather than guessed at.
  let hbFeatures: hb.Feature[] | undefined;
  if (features != null && features.length > 0) {
    hbFeatures = [];
    for (const f of features) {
      const parsed = hb.Feature.fromString(f);
      if (parsed != null) hbFeatures.push(parsed);
    }
  }
  hb.shape(font as unknown as hb.Font, buf, hbFeatures);
  const infos = buf.getGlyphInfosAndPositions();
  const glyphs: ShapedGlyph[] = [];
  const positions: ShapeResult["positions"] = [];
  const clusters: number[] = [];
  const glyphFlags: number[] = [];
  const clusterSource = ctx != null ? ctx.fullText : text;
  for (const g of infos) {
    const gid = g.codepoint;
    let cmds: PathCommand[];
    if (opts?.verdictOnly === true) {
      cmds = [];
    } else {
      const cached = pathCache.get(gid);
      if (cached == null) {
        cmds = parseSvgPath(font.glyphToPath(gid));
        pathCache.set(gid, cmds);
      } else {
        cmds = cached;
      }
    }
    const srcCp = clusterSource.codePointAt(g.cluster);
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
    glyphFlags.push(g.flags ?? 0);
  }
  return { glyphs, positions, clusters, glyphFlags };
}

/**
 * Direct glyph queries against a HarfBuzz-openable face, for the
 * cluster-granularity splitter's Blink-parity special cases:
 *
 * - `nominalGlyph` answers the U+3000 rule — `ExtractShapeResults` treats a
 *   U+3000 shaped to the SPACE glyph as `.notdef` unless shaping with the last
 *   font, because HarfBuzz synthesizes IDEOGRAPHIC SPACE from the space glyph
 *   (`harfbuzz_shaper.cc:684-691`, rev 7d859f27, crbug.com/1193282).
 * - `variationGlyph` is the cmap-14 sequence lookup behind Blink's
 *   `kUnmatchedVSGlyphId` sentinel (`HarfBuzzGetGlyph`,
 *   `shaping/harfbuzz_face.cc:169-207`): a face with the base glyph but no
 *   glyph for (base, selector) is treated as NOT shaping the sequence, so the
 *   cluster re-queues in search of a face that has it.
 *
 * Returns null when the face cannot be opened; glyph ids are 0 when absent.
 */
export function harfbuzzGlyphQuery(fontPath: string, faceIndex: number | null): {
  nominalGlyph(cp: number): number;
  variationGlyph(cp: number, selector: number): number;
} | null {
  const entry = getHbEntry(fontPath, faceIndex);
  if (entry == null) return null;
  return {
    nominalGlyph: (cp) => entry.font.nominalGlyph(cp) ?? 0,
    variationGlyph: (cp, selector) => entry.font.variationGlyph(cp, selector) ?? 0,
  };
}

/** `${path}#${faceIndex}` → does the face carry both tables. */
const trakStatCache = new Map<string, boolean>();

/** Read exactly `length` bytes at `position`, or null on a short read. */
function readAt(fd: number, position: number, length: number): DataView | null {
  if (length <= 0) return null;
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, position);
  if (n < length) return null;
  return new DataView(buf.buffer, buf.byteOffset, n);
}

/**
 * Does this face carry BOTH `trak` and `STAT` — HarfBuzz's own gate for AAT
 * tracking, and therefore the set of faces whose shaping we cannot reproduce
 * without HarfBuzz?
 *
 * The rule is one line of the shaping plan
 * (`external/harfbuzz/src/hb-ot-shape.cc:216-220`, rev 4de187d):
 *
 *     // According to Ned, trak is applied by default for "modern fonts", as
 *     // detected by presence of STAT table.
 *     plan.apply_trak = hb_aat_layout_has_tracking (face) && face->table.STAT->has_data ();
 *
 * where `hb_aat_layout_has_tracking` is `face->table.trak->has_data ()`
 * (`hb-aat-layout.cc:394`). Both `has_data()` are `version.to_int()`
 * (`hb-aat-layout-trak-table.hh:192`, `hb-ot-stat-table.hh:479`), which is
 * non-zero exactly when the table is present and non-empty — so a table
 * directory entry with a non-zero length is the same question, asked of the
 * bytes on disk.
 *
 * Read from the sfnt table directory rather than through fontkit or hb on
 * purpose: this decides whether to open a HarfBuzz face at all, so it must not
 * itself cost one. `PingFangUI.ttc` is 58 MB and the directory is ~500 bytes.
 */
export function faceHasTrakAndStat(fontPath: string, faceIndex: number | null): boolean {
  if (fontPath === "" || faceIndex == null) return false;
  const key = `${fontPath}#${faceIndex}`;
  const cached = trakStatCache.get(key);
  if (cached != null) return cached;
  let result = false;
  let fd = -1;
  try {
    fd = openSync(fontPath, "r");
    const head = readAt(fd, 0, 12);
    if (head == null) throw new Error("truncated header");
    let faceOffset = 0;
    if (head.getUint32(0) === 0x74746366 /* 'ttcf' */) {
      if (faceIndex >= head.getUint32(8)) throw new Error("face index past the collection");
      const off = readAt(fd, 12 + faceIndex * 4, 4);
      if (off == null) throw new Error("truncated collection offset table");
      faceOffset = off.getUint32(0);
    } else if (faceIndex !== 0) {
      // A non-zero index into a single-face file describes a face that isn't
      // there; answering for face 0 would be answering about a different font.
      throw new Error("non-collection asked for a non-zero face");
    }
    const dir = readAt(fd, faceOffset, 12);
    if (dir == null) throw new Error("truncated table directory header");
    const numTables = dir.getUint16(4);
    const records = readAt(fd, faceOffset + 12, numTables * 16);
    if (records == null) throw new Error("truncated table directory");
    let trak = false;
    let stat = false;
    for (let i = 0; i < numTables; i++) {
      if (records.getUint32(i * 16 + 12) === 0) continue; // zero-length → the Null table
      const tag = records.getUint32(i * 16);
      if (tag === 0x7472616b /* 'trak' */) trak = true;
      else if (tag === 0x53544154 /* 'STAT' */) stat = true;
    }
    result = trak && stat;
  } catch {
    result = false; // unreadable → treat as untracked, i.e. leave the caller's shaping alone
  } finally {
    if (fd >= 0) { try { closeSync(fd); } catch { /* already gone */ } }
  }
  trakStatCache.set(key, result);
  return result;
}

/** Test seam: drop the memoised `trak`/`STAT` verdicts. */
export function _clearTrakStatCache(): void { trakStatCache.clear(); }

// ── Mirror-domain adapter for renderer-facing HarfBuzz shaping ───────────────
//
// The text the renderer hands to `FontInstance.layout` is PAINT-domain: `applyBidi`
// (text.ts) has already substituted the Bidi_Mirroring_Glyph counterpart for every
// paired bracket at an odd embedding level, because fontkit and the platform
// glyph helpers draw exactly the characters they are given. HarfBuzz does not
// work that way — Blink hands it the LOGICAL text and it mirrors RTL buffers
// itself, coverage-gated (`hb_ot_rotate_chars`, `hb-ot-shape.cc:657-668`, rev
// 4de187d: `mirroring(cp)` replaces the codepoint only when
// `font->has_glyph(mirrored)`, else the `rtlm` feature is flagged). Feeding an
// hb-backed layout the pre-mirrored text therefore mirrored RTL brackets TWICE
// — a logical `(` painted as `(` where Chrome paints `)`.
//
// The adapter: when the buffer will be shaped RTL, map every character through
// the Bidi_Mirroring_Glyph involution first. That one uniform pass is correct
// for every embedding-level mix, with no level data needed:
//   - an odd-level char arrives pre-mirrored (`BMG(orig)`); the map restores
//     `orig`, and hb's own mirror re-applies `BMG(orig)` — Chrome's paint,
//     including the has_glyph gate `applyBidi` cannot apply;
//   - an even-level mirrorable char arrives unmirrored (`orig`); the map turns
//     it into `BMG(orig)`, and hb's mirror restores `orig` — Chrome paints it
//     unmirrored, and an even-level char only lands in an RTL-shaped buffer
//     where our one-buffer-per-run shaping is already coarser than Blink's
//     per-bidi-run buffers, so the round trip is exactly the neutral outcome.
// An LTR buffer is left untouched: hb mirrors nothing there, so `applyBidi`'s
// substitutions stand, same as on the non-hb engines.
const _bidi = bidiFactory();

/**
 * Scripts whose `hb_script_get_horizontal_direction` is RTL, by UCD script
 * name (what `unicode-properties.getScript` reports). Transcribed from the
 * switch in `external/harfbuzz/src/hb-common.cc:522-609` (rev 4de187d); the
 * four dual-direction scripts there (Old_Hungarian, Old_Italic, Runic,
 * Tifinagh) return HB_DIRECTION_INVALID, which the guess resolves to LTR, so
 * they are deliberately absent.
 */
const HB_RTL_HORIZONTAL_SCRIPTS = new Set([
  "Arabic", "Hebrew", "Syriac", "Thaana", "Cypriot", "Kharoshthi",
  "Phoenician", "Nko", "Lydian", "Avestan", "Imperial_Aramaic",
  "Inscriptional_Pahlavi", "Inscriptional_Parthian", "Old_South_Arabian",
  "Old_Turkic", "Samaritan", "Mandaic", "Meroitic_Cursive",
  "Meroitic_Hieroglyphs", "Manichaean", "Mende_Kikakui", "Nabataean",
  "Old_North_Arabian", "Palmyrene", "Psalter_Pahlavi", "Hatran", "Adlam",
  "Hanifi_Rohingya", "Old_Sogdian", "Sogdian", "Elymaic", "Chorasmian",
  "Yezidi", "Old_Uyghur", "Garay", "Sidetic",
]);

/**
 * The horizontal direction HarfBuzz's own guess would give this buffer —
 * `hb_buffer_guess_segment_properties` (`hb-buffer.cc:1761-1792`, rev 4de187d):
 * the script of the first character that is not Common/Inherited/Unknown,
 * resolved through `hb_script_get_horizontal_direction`, LTR when that is
 * INVALID (or when no character carries a real script).
 *
 * Transcribed rather than probed so the mirror-domain map above can be applied
 * to exactly the buffers hb will mirror; the derived direction is then passed
 * to the buffer EXPLICITLY, so the map and the direction hb uses cannot drift
 * apart even if this transcription ever lags a HarfBuzz upgrade.
 */
function hbGuessedHorizontalDirection(text: string): "ltr" | "rtl" {
  for (const ch of text) {
    const script = getScript(ch.codePointAt(0)!);
    if (script === "Common" || script === "Inherited" || script === "Unknown") continue;
    return HB_RTL_HORIZONTAL_SCRIPTS.has(script) ? "rtl" : "ltr";
  }
  return "ltr";
}

/**
 * Map every character through its Bidi_Mirroring_Glyph counterpart (an
 * involution — the pairs are symmetric by construction of the UCD data, the
 * same data `applyBidi` substitutes from via the same bidi-js table).
 * With `levels`, only characters at an ODD embedding level are mapped — the
 * exact set `applyBidi` pre-mirrored — which recovers the LOGICAL text from
 * the renderer's paint-domain text.
 */
export function mirrorPairedCharacters(text: string, levels?: ArrayLike<number>): string {
  let out = "";
  let any = false;
  let i = 0;
  for (const ch of text) {
    if (levels == null || ((levels[i] ?? 0) & 1) === 1) {
      const m: string | null = _bidi.getMirroredCharacter(ch);
      if (m != null) { out += m; any = true; i += ch.length; continue; }
    }
    out += ch;
    i += ch.length;
  }
  return any ? out : text;
}

/**
 * The (text, direction) an hb-backed renderer `layout` must actually shape:
 * the caller's direction (or hb's own guess, transcribed above, when the
 * caller has none — passed on explicitly so the mirror decision and the
 * buffer direction agree by construction), with the paint-domain text mapped
 * back through the BMG involution whenever that direction is RTL.
 */
function rendererHbShapeArgs(text: string, direction: "ltr" | "rtl" | undefined): { text: string; direction: "ltr" | "rtl" } {
  const dir = direction ?? hbGuessedHorizontalDirection(text);
  return { text: dir === "rtl" ? mirrorPairedCharacters(text) : text, direction: dir };
}

/**
 * A shaper for the glyph helper's `shapeFallback` seam, backed by HarfBuzz.
 *
 * Shaping and outlines come from different engines here, which is the whole
 * point of that seam — and it is also what Chrome does: Blink shapes with
 * HarfBuzz and rasterizes from the platform typeface through Skia. Returning
 * ids, positions and clusters (and no outlines) keeps the platform helper's
 * outlines in the picture, which on macOS is what the pixel-exact calibration
 * was measured against.
 *
 * Returns `undefined` when HarfBuzz can't open the face, so a caller can fall
 * back to its existing shaper rather than lose shaping altogether.
 */
export function makeHarfbuzzShapeFallback(
  fontPath: string,
  faceIndex: number | null,
  /** The run's CSS pixel size — this is the reason the seam is being used at
   *  all, since it drives the `trak` lookup. See `harfbuzzShapeRun`. */
  fontSizePx?: number,
  axes?: Record<string, number> | null,
): ((text: string, direction?: "ltr" | "rtl") => {
  ids: number[];
  positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }>;
  clusters: number[];
} | null) | undefined {
  if (getHbEntry(fontPath, faceIndex) == null) return undefined;
  return (text: string, direction?: "ltr" | "rtl") => {
    // Renderer-facing: the text is paint-domain (pre-mirrored by `applyBidi`),
    // so an RTL buffer takes the mirror-domain map — see `rendererHbShapeArgs`.
    const eff = rendererHbShapeArgs(text, direction);
    const res = harfbuzzShapeRun(fontPath, faceIndex, eff.text, eff.direction, fontSizePx, axes);
    if (res == null) return null;
    return { ids: res.glyphs.map((g) => g.id), positions: res.positions, clusters: res.clusters };
  };
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
  /** By-id glyph access, used only by `outlinesFromBase`. Optional because not
   *  every view has one; a view without it cannot take that mode. */
  getGlyph?(id: number): ShapedGlyph;
  warmGlyphs?(codePoints: number[]): void;
  warmShapes?(texts: string[]): void;
  /** Set on every view whose `layout` shapes through HarfBuzz (the proxy from
   *  `makeHarfbuzzShapingInstance`, an instance passed through
   *  `installHarfbuzzShaping`). Read by the run-level script reroute so a font
   *  already shaping via hb is never wrapped a second time, and by tests. */
  shapesWithHarfbuzz?: true;
}

/**
 * Give an EXISTING font instance HarfBuzz shaping, in place, keeping its own
 * engine as the source of outlines.
 *
 * The sibling `makeHarfbuzzShapingInstance` returns a proxy, and a proxy is
 * wrong for a fully-built `getFontInstance` result: that object carries a dozen
 * fields the renderer and the embedded-font path read later —
 * `naturalWeight`, `hasWeightAxis`, `faceIsBoldTrait`, `resolvedItalicAngle`,
 * `hasSlantAxis`, `isRoutedItalicCut`, `postscriptName` — and it is the KEY of
 * `fontSourceMap`. A proxy exposing a fixed property set would silently drop
 * every one of them and break identity lookup besides. Replacing one method
 * keeps the object, so none of that has to be re-plumbed or remembered.
 *
 * Preserving identity also sidesteps the run-grouping hazard the proxy has to
 * memoize around: `renderTextAsPath` ends a run on `useFontOverride !==
 * curFontOverride`, an identity comparison, so a per-call object would hand the
 * shaper one-character runs.
 *
 * Returns false when HarfBuzz cannot open the face, leaving the instance
 * untouched — a caller then keeps whatever shaping it had.
 */
export function installHarfbuzzShaping(
  base: ShapingFontView,
  fontPath: string,
  faceIndex: number | null,
  /** The run's CSS pixel size, which is the point of doing this at all — it is
   *  what HarfBuzz interpolates the AAT `trak` amount from. */
  fontSizePx?: number,
  axes?: Record<string, number> | null,
): boolean {
  if (getHbEntry(fontPath, faceIndex) == null) return false;
  // Captured BEFORE the swap: `layout` is what produces this engine's glyph
  // objects, and it is also what we are about to replace.
  const nativeLayout = base.layout.bind(base);
  const getGlyph = base.getGlyph?.bind(base);
  base.shapesWithHarfbuzz = true;
  base.layout = (text, _features, script, language, direction) => {
    // Renderer-facing: paint-domain text — an RTL buffer takes the
    // mirror-domain map (see `rendererHbShapeArgs`); the native-layout decline
    // path keeps the ORIGINAL text, since that engine draws what it is given.
    const eff = rendererHbShapeArgs(text, direction);
    const res = harfbuzzShapeRun(fontPath, faceIndex, eff.text, eff.direction, fontSizePx, axes, undefined, { script, language });
    if (res == null) return nativeLayout(text);
    if (getGlyph == null) return res;
    return {
      // Positions and clusters are the shaping and stay HarfBuzz's. Only the
      // glyph objects change hands, so only the outlines do.
      ...res,
      glyphs: res.glyphs.map((g) => {
        let drawn: ShapedGlyph | null = null;
        try { drawn = getGlyph(g.id); } catch { drawn = null; }
        return drawn ?? g; // an id this engine cannot draw keeps HarfBuzz's outline
      }),
    };
  };
  return true;
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
  opts?: {
    /**
     * DM-1925: keep HarfBuzz's ids, positions and clusters, but take each
     * glyph's OUTLINE from `base.getGlyph(id)` instead of HarfBuzz's
     * `glyphToPath`.
     *
     * Opt-in, and it has to stay that way: the three DM-1197 divergent-codepoint
     * call sites were calibrated against HarfBuzz outlines, so flipping the
     * default would silently re-render them.
     *
     * The reason it is wanted at all is that swapping the outline engine is NOT
     * a no-op even when the shaping is identical. Measured: on the font a Thai
     * fixture actually paints with, HarfBuzz and CoreText shape byte-for-byte
     * identically — same ids, offsets and advances — and routing the whole
     * `layout()` through this proxy still moved that fixture's worst tile from
     * 0.0940 to 0.1214, purely because the outlines changed hands.
     *
     * Drawing another engine's ids is well-defined because it is the same file
     * and therefore the same gid space, and that is measured rather than
     * assumed: CoreText-by-path, CoreText-by-name and HarfBuzz return identical
     * ids for the same SF Pro run, and fontkit draws HarfBuzz's Arial Unicode
     * gids 5447 / 5463 — the U+F704 / U+F714 Thai shift-left forms, which
     * fontkit's own shaping would never produce — with exactly the shifted
     * bounding boxes.
     *
     * Falls back to HarfBuzz's own outline when the base has no `getGlyph`, so
     * a view lacking it degrades to the previous behavior rather than losing
     * its glyphs.
     */
    outlinesFromBase?: boolean;
    /**
     * OpenType features BOUND to this proxy, as HarfBuzz feature strings
     * (including disables like `-liga` and values like `aalt=2` — see
     * `harfbuzzShapeRun`). Bound at creation rather than read from `layout`'s
     * own argument on purpose: every fontkit-facing call site projects the
     * run's feature list down to fontkit's enable-only form
     * (`fontkitFeatureList`), so the argument that reaches `layout` has already
     * had exactly the entries this proxy exists to honor stripped from it.
     * Joins the memo key — two proxies over one base that differ only in
     * features shape differently and must not be interchanged.
     */
    features?: string[];
  },
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
  // `outlinesFromBase` joins the key for the same reason the rest does: two
  // proxies over one base that differ only in which engine draws are different
  // objects to the run-grouping identity check, and serving one where the other
  // was asked for would swap the outline engine silently.
  const memoKey = `${fontPath}#${faceIndex ?? "?"}|${fontSizePx ?? ""}|${axes == null ? "" : JSON.stringify(axes)}|${opts?.outlinesFromBase === true ? "ob" : ""}|${opts?.features != null ? opts.features.join(",") : ""}`;
  let perBase = hbProxyCache.get(base as object);
  if (perBase == null) { perBase = new Map(); hbProxyCache.set(base as object, perBase); }
  const memo = perBase.get(memoKey);
  if (memo != null) return memo as T;
  const proxy: ShapingFontView = {
    shapesWithHarfbuzz: true,
    layout(text: string, _features?: string[], script?: string, language?: string, direction?: "ltr" | "rtl") {
      // The BOUND features, never the argument — see the `features` option
      // comment: the argument arrives pre-projected for fontkit, with the
      // disables this proxy exists to honor already stripped.
      //
      // Renderer-facing: the text is paint-domain (pre-mirrored by
      // `applyBidi`), so an RTL buffer takes the mirror-domain map first — see
      // `rendererHbShapeArgs`. The decline path hands the base engine the
      // ORIGINAL text, since that engine draws what it is given.
      const eff = rendererHbShapeArgs(text, direction);
      const res = harfbuzzShapeRun(fontPath, faceIndex, eff.text, eff.direction, fontSizePx, axes, opts?.features, { script, language });
      if (res == null) return base.layout(text); // defensive — shouldn't happen post-getHbEntry
      if (opts?.outlinesFromBase !== true || base.getGlyph == null) return res;
      const getGlyph = base.getGlyph.bind(base);
      return {
        // Positions and clusters stay HarfBuzz's — they are the shaping. Only
        // the glyph objects, and therefore the outlines, come from the base.
        ...res,
        glyphs: res.glyphs.map((g) => {
          let drawn: ShapedGlyph | null = null;
          try { drawn = getGlyph(g.id); } catch { drawn = null; }
          return drawn ?? g; // a base that cannot draw this id keeps HarfBuzz's outline
        }),
      };
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
  hbProxyBase.set(proxy as object, base as object);
  return proxy as T;
}

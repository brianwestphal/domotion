/**
 * Fontkit-compatible adapter backed by the native glyph helper.
 *
 * This owns per-font glyph, shape, and outline caches. Transport lifecycle,
 * fallback selection, and Linux target-strike data remain separate concerns.
 */

import {
  isGlyphRasterRepresentation,
  measureOutlineOffsetY,
  OFFSET_PROBE_GLYPHS,
  parseSvgPath,
  translateCommandsY,
  type GlyphHelperGlyph,
  type GlyphResponse,
  type MetaResponse,
  type PathCommand,
} from "./glyph-helper-outline.js";
import type {
  HelperRequest,
  HelperResponse,
  ShapeResponseGlyph,
} from "./glyph-helper-protocol.js";
import {
  callGlyphHelper as callHelper,
  isGlyphHelperAvailable,
} from "./glyph-helper-transport.js";

export interface GlyphHelperFontInstance {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  underlinePosition: number;
  underlineThickness: number;
  "OS/2"?: {
    yStrikeoutPosition?: number; yStrikeoutSize?: number;
    typoAscender?: number; typoDescender?: number;
  };
  availableFeatures?: string[];
  embeddedBitmapPaint?: boolean;
  faceIsBoldTrait?: boolean;
  faceIsItalicTrait?: boolean;
  directory?: { tables: Record<string, unknown> };
  /** DM-1033: batch-fetch coverage for every codepoint in `cps` in ONE helper
   *  round-trip, priming the cache so subsequent per-codepoint
   *  `glyphForCodePoint` checks (the font-run-splitting walk) hit cache instead
   *  of issuing one round-trip each. Already-cached / known-missing codepoints
   *  are skipped. */
  warmGlyphs(cps: number[]): void;
  /** DM-1037: batch the per-run `shape` queries. `layout(text)` issues one
   *  `shape` helper round-trip per distinct run text; pre-warming every run
   *  text of an element here collapses them into ONE envelope (many `shape`
   *  queries → one round-trip), priming the same per-run-text shape cache that
   *  `layout()` reads. Only texts this font FULLY covers are warmed — mirroring
   *  `layout()`'s shape gate — so a text the layout call would never shape isn't
   *  speculatively shaped. Already-cached texts are skipped. Populating the
   *  cache never changes which result `layout()` returns, so the emitted runs
   *  stay byte-identical to the lazy per-run path. */
  warmShapes(texts: string[]): void;
  glyphForCodePoint(cp: number): GlyphHelperGlyph;
  getGlyph(id: number): GlyphHelperGlyph;
  layout(
    text: string,
    features?: string[],
    script?: string,
    language?: string,
    direction?: "ltr" | "rtl",
  ): {
    glyphs: GlyphHelperGlyph[];
    positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }>;
    /** DM-1028: per-glyph UTF-16 source index in `text` (CoreText cluster).
     *  Present whenever the run was shaped via the CoreText `shape` query;
     *  the renderer uses it to anchor each cluster at its captured xOffset and
     *  to lay multi-glyph clusters (dotted circle + mark, conjuncts) out from
     *  that single anchor. Absent only when shaping fell back to the naive
     *  per-codepoint path. */
    clusters?: number[];
  };
}

/**
 * A shaped run: glyph ids with their positions and source-cluster mapping.
 *
 * Deliberately carries NO outlines. See `shapeFallback` — the point of this
 * shape is that shaping and outline production can come from different engines.
 */
export interface ShapedRunFallback {
  ids: number[];
  positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }>;
  clusters: number[];
}

/** Initial metadata + outline-offset probe sent when opening a helper font. */
export function buildGlyphHelperFontProbeEnvelope(spec: {
  postscriptName?: string;
  fontPath?: string;
  variations?: Record<string, number>;
  fontSizePx?: number;
}): HelperRequest {
  // Dot-prefixed Apple system faces cannot be reopened by name: CoreText logs
  // a warning and substitutes Times New Roman. The existing response guard
  // rejects that geometry, so avoid asking the known-impossible question.
  const probeByName = spec.postscriptName != null
    && spec.variations == null
    && !spec.postscriptName.startsWith(".");
  return {
    fonts: [
      { ref: "f", postscriptName: spec.postscriptName, fontPath: spec.fontPath, variations: spec.variations, size: 1000 },
      ...(probeByName ? [{ ref: "n", postscriptName: spec.postscriptName, size: 1000 }] : []),
    ],
    queries: [
      { type: "meta" as const, fontRef: "f", ...(spec.fontSizePx != null ? { fontSizePx: spec.fontSizePx } : {}) },
      ...(probeByName
        ? [
          { type: "meta" as const, fontRef: "n" },
          { type: "glyphs" as const, fontRef: "n", glyphs: OFFSET_PROBE_GLYPHS.map((id) => ({ id })) },
        ]
        : []),
    ],
  };
}

export function createGlyphHelperFont(spec: {
  postscriptName?: string;
  fontPath?: string;
  /** DM-1721: axis location to open a VARIABLE file at. DirectWrite opening a
   *  variable file by path yields the DEFAULT fvar instance (it does not apply
   *  axes internally the way CoreText named faces do), so Windows callers pass
   *  the resolved location here; the helper applies it via
   *  IDWriteFontResource::CreateFontFace. Omitted on macOS. */
  variations?: Record<string, number>;
  /** CSS/device pixel size used by Skia's Windows embedded-bitmap predicate. */
  fontSizePx?: number;
  /**
   * DM-1883: a shaper to use when THIS helper has no `shape` query.
   *
   * Not every platform helper implements `shape`. macOS does; the Windows
   * DirectWrite helper implements only `fallback`/`family`/`glyphs`/`meta`. On a
   * helper without it, `shapeText()` can never succeed, so every shaped run fell
   * through to the naive per-codepoint branch below — one glyph per codepoint,
   * zero offsets, no cluster map. For Arabic that is precisely isolated
   * letterforms with correct advances, which is what Chromium-on-Windows
   * comparisons showed: joining lost, ink 13–18% light, extents byte-identical.
   *
   * Injected rather than imported because this module is the engine-agnostic
   * native-helper layer and deliberately has no fontkit dependency; both callers
   * live in `font-resolution.ts`, which already imports it.
   *
   * It supplies ONLY ids, positions and clusters — the GSUB/GPOS work that is
   * missing. Outlines still come from this helper by glyph id, which is what
   * keeps DirectWrite's resolved variable-axis location (DM-1721) in the
   * picture: handing the whole `layout()` to fontkit would trade an Arabic
   * shaping bug for a variable-instance one. Glyph ids index the same gid space
   * because it is the same file.
   *
   * Self-scoping by construction: it is consulted only where the helper's own
   * `shape` query returned null, so a platform that has one is untouched.
   */
  shapeFallback?: (
    text: string,
    direction?: "ltr" | "rtl",
    features?: string[],
    script?: string,
    language?: string,
  ) => ShapedRunFallback | null;
  /**
   * DM-1916: consult `shapeFallback` BEFORE this helper's own `shape` query,
   * rather than only where that query fails.
   *
   * Set for a face carrying both `trak` and `STAT`, where HarfBuzz applies AAT
   * tracking interpolated from the run's point size
   * (`hb-ot-shape.cc:216-220`) and Blink feeds it the CSS pixel size on every
   * run (`harfbuzz_face.cc:641-647`). Measured on PingFang, "fi fl ffi", first
   * advance in font units: HarfBuzz at the run's 16 px gives 397, the CoreText
   * helper gives 381 — it opens the face at size = unitsPerEm, so it tracks as
   * though every run were 1000 px. Neither number is wrong for its own engine;
   * only one of them is Chrome's.
   *
   * Outlines are untouched: this seam carries ids, positions and clusters, and
   * the glyphs still come from this helper by id. That split is Chrome's own —
   * Blink shapes with HarfBuzz and rasterizes from the platform typeface — and
   * it is the difference between this and routing the whole `layout()` away,
   * which silently moved outline production too and made the Thai fixture worse
   * (worstTile 0.0940 → 0.1214) while shaping byte-identically.
   */
  preferShapeFallback?: boolean;
}): GlyphHelperFontInstance | null {
  if (!isGlyphHelperAvailable()) return null;

  // Open at size=1000 first so we can read unitsPerEm. Then re-open at
  // size=unitsPerEm so all glyph paths come back in design-unit space — this
  // matches fontkit's coordinate convention so the existing
  // `scale(fontSize/unitsPerEm, ...)` transform in text-to-path.ts works.
  let metaResp: MetaResponse;
  let offsetProbe: GlyphResponse[] = [];
  try {
    const probe = callHelper(buildGlyphHelperFontProbeEnvelope(spec));
    const r = probe.results[0];
    if (r.type !== "meta") throw new Error("unexpected response shape");
    metaResp = r;
    const nMeta = probe.results[1];
    const r1 = probe.results[2];
    // The by-name handle is opened WITHOUT a file, so the platform substitutes a
    // default when it cannot resolve the name rather than failing. CoreText
    // refuses to resolve Apple's dot-prefixed system names that way and returns
    // TimesNewRomanPSMT — measured for `.SFDevanagari-Regular`,
    // `.ThonburiUI-Regular`, `.SFBangla-Regular` and every sibling. Reading a
    // face-wide baseline correction off Times and applying it to a Devanagari
    // face would translate every glyph in the run by a wrong amount, so use this
    // probe only when the handle is confirmed to BE the requested face.
    //
    // In practice the existing unanimity + 1%-of-em guards in
    // `measureOutlineOffsetY` currently zero those readings out, so this is
    // defense in depth rather than a fix for a live misrender — but it removes
    // the dependence on two thresholds happening to absorb a wrong font's
    // geometry.
    const byNameIsRequestedFace = nMeta != null && nMeta.type === "meta"
      && nMeta.nameMatched !== false
      && (nMeta.postscriptName == null || nMeta.postscriptName === spec.postscriptName);
    if (byNameIsRequestedFace && r1 != null && r1.type === "glyphs") offsetProbe = r1.glyphs;
  } catch {
    return null;
  }

  const unitsPerEm = metaResp.unitsPerEm;
  // Opening at `unitsPerEm` (rather than at the run's pixel size) is deliberate,
  // and the reason is subtler than "design-unit geometry" — it was tried the
  // other way and reverted, so the trap is recorded here rather than rediscovered.
  //
  // Apple's system UI faces ARE optically size-dependent: CoreText applies
  // optical sizing from the requested point size, so the same face opened at 13
  // and at 1000 reports different advances (`.SFDevanagari` 836 vs 792 per em,
  // `.SFNS` 545.9 vs 502.0). Ordinary faces do not (Helvetica, Times New Roman
  // and Arial Unicode are identical at every size). That much is real.
  //
  // What does NOT follow is that we should open at the run's size to match
  // Chrome. Blink does not inherit CoreText's implicit sizing — it OVERRIDES it,
  // cloning the typeface at `opsz` = the specified size, clamped to the axis
  // range (`mac/font_platform_data_mac.mm:169-185`). When the clamp lands on the
  // axis default, `VariableAxisChangeEffective` returns false and Blink does not
  // clone at all, so Chrome paints the DEFAULT instance. Opening at the run size
  // reintroduces CoreText's implicit sizing underneath that, which double-counts.
  //
  // Measured: a 32 px Gujarati run clamps `opsz` to 28 (= the default), so Chrome
  // paints the default instance. Opening at 32 shifted our advance 592 -> 596 and
  // moved every glyph in the row right; Chrome's `expected.png` was byte-identical
  // across the two arms while ours moved, and three Indic blocks went from 0
  // regions to 6 / 2 / 1. The verification that had argued for it was a
  // `system-ui` run, where the explicit clone dominates and both models agree —
  // a slice that could not distinguish them.
  //
  // So: apply the axis explicitly (`resolveDarwinAxisLocation`) and open at
  // design size. Those are the same mechanism Blink uses, in the same order.
  const renderSize = unitsPerEm;

  // Per-(cp, id) caches — each glyph is fetched at most once per Node process.
  const cpToGlyph = new Map<number, GlyphHelperGlyph>();
  const idToGlyph = new Map<number, GlyphHelperGlyph>();
  const missingCp = new Set<number>();

  // Probe glyphs come back in the 1000-unit probe space; scale to design units.
  const outlineOffsetY = measureOutlineOffsetY(offsetProbe, unitsPerEm, 1000);

  /** Parse a helper outline into the renderer's command space, moved to where
   *  CoreText (and therefore Chrome) actually paints it. */
  function glyphCommands(d: string): PathCommand[] {
    return translateCommandsY(parseSvgPath(d), outlineOffsetY);
  }
  function glyphBounds(bbox: GlyphResponse["bbox"]): NonNullable<GlyphHelperGlyph["bbox"]> {
    return { minX: bbox.x, minY: bbox.y + outlineOffsetY, maxX: bbox.x + bbox.w, maxY: bbox.y + bbox.h + outlineOffsetY };
  }
  // DM-1028: per-run-text shape cache so identical runs shape once.
  const shapeCache = new Map<string, ShapeResponseGlyph[] | null>();

  // Ingest a `glyphs` query result for the codepoints in `need`, populating
  // `cpToGlyph` / `missingCp` / `idToGlyph`. Shared by the lazy `fetchByCps`
  // path and the combined coverage+shape primer (DM-1033).
  function ingestGlyphs(need: number[], glyphs: GlyphResponse[]): void {
    for (let i = 0; i < need.length; i++) {
      const cp = need[i];
      const g = glyphs[i];
      if (g == null) {
        missingCp.add(cp);
        continue;
      }
      // DM-1018: a glyph id of 0 is `.notdef` — the font doesn't cover this
      // codepoint. We STILL store the glyph (with its outline) rather than
      // marking it missing, because Blink draws the primary font's `.notdef`
      // for uncovered codepoints and that outline is often inked (SF Compact's
      // `.notdef` is the SignWriting stripes frame). `glyphForCodePoint(cp).id`
      // still reports 0, so the fallback-chain coverage check (`id !== 0`)
      // correctly treats the codepoint as uncovered and keeps walking; the
      // stored outline is only ever emitted when the renderer deliberately
      // paints the primary's `.notdef` (the DM-1018 terminal in
      // splitTextIntoFontRuns).
      const glyph: GlyphHelperGlyph = {
        id: g.id,
        advanceWidth: g.advance,
        path: { commands: glyphCommands(g.d) },
        bbox: glyphBounds(g.bbox),
        codePoints: [cp],
        ...(isGlyphRasterRepresentation(g.rasterRepresentation)
          ? { rasterRepresentation: g.rasterRepresentation } : {}),
      };
      cpToGlyph.set(cp, glyph);
      if (g.id !== 0) idToGlyph.set(g.id, glyph);
    }
  }

  function fetchByCps(cps: number[]): void {
    const need = cps.filter((cp) => !cpToGlyph.has(cp) && !missingCp.has(cp));
    if (need.length === 0) return;
    const resp = callHelper({
      fonts: [{ ref: "f", postscriptName: spec.postscriptName, fontPath: spec.fontPath, variations: spec.variations, size: renderSize }],
      queries: [{ type: "glyphs", fontRef: "f", glyphs: need.map((cp) => ({ cp })) }]
    });
    const r = resp.results[0];
    if (r.type !== "glyphs") return;
    ingestGlyphs(need, r.glyphs);
  }

  function fetchById(id: number): GlyphHelperGlyph {
    const cached = idToGlyph.get(id);
    if (cached != null) return cached;
    const resp = callHelper({
      fonts: [{ ref: "f", postscriptName: spec.postscriptName, fontPath: spec.fontPath, variations: spec.variations, size: renderSize }],
      queries: [{ type: "glyphs", fontRef: "f", glyphs: [{ id }] }]
    });
    const r = resp.results[0];
    if (r.type !== "glyphs") {
      const empty: GlyphHelperGlyph = { id, advanceWidth: 0, path: { commands: [] } };
      idToGlyph.set(id, empty);
      return empty;
    }
    const g = r.glyphs[0];
    const glyph: GlyphHelperGlyph = {
      id: g.id,
      advanceWidth: g.advance,
      path: { commands: glyphCommands(g.d) },
      bbox: glyphBounds(g.bbox),
      ...(isGlyphRasterRepresentation(g.rasterRepresentation)
        ? { rasterRepresentation: g.rasterRepresentation } : {}),
    };
    idToGlyph.set(id, glyph);
    return glyph;
  }

  function notdef(id = 0): GlyphHelperGlyph {
    return { id, advanceWidth: 0, path: { commands: [] } };
  }

  // DM-1028: shape `text` with CoreText (CTLine) → the shaped glyph stream
  // (ids, advances, GPOS offsets, source clusters, outlines). Returns null on
  // any helper error so `layout()` can fall back to the naive per-codepoint
  // path. Cached per run text.
  function shapeText(text: string): ShapeResponseGlyph[] | null {
    const cached = shapeCache.get(text);
    if (cached !== undefined) return cached;
    let shaped: ShapeResponseGlyph[] | null = null;
    try {
      const resp = callHelper({
        fonts: [{ ref: "f", postscriptName: spec.postscriptName, fontPath: spec.fontPath, variations: spec.variations, size: renderSize }],
        queries: [{ type: "shape", fontRef: "f", text }]
      });
      const r = resp.results[0];
      if (r.type === "shape" && Array.isArray(r.glyphs)) shaped = r.glyphs;
    } catch {
      shaped = null;
    }
    shapeCache.set(text, shaped);
    return shaped;
  }

  /** Shape via the injected shaper, taking outlines from THIS helper by id.
   *
   *  Called from two places in `layout()` — ahead of the platform shape query
   *  on a `preferShapeFallback` face, and after it fails everywhere else — so
   *  the "ids and positions only, outlines stay here" contract is written once
   *  rather than twice. Returns null when there is no shaper, when it declines,
   *  or when what it returned doesn't line up; every caller then continues.
   *
   *  Both callers gate on `fullyCovered` first; this deliberately does not
   *  re-check it, since the coverage probe lives in `layout()`. */
  function shapeViaFallback(
    text: string,
    direction?: "ltr" | "rtl",
    features?: string[],
    script?: string,
    language?: string,
  ): {
    glyphs: GlyphHelperGlyph[];
    positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }>;
    clusters: number[];
  } | null {
    if (spec.shapeFallback == null) return null;
    let ext: ShapedRunFallback | null = null;
    // A shaper is an optimisation of correctness, never a correctness
    // requirement: if it throws, the caller's remaining paths still render text.
    try { ext = spec.shapeFallback(text, direction, features, script, language); } catch { ext = null; }
    if (ext == null || ext.ids.length === 0 || ext.ids.length !== ext.positions.length) return null;
    return { glyphs: ext.ids.map((id) => fetchById(id)), positions: ext.positions, clusters: ext.clusters };
  }

  return {
    unitsPerEm,
    ascent: metaResp.ascent ?? 0,
    descent: metaResp.descent ?? 0,
    underlinePosition: metaResp.underlinePosition ?? 0,
    underlineThickness: metaResp.underlineThickness ?? 0,
    "OS/2": {
      yStrikeoutPosition: metaResp.strikeoutPosition,
      yStrikeoutSize: metaResp.strikeoutThickness,
      typoAscender: metaResp.typoAscender,
      typoDescender: metaResp.typoDescender,
    },
    // DM-1880: CoreText's own bold trait, so the macOS synthetic-bold rule can
    // ask the question Blink asks instead of inferring it from a weight.
    ...(metaResp.traitBold != null ? { faceIsBoldTrait: metaResp.traitBold } : {}),
    // The mirror for the ITALIC style bit — see `FontInstance.faceIsItalicTrait`.
    // `metaResp` already carried `traitItalic`; this line is the fix — it was
    // being read into nothing.
    ...(metaResp.traitItalic != null ? { faceIsItalicTrait: metaResp.traitItalic } : {}),
    // DM-2656: DirectWrite exposes the source face's GSUB inventory through
    // helper metadata. Without it, every Windows helper-backed face appeared
    // featureless and real small caps (Georgia's smcp+c2sc) were replaced by
    // Blink's 0.7 synthetic fallback.
    availableFeatures: Array.isArray(metaResp.availableFeatures) ? metaResp.availableFeatures : [],
    ...(metaResp.embeddedBitmapPaint != null
      ? { embeddedBitmapPaint: metaResp.embeddedBitmapPaint }
      : {}),
    ...(metaResp.supportedColorTables != null ? {
      directory: { tables: Object.fromEntries(metaResp.supportedColorTables.map((tag) => [tag, true])) }
    } : {}),

    warmGlyphs(cps: number[]): void {
      fetchByCps(cps);
    },

    // DM-1037: batch the per-run `shape` round-trips. Mirrors `shapeText`'s
    // per-text behavior exactly (same `{type:"shape",fontRef:"f",text}` query,
    // same result-parsing, same cache write) but folds every text into ONE
    // envelope so the helper is consulted once instead of once per run. Each
    // batched query produces the identical result the lazy single-query call
    // would, so the populated cache is byte-identical to lazily shaping.
    warmShapes(texts: string[]): void {
      // A `preferShapeFallback` face never reaches `shapeText`, so pre-warming
      // its cache is a helper round-trip whose result nothing will read.
      if (spec.preferShapeFallback === true) return;
      const need: string[] = [];
      const seen = new Set<string>();
      for (const t of texts) {
        if (t.length === 0 || seen.has(t) || shapeCache.has(t)) continue;
        seen.add(t);
        // Gate identical to `layout()`'s: only shape a run this font FULLY
        // covers. Coverage must already be known (the selection walk / the
        // DM-1036 coverage pre-warm populated it); if it isn't, conservatively
        // skip and let `layout()` shape this text lazily — no behavior change,
        // just no batching win for that one text.
        const cps = [...t].map((c) => c.codePointAt(0)!);
        const fullyCovered = cps.every(
          (cp) => cpToGlyph.has(cp) && !missingCp.has(cp) && (cpToGlyph.get(cp)!.id) !== 0
        );
        if (fullyCovered) need.push(t);
      }
      if (need.length === 0) return;
      let resp: HelperResponse;
      try {
        resp = callHelper({
          fonts: [{ ref: "f", postscriptName: spec.postscriptName, fontPath: spec.fontPath, variations: spec.variations, size: renderSize }],
          queries: need.map((t) => ({ type: "shape" as const, fontRef: "f", text: t }))
        });
      } catch {
        return; // batch failed wholesale — leave cache empty so layout() retries per-text
      }
      for (let i = 0; i < need.length; i++) {
        const r = resp.results[i];
        // A missing result (results array shorter than queries) is left
        // uncached so `layout()` re-issues a single-query shape for it rather
        // than caching a divergent value — preserves byte-identity under a
        // partial batch failure. A present result is parsed exactly as
        // `shapeText` does (including caching `null` on an error/non-shape
        // response, matching the Linux/Windows "unknown query type" path).
        if (r == null) continue;
        const shaped = r.type === "shape" && Array.isArray(r.glyphs) ? r.glyphs : null;
        shapeCache.set(need[i], shaped);
      }
    },

    glyphForCodePoint(cp: number): GlyphHelperGlyph {
      if (missingCp.has(cp)) return notdef(0);
      if (!cpToGlyph.has(cp)) fetchByCps([cp]);
      return cpToGlyph.get(cp) ?? notdef(0);
    },

    getGlyph(id: number): GlyphHelperGlyph {
      return fetchById(id);
    },

    layout(
      text: string,
      features?: string[], script?: string, language?: string,
      // DM-1894: forwarded to the injected shaper. Blink passes direction into
      // the shaper rather than letting it be inferred from content, and a
      // helper-backed face is exactly where that inference used to happen.
      direction?: "ltr" | "rtl",
    ): {
      glyphs: GlyphHelperGlyph[];
      positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }>;
      clusters?: number[];
    } {
      // DM-1028: shape with CoreText so Brahmic clusters (dotted-circle
      // insertion for an orphaned combining mark, conjuncts, mark-to-base
      // GPOS) round-trip. The old naive path mapped one glyph per codepoint
      // with zero offsets — it dropped the dotted circle and every mark
      // position. CoreText's USE shaping matches Chrome's painted cluster for
      // these scripts (fontkit's USE engine is broken for them).
      //
      // Gate: shape ONLY when this font covers every source codepoint. For an
      // UNCOVERED codepoint the renderer's DM-1018 path draws the primary
      // font's `.notdef` (SF Compact's SignWriting stripes, the no-font
      // Brahmic tofu box) — but CTLine, asked to shape an uncovered codepoint,
      // substitutes a DIFFERENT font's tofu, which regressed Sutton SignWriting
      // (was pixel-clean) and the no-font Devanagari-Extended block. So
      // uncovered runs stay on the naive per-codepoint path, where glyph 0's
      // stored `.notdef` outline reaches the renderer unchanged.
      const cps0 = [...text].map((c) => c.codePointAt(0)!);
      fetchByCps(cps0); // batch the coverage probe (cached, reused below)
      const fullyCovered = cps0.every((cp) => !missingCp.has(cp) && (cpToGlyph.get(cp)?.id ?? 0) !== 0);
      // DM-1916: on a face where the injected shaper is the authoritative one
      // (`preferShapeFallback` — `trak` + `STAT`, where this helper cannot
      // reproduce Chrome's size-dependent tracking), ask it first. Same
      // `fullyCovered` gate as below and for the same reason: an uncovered
      // codepoint must reach the naive branch so the renderer's own `.notdef`
      // handling applies rather than a shaper's substituted tofu.
      const preferred = (spec.preferShapeFallback === true && fullyCovered)
        ? shapeViaFallback(text, direction, features, script, language)
        : null;
      if (preferred != null) return preferred;
      const shaped = fullyCovered ? shapeText(text) : null;
      if (shaped != null && shaped.length > 0) {
        // DM-1111: neutralize CoreText's isolated-mark bearing compensation so a
        // LONE combining mark matches Chrome's (HarfBuzz) paint. When a shaped
        // run has NO advancing base glyph — i.e. it's nothing but zero-advance
        // orphan marks with nothing to attach to, as in the per-Unicode-block
        // mark fixtures (Combining Diacritical Marks for Symbols U+20D0–20FF,
        // Tai Tham, …) — CoreText positions each mark with a positive xOffset
        // (dx ≈ −leftSideBearing) that cancels the glyph's native (negative) LSB,
        // so the mark paints AT the pen as if it were spacing. HarfBuzz applies
        // NO such offset for a baseless mark: it paints the outline at its native
        // bearing, with the ink extending LEFT of the pen (verified against
        // Chrome's painted output — the ink lands ~|LSB| px left of where
        // CoreText would place it). Zeroing dx for these glyphs reproduces the
        // HarfBuzz/Chrome position.
        //
        // The gate keys off the SHAPED glyphs, not the source text: if the run
        // contains any advancing glyph (a real base, or the ◌ CoreText inserts
        // for an orphaned Brahmic mark — DM-1028), the marks are genuinely
        // attached to it via GPOS, which Chrome also applies, so their dx is
        // kept untouched. Only when the entire run is zero-advance marks (no base
        // present) is the dx a CoreText-only spacing artifact to drop.
        const hasAdvancingBase = shaped.some((sg) => sg.ax > 0);
        const glyphs: GlyphHelperGlyph[] = [];
        const positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }> = [];
        const clusters: number[] = [];
        for (const sg of shaped) {
          const glyph: GlyphHelperGlyph = {
            id: sg.id,
            advanceWidth: sg.ax,
            // Shaped outlines carry no bounding rect of their own, so they use
            // the font-level offset the coverage probe above already learned
            // (`layout` always runs `fetchByCps` before shaping).
            path: { commands: glyphCommands(sg.d) },
            bbox: idToGlyph.get(sg.id)?.bbox,
          };
          // Cache the outline by id so a later getGlyph(id) reuses it.
          if (sg.id !== 0 && !idToGlyph.has(sg.id)) idToGlyph.set(sg.id, glyph);
          glyphs.push(glyph);
          const dropBearingComp = !hasAdvancingBase && sg.ax === 0;
          positions.push({ xAdvance: sg.ax, yAdvance: sg.ay, xOffset: dropBearingComp ? 0 : sg.dx, yOffset: sg.dy });
          clusters.push(sg.cluster);
        }
        return { glyphs, positions, clusters };
      }

      // DM-1883: the helper could not shape. Before dropping to the naive path,
      // let an injected shaper do the GSUB/GPOS work; outlines still come from
      // this helper, by id. On a helper with no `shape` query (Windows) this is
      // the difference between joined Arabic and isolated letterforms.
      //
      // Gated on `fullyCovered` for the same reason the helper shape is: an
      // uncovered codepoint must reach the naive branch so the renderer's own
      // `.notdef` handling applies, rather than having a shaper substitute a
      // different tofu.
      if (fullyCovered) {
        const ext = shapeViaFallback(text, direction, features, script, language);
        if (ext != null) return ext;
      }

      // Fallback: naive per-codepoint mapping (CoreText shaping unavailable).
      // Batch every codepoint in one helper call before assembling the result.
      const cps: number[] = [];
      for (const ch of text) cps.push(ch.codePointAt(0)!);
      fetchByCps(cps);

      const glyphs: GlyphHelperGlyph[] = [];
      const positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }> = [];
      for (const cp of cps) {
        const g = cpToGlyph.get(cp) ?? notdef(0);
        glyphs.push(g);
        positions.push({ xAdvance: g.advanceWidth, yAdvance: 0, xOffset: 0, yOffset: 0 });
      }
      return { glyphs, positions };
    }
  };
}

// DM-655: build custom standalone TTFs from extracted glyph outlines so the
// embedded-font render mode can emit `<text>` against any font Chrome paints
// with — webfonts, system fonts, variable-axis instances — not just CDN-
// fetched webfonts. Each tracked font becomes one `@font-face` whose `src:`
// is a `data:font/ttf;base64,…` URI containing JUST the glyphs the SVG uses,
// at their captured outlines and advances.
//
// Glyph addressing: every shaped glyph is assigned a sequential PUA codepoint
// (U+E000+). The `<text>` we emit contains the PUA stream, NOT the original
// codepoints — so the consumer browser performs zero shaping / kerning /
// ligature substitution and renders each glyph at its declared advance.
// fontkit already did the shaping at capture time, so this preserves
// contextual joining (Arabic init/medi/fina), ligatures (fi, ffi), and
// cluster reordering (Devanagari i-matra) without us having to ship any
// GSUB/GPOS rules in the custom font.
//
// Outline flavor (DM-1666): we emit TrueType `glyf` outlines, NOT CFF. This is
// load-bearing for fidelity, not a stylistic choice. System/webfont source
// glyphs routinely draw a letter as SEVERAL overlapping same-winding contours
// that rely on nonzero fill to union (SF Pro's bold "A" = left-leg + crossbar +
// right-leg, three overlapping contours). glyf is filled nonzero by every
// rasterizer, so the union is correct. The previous writer (opentype.js) can
// only emit CFF/`OTTO`, and Chrome rasterizes overlapping contours in an
// opentype.js CFF subset with EVEN-ODD fill — subtracting the overlap regions
// and punching holes at the joins (the "A" crossbar rendered with blue notches
// where it met the diagonals). Proven three ways: a 3-overlapping-rectangle CFF
// renders a textbook even-odd checkerboard; all four winding combinations of
// the "A" still hole; the same overlapping contours embedded as `glyf`
// (SFNS.ttf via @font-face) render solid. This also subsumes the old DM-1202
// "rare hollow glyph" note — that was the same even-odd behavior, just caught
// on one thin punctuation glyph instead of recognized as systematic.
//
// svg2ttf writes `glyf` from an SVG-font description and handles cubic→quadratic
// conversion (via cubic2quad) for CFF-source outlines. We build one SVG font per
// tracked instance from the shaped glyph outlines and hand it to svg2ttf.

// svg2ttf ships no type declarations (see svg2ttf.d.ts for the tiny surface).
import svg2ttf from "svg2ttf";
import { readFileSync } from "node:fs";
import { emboldenPathCommands, shearPathCommands } from "./embolden-outline.js";
import { appendGlyphCopy, compactGlyphIds, hbSubsetRetainGids, injectPuaCmap, sfntHasSubsettableOutlines } from "./hb-subset.js";

/** DM-1714/DM-1716: the hinting-preserving hb-subset embedded path is the
 *  DEFAULT; set DOMOTION_HINTED_SUBSET=0 to fall back to the svg2ttf-only
 *  builder (A/B measurement, escape hatch). Read per call (not at module load)
 *  so tests can toggle it. */
function hintedSubsetEnabled(): boolean {
  return process.env.DOMOTION_HINTED_SUBSET !== "0";
}

/** A tracked glyph's outline (SVG path `d`, font units, y-up) + advance. */
interface EmbeddedGlyph {
  /** SVG path data in font units (y-up), ready to drop into an SVG-font `<glyph d=>`. */
  d: string;
  advanceWidth: number;
}

/** Where an embedded entry's glyphs came from, for the hinting-preserving
 *  subset: the on-disk sfnt (+ TTC member), and — when that file is variable —
 *  the axis location the run resolved to (`axes`; null/absent ⇒ static file). */
export interface HintedSource {
  path: string;
  faceIndex: number;
  /** Axis location to pin when instancing a variable source file (possibly
   *  empty = all defaults); null/absent ⇒ static file. Field name matches
   *  font-resolution's FontSourceInfo so the resolver's return value can be
   *  passed through unchanged. */
  variationAxes?: Record<string, number> | null;
}

/**
 * One path command from fontkit. Mirrors fontkit's internal `Path.commands[]`
 * shape so callers can hand the raw fontkit output across without converting.
 *
 *   moveTo (x, y)
 *   lineTo (x, y)
 *   quadraticCurveTo (cx, cy, x, y)
 *   bezierCurveTo (c1x, c1y, c2x, c2y, x, y)
 *   closePath ()
 */
export interface PathCommand {
  command: string;
  args: number[];
}

/**
 * One tracked font instance's accumulated state.
 *
 * Exported only so `EmbeddedFontSnapshot` can name it in the emitted `.d.ts` —
 * it is an internal representation, not a stable surface. Its FULL mutable
 * footprint (what a snapshot has to be able to undo) is:
 *
 *   - `glyphs`            — append-only Map, one entry per shaped glyph id
 *   - `puaForGlyphId`     — append-only Map, glyph id → assigned PUA codepoint
 *   - `nextPua`           — monotonically incremented allocation cursor
 *   - `weightMin`/`weightMax` — widened monotonically as weights are tracked
 *   - `hintedSourceDisqualified` — latches false → true
 *
 * The remaining fields (`cssFamily`, `unitsPerEm`, `ascender`, `descender`,
 * `italic`, `hintedSource`) are written once at entry creation and never
 * mutated afterward. Nothing in this module ever DELETES a glyph, a PUA
 * assignment, or an entry — the only removal is `clearEmbeddedFontBuilder()`.
 */
export interface BuilderEntry {
  /** CSS family name assigned at first registration (e.g. `dmf3`). Stable across calls. */
  cssFamily: string;
  unitsPerEm: number;
  ascender: number;
  descender: number;
  /** Shaped-glyph-id → outline (built lazily as glyphs are seen). */
  glyphs: Map<number, EmbeddedGlyph>;
  /** Shaped-glyph-id → assigned PUA codepoint (U+E000+). */
  puaForGlyphId: Map<number, number>;
  /** Next available PUA codepoint for this entry. */
  nextPua: number;
  /**
   * Captured variant descriptors. Emitted on the `@font-face` rule so the
   * consumer browser matches the rule EXACTLY when the `<text>` carries
   * `font-style="italic"` / `font-weight="700"` — without these descriptors
   * the rule defaults to `font-style: normal; font-weight: 400` and Chromium
   * synthesizes faux italic / faux bold ON TOP of glyphs whose italic slant
   * (or bold weight) is already baked in by the variant we resolved. Result
   * pre-fix: double-italic (~2× slant) on `<i>` text against a non-bold
   * upright fallback (the Slashdot mobile `<i>` river-story abstract).
   */
  italic: boolean;
  /** Requested CSS weight range tracked into this entry. Distinct only for
   *  static-weight hinted entries (DM-1722), where the outlines are identical
   *  at every weight and the @font-face rule carries a `font-weight: min max`
   *  RANGE descriptor so no faux-bold synthesis fires at any tracked weight. */
  weightMin: number;
  weightMax: number;
  /**
   * DM-1714/DM-1716: the sfnt file + collection index every glyph in this entry
   * came from, when they ALL share one openable fontkit source and NONE was
   * synthesized (faux-bold/italic) or supplied by the per-glyph helper fallback.
   * When set, the entry is "pure" — its glyph ids equal the source font's, so
   * `buildGlyfFontForEntry` can hb-subset the ORIGINAL file (keeping TrueType
   * hinting) and inject a PUA→gid cmap, instead of the unhinted svg2ttf rebuild.
   * For a VARIABLE source file, `axes` is the axis location the run resolved to
   * (possibly empty = default master) and the subset is fully instanced there —
   * hinting survives hb's instancer. Cleared to null the moment a glyph
   * disagrees (different source/axes, or synthetic) — then the whole entry
   * falls back to svg2ttf.
   */
  hintedSource: HintedSource | null;
  /** Set once any glyph disqualifies the entry from the hinted path (see above). */
  hintedSourceDisqualified: boolean;
}

const builderRegistry = new Map<string, BuilderEntry>();
let builderIdCounter = 0;

/** PUA-A block: U+E000..U+F8FF (6400 codepoints). Plenty for typical SVGs. */
const PUA_START = 0xE000;
const PUA_END = 0xF8FF;

/**
 * Reset per-composition state. Call alongside `clearEmbeddedFonts` at the
 * start of every `composeScrollSvg` / `elementTreeToSvg` invocation so
 * glyphs from a prior composition don't leak into the new one.
 */
export function clearEmbeddedFontBuilder(): void {
  builderRegistry.clear();
  builderIdCounter = 0;
}

// ── Speculative composition: snapshot / restore ──
//
// A caller that wants to compose a variant SPECULATIVELY — render it, measure
// the real byte size, then throw it away and compose something else — cannot
// simply let the trial run through this builder. PUA codepoints are handed out
// in order of first glyph use and `dmfN` family names in order of first
// instance registration, so a discarded trial permanently shifts the addressing
// the REAL output would otherwise have gotten. Under a nested composition (the
// `manageFonts: false` mode the compressed-run and terminal composers use) the
// registry is shared with the whole outer run, so the perturbation survives all
// the way into the final SVG's bytes.
//
// `snapshotEmbeddedFonts()` returns a marker; `restoreEmbeddedFonts(marker)`
// puts the builder back exactly as it was, so the bytes produced after the
// rollback are identical to the bytes that would have been produced had the
// trial never run. Same shape as the paths-mode glyph-defs registry's
// snapshot/rollback, which the animator's typing overlay uses for byte-stable
// `gN` ids; `snapshotGeneration()` / `restoreGeneration()` in font-resolution
// bundle the two so a caller can't roll back a partial set.

/**
 * Opaque rollback marker produced by `snapshotEmbeddedFonts()`. Treat the
 * fields as private — the only supported operation is handing it back to
 * `restoreEmbeddedFonts()`. Markers are reusable and nestable: restoring one
 * neither consumes it nor invalidates markers taken before it.
 */
export interface EmbeddedFontSnapshot {
  /**
   * Cloned (instanceKey, entry) pairs in registry insertion order. Order is
   * output-affecting — it is the order `getBuiltEmbeddedFontFaceCss()` emits
   * the `@font-face` rules in — so the rollback restores it, not just the set.
   */
  readonly entries: ReadonlyArray<readonly [string, BuilderEntry]>;
  /** `builderIdCounter` at snapshot time — the next `dmfN` family index. */
  readonly nextFamilyId: number;
}

/**
 * Copy an entry deeply enough that later mutations of the live entry can't
 * reach the copy. The spread copies every scalar field automatically (so a new
 * scalar on `BuilderEntry` is handled without touching this function); the two
 * append-only Maps and the `hintedSource` record are copied explicitly.
 *
 * `EmbeddedGlyph` values are written once and never mutated in place, so
 * sharing those object references is safe. `_builderEntryFieldNames()` + its
 * unit test pin the field list, so adding a new MUTABLE CONTAINER field to
 * `BuilderEntry` fails loudly here rather than silently escaping the rollback.
 */
function cloneBuilderEntry(entry: BuilderEntry): BuilderEntry {
  return {
    ...entry,
    glyphs: new Map(entry.glyphs),
    puaForGlyphId: new Map(entry.puaForGlyphId),
    hintedSource: entry.hintedSource == null
      ? null
      : {
        ...entry.hintedSource,
        variationAxes: entry.hintedSource.variationAxes == null
          ? entry.hintedSource.variationAxes
          : { ...entry.hintedSource.variationAxes },
      },
  };
}

/**
 * Capture the builder's full state as a rollback marker. Cheap: the clone
 * copies scalars and Map spines, sharing the (immutable) glyph outline strings.
 *
 * Pair with `restoreEmbeddedFonts()`. The marker is a value, not a cursor — the
 * builder may be cleared, re-populated, or snapshotted again in between and the
 * restore still reconstructs exactly the captured state.
 */
export function snapshotEmbeddedFonts(): EmbeddedFontSnapshot {
  const entries: Array<readonly [string, BuilderEntry]> = [];
  for (const [key, entry] of builderRegistry) entries.push([key, cloneBuilderEntry(entry)]);
  return { entries, nextFamilyId: builderIdCounter };
}

/**
 * Roll the builder back to a `snapshotEmbeddedFonts()` marker, discarding every
 * mutation made since: instances registered, glyph outlines accumulated, PUA
 * codepoints assigned, weight ranges widened, hinted-source disqualifications
 * latched, and the `dmfN` family counter.
 *
 * Restoring re-clones out of the marker, so the marker stays pristine and can
 * be restored again later (and outer markers survive an inner restore).
 * Never throws — restoring a marker taken from a never-used builder simply
 * empties it.
 *
 * Contract: the SVG the speculative pass produced must be discarded. Its
 * `dmfN` family names and PUA codepoints are handed back out to whatever is
 * composed next, so keeping both outputs would alias two different subsets onto
 * the same names.
 */
export function restoreEmbeddedFonts(snapshot: EmbeddedFontSnapshot): void {
  builderRegistry.clear();
  for (const [key, entry] of snapshot.entries) builderRegistry.set(key, cloneBuilderEntry(entry));
  builderIdCounter = snapshot.nextFamilyId;
}

/**
 * Record that a glyph is used by the current composition and return its
 * placement coordinates: which CSS family to reference and which PUA
 * codepoint to emit in the `<text>` content.
 *
 * Idempotent on (`instanceKey`, `glyphId`): repeated calls return the same
 * cssFamily + puaCodepoint, so the same glyph can be referenced many times
 * across the SVG and collapses to a single entry in the custom font.
 *
 * `instanceKey` must be stable per (font, axes-tuple). Two text runs that
 * resolve to "Inter Variable" at `wght=450 opsz=30` share an instance key;
 * a third run at `wght=540 opsz=24` gets its own.
 */
export function trackGlyphInEmbedFont(
  instanceKey: string,
  unitsPerEm: number,
  ascender: number,
  descender: number,
  glyphId: number,
  pathCommands: PathCommand[],
  advanceWidth: number,
  variant: { italic: boolean; weight: number; emboldenStrengthFU?: number; shearFactor?: number; hintedSource?: HintedSource | null } = { italic: false, weight: 400 },
): { cssFamily: string; puaCodepoint: number } | null {
  let entry = builderRegistry.get(instanceKey);
  if (entry == null) {
    entry = {
      cssFamily: `dmf${builderIdCounter++}`,
      unitsPerEm,
      ascender,
      descender,
      glyphs: new Map(),
      puaForGlyphId: new Map(),
      nextPua: PUA_START,
      italic: variant.italic,
      weightMin: variant.weight,
      weightMax: variant.weight,
      hintedSource: variant.hintedSource ?? null,
      hintedSourceDisqualified: false,
    };
    builderRegistry.set(instanceKey, entry);
  }
  // DM-1714: the entry stays eligible for the hinting-preserving hb-subset path
  // only while every glyph agrees on one openable source and none is synthetic.
  // A synthetic glyph (faux-bold/italic baked its own outline) or a glyph from a
  // different file (per-glyph helper fallback) breaks the gid↔source identity the
  // subset relies on — disqualify the whole entry the moment one appears.
  // DM-1716: the axis LOCATION is part of the identity too — two runs on the
  // same variable file at different locations can't share one instanced subset.
  // (In practice the instanceKey already separates them; this is the guard.)
  const isSynthetic = Boolean(variant.emboldenStrengthFU) || Boolean(variant.shearFactor);
  const glyphSource = variant.hintedSource ?? null;
  if (isSynthetic || glyphSource == null || entry.hintedSource == null
      || glyphSource.path !== entry.hintedSource.path || glyphSource.faceIndex !== entry.hintedSource.faceIndex
      || !sameAxisLocation(glyphSource.variationAxes, entry.hintedSource.variationAxes)) {
    entry.hintedSourceDisqualified = true;
  }
  if (variant.weight < entry.weightMin) entry.weightMin = variant.weight;
  if (variant.weight > entry.weightMax) entry.weightMax = variant.weight;
  const cached = entry.puaForGlyphId.get(glyphId);
  if (cached != null) return { cssFamily: entry.cssFamily, puaCodepoint: cached };

  if (entry.nextPua > PUA_END) {
    // Out of PUA-A slots. Caller falls through to paths-mode emission for
    // this glyph; the (rare) over-6400-glyph case keeps rendering, just
    // without the embedded-font fast path for the run that exceeded.
    return null;
  }
  const pua = entry.nextPua++;
  entry.puaForGlyphId.set(glyphId, pua);

  // DM-1693 / DM-1695: bake synthetic bold and/or oblique into the embedded
  // glyph when the resolved face lacks the requested weight/style (the @font-face
  // descriptor stays at the requested weight/style, so the consumer browser
  // synthesizes nothing on top). Embolden first (outline dilation), then shear
  // (affine) — mirroring Skia, which emboldens the outline then applies the skew
  // matrix. Both helpers return the input unchanged when their amount is 0/absent.
  let cmds = pathCommands;
  if (variant.emboldenStrengthFU) cmds = emboldenPathCommands(cmds, variant.emboldenStrengthFU);
  if (variant.shearFactor) cmds = shearPathCommands(cmds, variant.shearFactor);
  entry.glyphs.set(glyphId, {
    d: pathCommandsToSvgPath(cmds),
    advanceWidth,
  });
  return { cssFamily: entry.cssFamily, puaCodepoint: pua };
}

/** Same variable-axis location? Treats null / undefined / {} interchangeably
 *  only when both sides are empty — a pinned {wght:700} never matches {}. */
function sameAxisLocation(a: Record<string, number> | null | undefined, b: Record<string, number> | null | undefined): boolean {
  const ka = a != null ? Object.keys(a) : [];
  const kb = b != null ? Object.keys(b) : [];
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (a![k] !== b?.[k]) return false;
  }
  return true;
}

/**
 * Serialize fontkit `PathCommand[]` (font units, y-up) into an SVG path `d`
 * string. Both the fontkit path space and the SVG-font glyph space are y-up
 * font units, so the coordinates pass through unchanged — svg2ttf lays them
 * straight into the `glyf` outline.
 */
function pathCommandsToSvgPath(pathCommands: PathCommand[]): string {
  const parts: string[] = [];
  for (const cmd of pathCommands) {
    const a = cmd.args;
    switch (cmd.command) {
      case "moveTo":           parts.push(`M${a[0]} ${a[1]}`); break;
      case "lineTo":           parts.push(`L${a[0]} ${a[1]}`); break;
      case "quadraticCurveTo": parts.push(`Q${a[0]} ${a[1]} ${a[2]} ${a[3]}`); break;
      case "bezierCurveTo":    parts.push(`C${a[0]} ${a[1]} ${a[2]} ${a[3]} ${a[4]} ${a[5]}`); break;
      case "closePath":        parts.push("Z"); break;
      default: throw new Error(`embedded-font-builder: unknown glyph path command "${(cmd as { command: string }).command}"`);
    }
  }
  return parts.join("");
}

/**
 * Zero the OpenType `head` table's build timestamps so the serialized font is
 * byte-for-byte reproducible (DM-902). We pass `ts: 0` to svg2ttf so it doesn't
 * stamp `head.created` / `head.modified` with the wall-clock build time in the
 * first place, but its `head.checkSumAdjustment` and the head table's directory
 * checksum still summarize the whole font — so we zero all four fields
 * defensively here, keeping the `@font-face` `data:` URI identical run-to-run
 * (golden-SVG comparisons and reproducible builds depend on it).
 *
 * Walks the sfnt table directory to the `head` record, then zeroes the
 * directory's per-table `head` checksum, `head.checkSumAdjustment`, and
 * `head.created` / `head.modified`. Browsers / FreeType / CoreText / DirectWrite
 * don't validate either checksum for rendering, so zeroing is safe. Mutates
 * `bytes` in place.
 */
function determinizeFontTimestamps(bytes: Buffer): void {
  if (bytes.length < 12) return;
  const numTables = bytes.readUInt16BE(4);
  const DIR_START = 12;
  const REC = 16;
  for (let i = 0; i < numTables; i++) {
    const rec = DIR_START + i * REC;
    if (rec + REC > bytes.length) break;
    if (bytes.toString("ascii", rec, rec + 4) !== "head") continue;
    const headOff = bytes.readUInt32BE(rec + 8);
    // head layout: …, checkSumAdjustment@8, …, created@20 (8), modified@28 (8).
    if (headOff + 36 > bytes.length) return;
    bytes.writeUInt32BE(0, rec + 4);            // directory per-table head checksum
    bytes.writeUInt32BE(0, headOff + 8);        // head.checkSumAdjustment
    bytes.fill(0, headOff + 20, headOff + 36);  // head.created + head.modified
    return;
  }
}

/**
 * Build one `glyf`-flavored TrueType font from a tracked instance's glyphs by
 * describing it as an SVG font and handing it to svg2ttf.
 *
 * The SVG-font glyph space is font units, y-up — identical to the fontkit path
 * space the `d` strings came from — so coordinates pass through unchanged.
 * svg2ttf's `<missing-glyph>` becomes gid 0 (.notdef): an empty, zero-width
 * invisible glyph, so any codepoint the consumer queries that we DIDN'T embed
 * (shouldn't happen — we emit only registered PUA codepoints) renders blank
 * rather than tofu. Each `<glyph>` is addressed by its PUA codepoint; svg2ttf
 * builds the `cmap` from those, so the emitted `<text>` PUA stream maps to the
 * right outlines with zero shaping.
 */
function buildGlyfFontForEntry(entry: BuilderEntry): Buffer {
  // DM-1714/DM-1716: hinting-preserving path. When the whole entry came from one
  // openable sfnt with no synthetic glyphs, hb-subset the ORIGINAL file (keeps
  // `cvt`/`fpgm`/`prep` + per-glyph instructions) and swap in a PUA→gid cmap,
  // instead of svg2ttf's outline-only rebuild. A variable source is fully
  // instanced at the run's resolved axis location (`hintedSource.variationAxes`) — hb
  // applies the same gvar deltas fontkit shaped with, and hinting survives its
  // instancer. Any failure falls through to the proven svg2ttf path so a bad
  // font never breaks a render.
  if (hintedSubsetEnabled() && entry.hintedSource != null && !entry.hintedSourceDisqualified) {
    try {
      const gids = [...entry.puaForGlyphId.keys()];
      const puaToGid = new Map<number, number>();
      for (const [gid, pua] of entry.puaForGlyphId) puaToGid.set(pua, gid);
      const bytes = readFileSync(entry.hintedSource.path);
      // Guard non-glyf faces: CFF/CFF2 (the bundled wasm silently drops `CFF `,
      // producing an outline-less font Chrome's OTS rejects → tofu) and
      // outline-less files (PingFang's Apple-private hvgl). Those keep the
      // svg2ttf path by design — a quiet skip, not a failure.
      if (sfntHasSubsettableOutlines(bytes, entry.hintedSource.faceIndex)) {
        const retained = hbSubsetRetainGids(bytes, gids, entry.hintedSource.faceIndex, true, entry.hintedSource.variationAxes ?? null);
        // DM-1718: compact the RETAIN_GIDS id space (padded to the source's max
        // gid — ~356 KB of loca+hmtx for a CJK font) down to the kept glyphs,
        // and translate the PUA map through the old→new gid mapping.
        const { bytes: compacted, gidMap } = compactGlyphIds(retained, gids);
        let subset = compacted;
        for (const [pua, gid] of puaToGid) {
          const mapped = gidMap.get(gid);
          if (mapped == null) throw new Error(`compacted subset lost gid ${gid}`);
          puaToGid.set(pua, mapped);
        }
        // A run rendering the primary's `.notdef` box tracks GLYPH ID 0 — but a
        // cmap entry mapping to gid 0 means "not covered" (the consumer browser
        // cascades past the font and paints NOTHING, losing the tofu box).
        // Clone the notdef outline at a fresh gid and address that instead.
        const notdefPuas = [...puaToGid.entries()].filter(([, gid]) => gid === 0).map(([pua]) => pua);
        if (notdefPuas.length > 0) {
          const { bytes: withCopy, newGid } = appendGlyphCopy(subset, 0);
          subset = withCopy;
          for (const pua of notdefPuas) puaToGid.set(pua, newGid);
        }
        const out = injectPuaCmap(subset, puaToGid, { weight: entry.weightMin, italic: entry.italic });
        if (process.env.DOMOTION_HINTED_DEBUG === "1") {
          console.warn(`[hinted-debug] ${entry.cssFamily}: ${entry.hintedSource.path}#${entry.hintedSource.faceIndex} axes=${JSON.stringify(entry.hintedSource.variationAxes ?? null)} gids=${gids.length} out=${out.length}B`);
        }
        return out;
      }
    } catch (e) {
      // A guard/subset failure silently falls back to the proven svg2ttf path —
      // a bad font never breaks a render. Opt-in visibility via the debug env.
      if (process.env.DOMOTION_HINTED_DEBUG === "1") {
        console.warn(`[hinted-debug] ${entry.cssFamily}: hb-subset failed for ${entry.hintedSource.path}; falling back to svg2ttf:`, (e as Error).message);
      }
    }
  }
  const glyphEls: string[] = [];
  for (const [glyphId, g] of entry.glyphs) {
    // PUA codepoints are pure hex digits; `d` carries only path grammar
    // (M/L/Q/C/Z, numbers, spaces) — neither needs XML-escaping.
    const pua = entry.puaForGlyphId.get(glyphId)!;
    glyphEls.push(`<glyph unicode="&#x${pua.toString(16)};" horiz-adv-x="${Math.round(g.advanceWidth)}" d="${g.d}"/>`);
  }
  const svgFont =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<svg xmlns="http://www.w3.org/2000/svg"><defs>` +
    `<font id="${entry.cssFamily}" horiz-adv-x="${Math.round(entry.unitsPerEm / 2)}">` +
    `<font-face font-family="${entry.cssFamily}" units-per-em="${entry.unitsPerEm}"` +
    ` ascent="${Math.round(entry.ascender)}" descent="${Math.round(entry.descender)}"/>` +
    `<missing-glyph horiz-adv-x="${Math.round(entry.unitsPerEm / 2)}"/>` +
    glyphEls.join("") +
    `</font></defs></svg>`;
  return Buffer.from(svg2ttf(svgFont, { ts: 0 }).buffer);
}

/**
 * Serialise every tracked custom font as `@font-face` rules with embedded
 * TTF bytes. Returns the joined CSS ready to drop into the SVG's `<style>`
 * block. Empty string when no glyphs were registered.
 */
export function getBuiltEmbeddedFontFaceCss(): string {
  if (builderRegistry.size === 0) return "";
  const rules: string[] = [];
  for (const entry of builderRegistry.values()) {
    const ttfBytes = buildGlyfFontForEntry(entry);
    determinizeFontTimestamps(ttfBytes); // DM-902: strip the build-time stamp
    const b64 = ttfBytes.toString("base64");
    // Emit explicit font-style / font-weight descriptors so the consumer
    // browser matches this @font-face EXACTLY when the `<text>` element
    // requests italic / bold. Without these the rule defaults to
    // `font-style: normal; font-weight: 400` and Chromium synthesizes faux
    // italic / faux bold on top of glyphs whose italic / bold shape is
    // already baked into the custom TTF.
    const styleDesc = entry.italic ? "italic" : "normal";
    const weightDesc = entry.weightMin === entry.weightMax
      ? `${entry.weightMin}`
      : `${entry.weightMin} ${entry.weightMax}`;
    rules.push(`@font-face { font-family: "${entry.cssFamily}"; font-style: ${styleDesc}; font-weight: ${weightDesc}; src: url("data:font/ttf;base64,${b64}"); }`);
  }
  return rules.join("\n");
}

/** Test-only: inspect builder state for assertions. */
export function _builderRegistrySize(): number { return builderRegistry.size; }
export function _builderGlyphsFor(instanceKey: string): number {
  return builderRegistry.get(instanceKey)?.glyphs.size ?? 0;
}
/**
 * Test-only: the live field names of a tracked entry. Pinned by a unit test so
 * that adding a field to `BuilderEntry` fails the suite and forces
 * `cloneBuilderEntry` to be revisited — a field that clones by reference would
 * silently escape `restoreEmbeddedFonts`, and a partial rollback corrupts
 * output more quietly than no rollback at all.
 */
export function _builderEntryFieldNames(instanceKey: string): string[] {
  const entry = builderRegistry.get(instanceKey);
  return entry == null ? [] : Object.keys(entry);
}
/**
 * Test-only: the complete mutable state of one tracked entry, flattened for
 * assertions. Covers every field a snapshot has to roll back.
 */
export function _builderEntryState(instanceKey: string): {
  cssFamily: string;
  nextPua: number;
  weightMin: number;
  weightMax: number;
  italic: boolean;
  hintedSourceDisqualified: boolean;
  hintedSourcePath: string | null;
  glyphIds: number[];
  puas: number[];
} | null {
  const e = builderRegistry.get(instanceKey);
  if (e == null) return null;
  return {
    cssFamily: e.cssFamily,
    nextPua: e.nextPua,
    weightMin: e.weightMin,
    weightMax: e.weightMax,
    italic: e.italic,
    hintedSourceDisqualified: e.hintedSourceDisqualified,
    hintedSourcePath: e.hintedSource?.path ?? null,
    glyphIds: [...e.glyphs.keys()],
    puas: [...e.puaForGlyphId.values()],
  };
}

/** Test-only: tracked instance keys, in registry insertion order (the order the
 *  `@font-face` rules are emitted in). */
export function _builderInstanceKeys(): string[] {
  return [...builderRegistry.keys()];
}

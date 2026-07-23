/**
 * Frame-sequence compressor v1 — the opt-in run block (docs/100, Primitive 1).
 *
 * `composeCompressedRun(states, opts)` composes N captured states (the trees a
 * caller captured after each edit/keystroke of an editor-style sequence) into
 * ONE self-contained nested animated SVG: content shared across states is
 * emitted once, and every later state contributes only what actually changed —
 * new glyphs appear via `step-end` opacity births, deleted glyphs die the same
 * way, a shifted tail run rides `step-end` `translateX` waypoints, and a
 * recolored glyph gets a `fill` step keyframe. Layout SNAPS at state
 * boundaries — deliberately never tweened and never crossfaded (real editors
 * snap; crossfading near-identical lines reads as a blur-pulse per keystroke).
 *
 * The returned SVG drops into one outer animate frame's `svgContent` with
 * `embeddedAnimationPeriodMs: durationMs` — exactly the `typeResample` /
 * `cast` / scroll-block nesting precedent — so the animator needs ZERO changes
 * and the 1 config-frame ↔ 1 animation-frame invariant holds.
 *
 * ── Emission mechanism (what this v1 actually builds) ──────────────────────
 *
 * The output is three layers, all rendered through the production
 * `elementTreeToSvgInner` pipeline (so fonts, subsetting, and every text
 * fidelity behavior are the normal ones):
 *
 * 1. **Chrome layer** — every state's tree minus the text segments the glyph
 *    layer owns. The N chrome trees are merged into ONE union tree by
 *    element-level pairing on byte-equality of the captured records (a sound
 *    under-approximation of rendered-markup equality: the renderer is a pure
 *    function of the captured element + id prefix, so equal records render
 *    byte-equal markup — "re-emit on any doubt" holds by construction).
 *    Shared subtrees are emitted once; anything unequal re-emits as a sibling
 *    variant gated by a `step-end` `display` track (the viewBox-cull pass's
 *    `display: inline ↔ none` mechanism, chosen over opacity so the track
 *    can't fight a baked captured-opacity wrapper). z-order inside chrome is
 *    exact — the union tree preserves the captured structure.
 * 2. **Glyph layer** — per-line glyph identities threaded across all N states
 *    (the `TrackedLine` / `lineKeyframes` two-track model from
 *    `src/terminal/incremental.ts`, one level down). Adjacent states are
 *    aligned per line by the order-preserving LCS in `glyph-align.ts`; each
 *    surviving identity records its per-state painted x (from captured
 *    `xOffsets` — never accumulated) and fill. Identities sharing a lifetime,
 *    line, style, shift timeline, and fill timeline coalesce into one
 *    **group**, emitted once as a synthetic text-only element (the source
 *    element with box paint neutralized and a single segment holding the
 *    group's characters at their FINAL-state absolute `xOffsets` — the
 *    mid-segment split is exact because every glyph's painted x is captured).
 *    Groups are anchored at their final captured x and the `translateX` track
 *    runs BACKWARD for earlier states, so rest = identity at the run's end and
 *    the exit cut against a following frame is byte-identical (the
 *    "animations rest at identity" house rule; earlier states carry the
 *    transform-composed AA, but nothing cuts against a transient state).
 *    Groups are driven by up to three tracks: `step-end` opacity
 *    (birth/death), `step-end` `translateX` (waypoints per state), and a
 *    `step-end` `fill` keyframe applied to the group's descendants (a CSS
 *    animation outranks the `fill` presentation attribute).
 * 3. **Caret track** (opt-in) — the pairing pass knows each state's edit
 *    point, so caret waypoints are derived for free and emitted through the
 *    caret-track machinery (`textTrackMarkup`, docs/101).
 *
 * The glyph layer paints ABOVE the chrome layer. That gives true editor
 * z-order for selection-style box paint behind text, and is guarded by an
 * occlusion check: an element's text only joins the glyph layer when no
 * box-painting element that paints after it (document order, or any non-auto
 * z-index) intersects its text rects — otherwise the text stays in the chrome
 * layer and flipbooks with it. Re-emit on any doubt, never wrong pixels.
 *
 * ── Eligibility guards (what re-emits instead of pairing) ──────────────────
 *
 * Text joins the glyph layer only when the compressor can prove a split
 * emission is paint-identical: horizontal segments with captured `xOffsets`,
 * simple scripts only (no complex shaping across a split boundary), no
 * decorations / shadows / strokes / emphasis / gradient fills, no raster
 * overlays, no transform/filter/mask/clip/blend/opacity on the element or an
 * ancestor, LTR only, and text rects fully inside every overflow-clipping
 * ancestor. Everything else stays in the chrome layer and re-emits per state.
 *
 * v1 limitations (documented in docs/100): states are captured statics
 * (intra-frame animations / cursor-overlay addressing inside a run are
 * unsupported); a line that moves vertically re-emits (no cross-line identity);
 * coding-ligature fonts may unligate across a split boundary; the run is
 * emitted whole (no viewBox culling inside the run — the outer animator can
 * still cull the frame as one unit); the default embedded-font render mode is
 * assumed (the `paths`-mode glyph-defs registry is not deduped across the
 * internal renders).
 */

import type { CapturedElement, TextSegment } from "../capture/types.js";
import { elementTreeToSvgInner } from "../render/element-tree-to-svg.js";
import { clearEmbeddedFonts, clearGlyphDefs, getEmbeddedFontFaceCss } from "../render/index.js";
import { alignLineGlyphs, type AlignGlyph } from "./glyph-align.js";
import { textTrackMarkup, CARET_BLINK_MS, type ResolvedTextTrack } from "./caret-track.js";
import { DEFAULT_CARET_WIDTH_PX, type CaretShape } from "./caret-metrics.js";

// ── Public surface ──────────────────────────────────────────────────────────

/** One captured state of the run: the tree captured after the state's edit,
 *  plus how long the state holds before snapping to the next. */
export interface CompressedRunState {
  tree: CapturedElement[];
  holdMs: number;
}

export interface CompressedRunOptions {
  width: number;
  height: number;
  /** Paint a root background rect first (e.g. the captured
   *  `styles.rootBgComputed`). Omit for a transparent run. */
  background?: string;
  /** Emit the auto-caret track derived from the per-state edit points
   *  (docs/101 machinery). Default false — the config surface decides
   *  defaults later. */
  caret?: boolean | { shape?: CaretShape; color?: string };
  /** Namespace token for ids / classes / keyframes inside the run (callers
   *  embedding several runs in one animation pass distinct prefixes; the
   *  embed-namespace pass adds its own outer namespacing too). Default "cr". */
  idPrefix?: string;
  /** `false` defers @font-face to a host pipeline (the outer animate run's
   *  shared embedded-font builder), exactly like the terminal composer's
   *  `manageFonts: false`. Default true — self-contained SVG. */
  manageFonts?: boolean;
  log?: (msg: string) => void;
}

export interface CompressedRunPairingStats {
  states: number;
  /** Glyphs across states 1..N-1 that entered pairing (the denominator). */
  glyphs: number;
  glyphsPaired: number;
  /** glyphsPaired / glyphs (1 when there was nothing to pair). */
  pairedPct: number;
  recolored: number;
  births: number;
  deaths: number;
  /** Emitted glyph identity groups. */
  groupCount: number;
  /** Chrome union nodes carrying a visibility track. */
  chromeTrackCount: number;
  /** Total bytes of the N states rendered independently (the flipbook frame
   *  payload the compressor replaces; excludes the shared @font-face block on
   *  both sides of the comparison). */
  rawBytes: number;
  /** Bytes of the composed run, excluding the @font-face block (which a
   *  flipbook carries identically, once). */
  compressedBytes: number;
}

/** One detected edit point (where the state's new glyphs landed / where the
 *  deletion closed up). Drives the auto-caret; exposed for tests/tooling. */
export interface CompressedRunEdit {
  /** The state the edit produced (1-based transitions land on 1..N-1). */
  state: number;
  /** Caret x after the edit (right edge of the last typed glyph, or the
   *  close-up point of a deletion). */
  x: number;
  lineTop: number;
  ascent: number;
  descent: number;
  fontSize: number;
  cellWidth: number;
}

export interface CompressedRunResult {
  /** Self-contained animated `<svg>` (all tracks step-end, `infinite`),
   *  ready to namespace + embed as one outer frame's `svgContent` with
   *  `embeddedAnimationPeriodMs: durationMs`. */
  svg: string;
  width: number;
  height: number;
  durationMs: number;
  pairingStats: CompressedRunPairingStats;
  edits: CompressedRunEdit[];
}

// ── Small helpers ───────────────────────────────────────────────────────────

const num = (v: string | undefined): number => {
  const n = parseFloat(v ?? "");
  return Number.isFinite(n) ? n : 0;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Is a captured CSS color visibly painted (not transparent / zero-alpha)? */
function colorPaints(c: string | undefined): boolean {
  if (c == null || c === "" || c === "transparent" || c === "none") return false;
  const m = /^rgba?\(([^)]*)\)/.exec(c);
  if (m != null) {
    const parts = m[1].split(/[,/]/).map((p) => parseFloat(p));
    if (parts.length === 4 && parts[3] === 0) return false;
  }
  return true;
}

/** Characters the glyph layer may split mid-run: scripts with no contextual
 *  shaping across a boundary (Latin + common punctuation/currency ranges).
 *  Anything else keeps its element in the chrome layer. */
function isSimpleTextChar(cp: number): boolean {
  return (
    cp === 0x09 ||
    (cp >= 0x20 && cp <= 0x7e) ||
    (cp >= 0xa0 && cp <= 0x024f) ||
    (cp >= 0x2000 && cp <= 0x206f) ||
    (cp >= 0x20a0 && cp <= 0x20cf) ||
    (cp >= 0x2100 && cp <= 0x214f)
  );
}

const WS_RE = /^[\s ]$/;

/** FNV-1a over a string → short base36 token (content-keyed identity). */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// ── Glyph extraction ────────────────────────────────────────────────────────

interface GlyphRec {
  ch: string;
  x: number;
  advance: number;
  lineKey: string;
  segY: number;
  segHeight: number;
  fill: string;
  isWs: boolean;
  styleKey: string;
  fontSize: number;
  ascent: number;
  descent: number;
  srcEl: CapturedElement;
  srcSeg: TextSegment;
}

interface FlatEl {
  el: CapturedElement;
  dfsIndex: number;
  ancestors: Set<CapturedElement>;
  paintsBox: boolean;
  zNonAuto: boolean;
}

function paintsBox(el: CapturedElement): boolean {
  const s = el.styles;
  if (colorPaints(s.backgroundColor)) return true;
  if (s.backgroundImage != null && s.backgroundImage !== "none" && s.backgroundImage !== "") return true;
  const side = (w: string | undefined, st: string | undefined): boolean => num(w) > 0 && st !== "none" && st != null;
  if (side(s.borderTopWidth, s.borderTopStyle) || side(s.borderRightWidth, s.borderRightStyle)
    || side(s.borderBottomWidth, s.borderBottomStyle) || side(s.borderLeftWidth, s.borderLeftStyle)) return true;
  if (s.boxShadow != null && s.boxShadow !== "none" && s.boxShadow !== "") return true;
  if (s.outlineStyle != null && s.outlineStyle !== "none" && num(s.outlineWidth) > 0) return true;
  if (el.elementRaster != null) return true;
  const REPLACED = new Set(["img", "canvas", "video", "svg", "iframe", "embed", "object", "picture", "input", "textarea", "select", "button", "progress", "meter", "hr"]);
  return REPLACED.has(el.tag);
}

/** Ancestor state threaded down the eligibility walk. */
interface AncestorCtx {
  blocked: boolean;
  clips: Array<{ x: number; y: number; w: number; h: number; inset: number }>;
}

function maxBorderRadius(el: CapturedElement): number {
  const s = el.styles;
  return Math.max(num(s.borderRadius), num(s.borderTopLeftRadius), num(s.borderTopRightRadius), num(s.borderBottomRightRadius), num(s.borderBottomLeftRadius));
}

/** Does this element's OWN style block glyph-layer handling for it AND its
 *  descendants (transform/filter/opacity/mask/clip/blend, propagating
 *  decorations, gradient text fills)? */
function stylesBlockSubtree(el: CapturedElement): boolean {
  const s = el.styles;
  if (s.transform != null && s.transform !== "none" && s.transform !== "") return true;
  if (s.opacity != null && s.opacity !== "" && num(s.opacity) < 1) return true;
  if (s.filter != null && s.filter !== "none" && s.filter !== "") return true;
  if (s.clipPath != null && s.clipPath !== "none" && s.clipPath !== "") return true;
  if (s.maskImage != null && s.maskImage !== "none" && s.maskImage !== "") return true;
  if (s.mask != null && s.mask !== "none" && s.mask !== "") return true;
  if (s.mixBlendMode != null && s.mixBlendMode !== "normal" && s.mixBlendMode !== "") return true;
  if (s.textDecorationLine != null && s.textDecorationLine !== "none" && s.textDecorationLine !== "") return true;
  if (s.backgroundClip === "text") return true;
  if (s.inheritedTextFillGradient != null) return true;
  return false;
}

function segmentEligible(seg: TextSegment): boolean {
  if (seg.text.length === 0) return false;
  if (seg.verticalWritingMode != null) return false;
  if (seg.xOffsets == null || seg.xOffsets.length < seg.text.length) return false;
  if (seg.rasterRect != null || seg.rasterDataUri != null) return false;
  if (seg.rasterGlyphs != null && seg.rasterGlyphs.length > 0) return false;
  if (seg.dottedCircleMarks != null && seg.dottedCircleMarks.length > 0) return false;
  if (seg.pseudoBox != null) return false;
  if (seg.textShadow != null && seg.textShadow !== "none") return false;
  for (const ch of seg.text) {
    const cp = ch.codePointAt(0);
    if (cp == null || !isSimpleTextChar(cp)) return false;
  }
  return true;
}

function elementTextEligible(el: CapturedElement, ctx: AncestorCtx): boolean {
  if (ctx.blocked) return false;
  if (el.textSegments == null || el.textSegments.length === 0) return false;
  if (el.elementRaster != null) return false;
  if (el.propagatedDecorations != null && el.propagatedDecorations.length > 0) return false;
  const s = el.styles;
  if (stylesBlockSubtree(el)) return false;
  if (s.textShadow != null && s.textShadow !== "none" && s.textShadow !== "") return false;
  if (s.textEmphasisStyle != null && s.textEmphasisStyle !== "none" && s.textEmphasisStyle !== "") return false;
  if (num(s.webkitTextStrokeWidth) > 0) return false;
  if (s.webkitTextFillColor != null && !colorPaints(s.webkitTextFillColor) && s.webkitTextFillColor !== "") return false;
  if (s.direction === "rtl") return false;
  for (const seg of el.textSegments) {
    if (!segmentEligible(seg)) return false;
    for (const clip of ctx.clips) {
      const inset = clip.inset;
      if (seg.x < clip.x + inset - 0.5 || seg.y < clip.y + inset - 0.5
        || seg.x + seg.width > clip.x + clip.w - inset + 0.5
        || seg.y + seg.height > clip.y + clip.h - inset + 0.5) return false;
    }
  }
  return true;
}

const lineKeyOf = (segY: number): string => `L${(Math.round(segY * 2) / 2).toFixed(1)}`;

function styleKeyOf(el: CapturedElement, seg: TextSegment): string {
  const s = el.styles;
  return [
    seg.fontFamily ?? s.fontFamily,
    seg.fontSize ?? s.fontSize,
    seg.fontWeight ?? s.fontWeight,
    seg.fontStyle ?? s.fontStyle ?? "normal",
    seg.fontVariant ?? "",
    s.fontVariantCaps ?? "",
    s.fontVariantEastAsian ?? "",
    s.fontVariantNumeric ?? "",
    s.fontVariantLigatures ?? "",
    s.letterSpacing,
    s.fontKerning,
    s.fontStretch,
    s.fontVariationSettings,
    s.fontFeatureSettings,
    s.lang ?? "",
  ].join("|");
}

interface ExtractedState {
  glyphs: GlyphRec[];
  /** Clone of the state tree with glyph-layer text stripped. */
  chromeTree: CapturedElement[];
}

/** Extract the glyph-layer records + the chrome (text-stripped) clone for one
 *  state's captured tree. Pure over the tree (no browser). */
function extractState(tree: CapturedElement[]): ExtractedState {
  // Pass 1: flatten in DFS (≈ paint) order for the occlusion scan.
  const flat: FlatEl[] = [];
  const walkFlat = (el: CapturedElement, ancestors: Set<CapturedElement>): void => {
    flat.push({ el, dfsIndex: flat.length, ancestors, paintsBox: paintsBox(el), zNonAuto: el.styles.zIndex != null && el.styles.zIndex !== "auto" && num(el.styles.zIndex) !== 0 });
    const next = new Set(ancestors);
    next.add(el);
    for (const c of el.children) walkFlat(c, next);
  };
  for (const root of tree) walkFlat(root, new Set());
  const flatByEl = new Map<CapturedElement, FlatEl>(flat.map((f) => [f.el, f]));

  const occluded = (el: CapturedElement): boolean => {
    const me = flatByEl.get(el);
    if (me == null || el.textSegments == null) return true;
    for (const f of flat) {
      if (f.el === el || !f.paintsBox) continue;
      if (me.ancestors.has(f.el)) continue; // ancestors paint below the text
      if (!(f.dfsIndex > me.dfsIndex || f.zNonAuto)) continue;
      for (const seg of el.textSegments) {
        const ix = Math.min(seg.x + seg.width, f.el.x + f.el.width) - Math.max(seg.x, f.el.x);
        const iy = Math.min(seg.y + seg.height, f.el.y + f.el.height) - Math.max(seg.y, f.el.y);
        if (ix > 0.5 && iy > 0.5) return true;
      }
    }
    return false;
  };

  // Pass 2: eligibility + glyph extraction.
  const glyphs: GlyphRec[] = [];
  const eligible = new Set<CapturedElement>();
  const walk = (el: CapturedElement, ctx: AncestorCtx): void => {
    if (elementTextEligible(el, ctx) && !occluded(el)) {
      eligible.add(el);
      for (const seg of el.textSegments!) {
        const xs = seg.xOffsets!;
        const fontSize = seg.fontSize ?? (num(el.styles.fontSize) || 14);
        const ascent = seg.fontAscent ?? el.fontAscent ?? fontSize * 0.8;
        const descent = el.fontDescent ?? fontSize * 0.2;
        const styleKey = styleKeyOf(el, seg);
        const fillResolved = seg.color ?? el.styles.color;
        let u = 0;
        for (const ch of seg.text) {
          const x = xs[u];
          const nextU = u + ch.length;
          let advance = nextU < seg.text.length ? xs[nextU] - x : (seg.width > 0 ? seg.x + seg.width - x : 0);
          if (!(advance > 0)) advance = fontSize * 0.6;
          const isWs = WS_RE.test(ch);
          glyphs.push({
            ch, x, advance,
            lineKey: lineKeyOf(seg.y), segY: seg.y, segHeight: seg.height,
            fill: isWs ? "" : fillResolved, isWs, styleKey,
            fontSize, ascent, descent,
            srcEl: el, srcSeg: seg,
          });
          u = nextU;
        }
      }
    }
    const childCtx: AncestorCtx = {
      blocked: ctx.blocked || stylesBlockSubtree(el),
      clips: ctx.clips,
    };
    const clip = (v: string | undefined): boolean => v === "hidden" || v === "clip" || v === "scroll" || v === "auto";
    if (clip(el.styles.overflowX) || clip(el.styles.overflowY)) {
      childCtx.clips = [...ctx.clips, { x: el.x, y: el.y, w: el.width, h: el.height, inset: maxBorderRadius(el) }];
    }
    for (const c of el.children) walk(c, childCtx);
  };
  for (const root of tree) walk(root, { blocked: false, clips: [] });

  // Chrome clone: same structure, glyph-layer text stripped.
  const strip = (el: CapturedElement): CapturedElement => {
    const copy: CapturedElement = { ...el, children: el.children.map(strip) };
    if (eligible.has(el)) {
      copy.textSegments = undefined;
      copy.text = "";
    }
    return copy;
  };
  return { glyphs, chromeTree: tree.map(strip) };
}

// ── Identity threading (the TrackedLine model, one level down) ──────────────

interface ThreadedGlyph {
  rec: GlyphRec;
  birth: number;
  /** Exclusive end state; N = survives to the run's end. */
  death: number;
  /** Painted x per state from birth (always from captures, never accumulated). */
  xs: number[];
  fills: string[];
}

interface ThreadResult {
  all: ThreadedGlyph[];
  edits: CompressedRunEdit[];
  paired: number;
  totalNext: number;
  recolored: number;
  births: number;
  deaths: number;
}

function threadGlyphs(perState: GlyphRec[][], stateCount: number): ThreadResult {
  const all: ThreadedGlyph[] = [];
  let live = new Map<string, ThreadedGlyph[]>();
  const bucket = (glyphs: GlyphRec[]): Map<string, GlyphRec[]> => {
    const m = new Map<string, GlyphRec[]>();
    for (const g of glyphs) {
      const arr = m.get(g.lineKey);
      if (arr != null) arr.push(g);
      else m.set(g.lineKey, [g]);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.x - b.x);
    return m;
  };

  for (const g of bucket(perState[0] ?? []).values()) {
    for (const rec of g) {
      const t: ThreadedGlyph = { rec, birth: 0, death: stateCount, xs: [rec.x], fills: [rec.fill] };
      all.push(t);
      const arr = live.get(rec.lineKey);
      if (arr != null) arr.push(t);
      else live.set(rec.lineKey, [t]);
    }
  }

  const edits: CompressedRunEdit[] = [];
  let paired = 0, totalNext = 0, recolored = 0, births = 0, deaths = 0;

  for (let s = 1; s < stateCount; s++) {
    const nextBuckets = bucket(perState[s] ?? []);
    const nextLive = new Map<string, ThreadedGlyph[]>();
    const lineChanges = new Map<string, { births: GlyphRec[]; deaths: ThreadedGlyph[] }>();
    let stateRecolors = 0;
    const keys = new Set([...live.keys(), ...nextBuckets.keys()]);
    for (const key of keys) {
      const prevList = (live.get(key) ?? []).slice().sort((a, b) => a.xs[a.xs.length - 1] - b.xs[b.xs.length - 1]);
      const nextList = nextBuckets.get(key) ?? [];
      totalNext += nextList.length;
      const prevSeq: AlignGlyph[] = prevList.map((t) => ({ ch: t.rec.ch, x: t.xs[t.xs.length - 1], fill: t.fills[t.fills.length - 1], styleKey: t.rec.styleKey }));
      const nextSeq: AlignGlyph[] = nextList.map((g) => ({ ch: g.ch, x: g.x, fill: g.fill, styleKey: g.styleKey }));
      const align = alignLineGlyphs(prevSeq, nextSeq);

      const survivors: ThreadedGlyph[] = [];
      for (const p of align.pairs) {
        const t = prevList[p.prevIndex];
        const g = nextList[p.nextIndex];
        t.xs.push(g.x);
        t.fills.push(g.fill);
        survivors.push(t);
        paired++;
        if (p.recolored) { recolored++; stateRecolors++; }
      }
      const changes = { births: [] as GlyphRec[], deaths: [] as ThreadedGlyph[] };
      for (const idx of align.unpairedPrev) {
        prevList[idx].death = s;
        changes.deaths.push(prevList[idx]);
        deaths++;
      }
      for (const idx of align.unpairedNext) {
        const rec = nextList[idx];
        const t: ThreadedGlyph = { rec, birth: s, death: stateCount, xs: [rec.x], fills: [rec.fill] };
        all.push(t);
        survivors.push(t);
        changes.births.push(rec);
        births++;
      }
      if (changes.births.length > 0 || changes.deaths.length > 0) lineChanges.set(key, changes);
      if (survivors.length > 0) nextLive.set(key, survivors);
    }
    live = nextLive;

    // Edit point: the line with the most changes; caret lands after the
    // rightmost born glyph, or at the close-up point of a pure deletion.
    // Recolor states are exempt: a state whose only births/deaths are
    // WHITESPACE churn while glyphs recolored is a re-tokenization (the
    // colorize-on-completion pattern — spaces re-segment across the new
    // spans while every inked glyph pairs or recolors in place). A real
    // editor's caret does not move when the tokenizer catches up, so no edit
    // point is derived and the auto-caret holds at the previous edit.
    let bestKey: string | null = null;
    let bestCount = 0;
    for (const [key, c] of lineChanges) {
      const count = c.births.length + c.deaths.length;
      if (count > bestCount) { bestCount = count; bestKey = key; }
    }
    if (bestKey != null) {
      const c = lineChanges.get(bestKey)!;
      const inkBirths = c.births.filter((g) => g.ch.trim() !== "");
      const inkDeaths = c.deaths.filter((t) => t.rec.ch.trim() !== "");
      const whitespaceOnly = inkBirths.length === 0 && inkDeaths.length === 0;
      if (!(whitespaceOnly && stateRecolors > 0)) {
        // Prefer inked glyphs for placement (the caret should sit against a
        // visible edge); pure-whitespace edits (typing a space) still count.
        const placeBirths = inkBirths.length > 0 ? inkBirths : c.births;
        const placeDeaths = inkDeaths.length > 0 ? inkDeaths : c.deaths;
        if (placeBirths.length > 0) {
          let last = placeBirths[0];
          for (const g of placeBirths) if (g.x > last.x) last = g;
          edits.push({ state: s, x: last.x + last.advance, lineTop: last.segY, ascent: last.ascent, descent: last.descent, fontSize: last.fontSize, cellWidth: last.advance });
        } else {
          let first = placeDeaths[0];
          for (const t of placeDeaths) if (t.xs[t.xs.length - 1] < first.xs[first.xs.length - 1]) first = t;
          const r = first.rec;
          edits.push({ state: s, x: first.xs[first.xs.length - 1], lineTop: r.segY, ascent: r.ascent, descent: r.descent, fontSize: r.fontSize, cellWidth: r.advance });
        }
      }
    }
  }
  return { all, edits, paired, totalNext, recolored, births, deaths };
}

// ── Glyph-group emission ────────────────────────────────────────────────────

interface GlyphGroup {
  id: string;
  glyphs: ThreadedGlyph[];
  birth: number;
  death: number;
}

/** Neutralize an eligible source element into a text-only clone base: box
 *  paint off, no children — everything that isn't the glyph run itself. */
function glyphBase(el: CapturedElement): CapturedElement {
  return {
    ...el,
    tag: "div",
    children: [],
    animId: undefined,
    animatedProperties: undefined,
    magicKey: undefined,
    cullClass: undefined,
    displayNone: undefined,
    inlineFragments: undefined,
    propagatedDecorations: undefined,
    elementRaster: undefined,
    styles: {
      ...el.styles,
      backgroundColor: "transparent",
      backgroundImage: "none",
      boxShadow: "none",
      outlineStyle: "none",
      outlineWidth: "0px",
      borderWidth: "0px",
      borderTopWidth: "0px",
      borderRightWidth: "0px",
      borderBottomWidth: "0px",
      borderLeftWidth: "0px",
      opacity: "1",
      overflowX: "visible",
      overflowY: "visible",
      listStyleType: "none",
      listStyleImage: "none",
      textOverflow: "clip",
    },
  };
}

function buildGlyphGroups(threaded: ThreadedGlyph[], uid: string): GlyphGroup[] {
  const byKey = new Map<string, ThreadedGlyph[]>();
  for (const t of threaded) {
    if (t.rec.isWs) continue; // whitespace pairs (alignment quality) but paints nothing
    const dxTl = t.xs.map((x) => round2(x - t.xs[0])).join(",");
    const fillTl = t.fills.join("~");
    const key = [t.birth, t.death, t.rec.lineKey, t.rec.styleKey, round2(t.rec.segY), round2(t.rec.segHeight), round2(t.rec.ascent), dxTl, fillTl].join("§");
    const arr = byKey.get(key);
    if (arr != null) arr.push(t);
    else byKey.set(key, [t]);
  }
  const groups: GlyphGroup[] = [];
  const sorted = [...byKey.values()].map((glyphs) => {
    glyphs.sort((a, b) => a.xs[0] - b.xs[0]);
    return glyphs;
  });
  // Deterministic paint order: by line, then x, then birth.
  sorted.sort((a, b) => a[0].rec.segY - b[0].rec.segY || a[0].xs[0] - b[0].xs[0] || a[0].birth - b[0].birth);
  for (let i = 0; i < sorted.length; i++) {
    groups.push({ id: `${uid}g${i}`, glyphs: sorted[i], birth: sorted[i][0].birth, death: sorted[i][0].death });
  }
  return groups;
}

/** The synthetic captured element for one glyph group. Anchored at the group's
 *  FINAL-state captured geometry (the rest-at-identity house rule): the group
 *  is emitted where it ends and the translateX track runs BACKWARD for earlier
 *  states, so the held final state — the only one a following frame cuts
 *  against at the run's exit — has NO composed transform and paints
 *  byte-identically to the same DOM painted directly. Every group member shares
 *  a birth, death, and shift timeline, so `xs.length` is uniform across the
 *  group and its final index is the last entry of each member's `xs`. */
function groupElement(group: GlyphGroup): CapturedElement {
  const first = group.glyphs[0];
  const last = group.glyphs[group.glyphs.length - 1];
  const minX = first.xs[first.xs.length - 1];
  const right = last.xs[last.xs.length - 1] + last.rec.advance;
  const text = group.glyphs.map((t) => t.rec.ch).join("");
  const xOffsets: number[] = [];
  for (const t of group.glyphs) {
    const fx = t.xs[t.xs.length - 1];
    for (let k = 0; k < t.rec.ch.length; k++) xOffsets.push(fx);
  }
  const src = first.rec.srcSeg;
  const seg: TextSegment = {
    text,
    x: minX,
    y: first.rec.segY,
    width: right - minX,
    height: first.rec.segHeight,
    xOffsets,
    color: first.fills[0],
    ...(src.fontSize != null ? { fontSize: src.fontSize } : {}),
    ...(src.fontWeight != null ? { fontWeight: src.fontWeight } : {}),
    ...(src.fontStyle != null ? { fontStyle: src.fontStyle } : {}),
    ...(src.fontFamily != null ? { fontFamily: src.fontFamily } : {}),
    ...(src.fontVariant != null ? { fontVariant: src.fontVariant } : {}),
    ...(src.fontAscent != null ? { fontAscent: src.fontAscent } : {}),
  };
  const el = glyphBase(first.rec.srcEl);
  el.x = minX;
  el.y = first.rec.segY;
  el.width = right - minX;
  el.height = first.rec.segHeight;
  el.text = text;
  el.animId = group.id;
  el.textSegments = [seg];
  return el;
}

// ── Chrome union (element-level pairing on captured-record byte-equality) ───

interface UnionNode {
  el: CapturedElement;
  children: UnionNode[];
  windows: Array<{ start: number; end: number }>;
  shallowKey: string;
}

const shallowKeyCache = new WeakMap<CapturedElement, string>();
function shallowKeyOf(el: CapturedElement): string {
  let k = shallowKeyCache.get(el);
  if (k == null) {
    k = fnv(JSON.stringify({ ...el, children: undefined, animId: undefined, animatedProperties: undefined, magicKey: undefined, cullClass: undefined, displayNone: undefined }));
    shallowKeyCache.set(el, k);
  }
  return k;
}

const deepKeyCache = new WeakMap<CapturedElement, string>();
function deepKeyOf(el: CapturedElement): string {
  let k = deepKeyCache.get(el);
  if (k == null) {
    k = fnv(shallowKeyOf(el) + "[" + el.children.map(deepKeyOf).join(",") + "]");
    deepKeyCache.set(el, k);
  }
  return k;
}

const lastWindow = (n: UnionNode): { start: number; end: number } => n.windows[n.windows.length - 1];

/** Deep key of a union node's ACTIVE subtree at merge time (its own record +
 *  the active variants of its children) — deep pairing must compare against
 *  what is currently visible, not the node's birth subtree. */
function activeDeepKey(n: UnionNode, s: number): string {
  const kids = n.children.filter((c) => lastWindow(c).end === s);
  return fnv(n.shallowKey + "[" + kids.map((c) => activeDeepKey(c, s)).join(",") + "]");
}

function nodeFromEl(el: CapturedElement, s: number): UnionNode {
  return {
    el,
    children: el.children.map((c) => nodeFromEl(c, s)),
    windows: [{ start: s, end: s + 1 }],
    shallowKey: shallowKeyOf(el),
  };
}

function extendDeep(n: UnionNode, s: number): void {
  const w = lastWindow(n);
  if (w.end === s) w.end = s + 1;
  for (const c of n.children) {
    if (lastWindow(c).end === s) extendDeep(c, s);
  }
}

/** Merge one state's element list into the union level. Order-preserving LCS
 *  with deep matches (subtree byte-equal → extend, no recursion) weighted over
 *  shallow matches (same element record, different children → recurse). */
function mergeLevel(unionList: UnionNode[], nextEls: CapturedElement[], s: number): void {
  const active = unionList.filter((n) => lastWindow(n).end === s);
  const n = active.length;
  const m = nextEls.length;
  const activeDeep = active.map((a) => activeDeepKey(a, s));
  const nextDeep = nextEls.map(deepKeyOf);
  const nextShallow = nextEls.map(shallowKeyOf);
  const width = m + 1;
  const score = new Float64Array((n + 1) * width);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      let best = Math.max(score[(i - 1) * width + j], score[i * width + (j - 1)]);
      const deep = activeDeep[i - 1] === nextDeep[j - 1];
      const shallow = deep || active[i - 1].shallowKey === nextShallow[j - 1];
      if (shallow) {
        const diag = score[(i - 1) * width + (j - 1)] + (deep ? 2 : 1);
        if (diag > best) best = diag;
      }
      score[i * width + j] = best;
    }
  }
  const matches: Array<{ a: number; b: number; deep: boolean }> = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    const cur = score[i * width + j];
    const deep = activeDeep[i - 1] === nextDeep[j - 1];
    const shallow = deep || active[i - 1].shallowKey === nextShallow[j - 1];
    if (shallow && Math.abs(score[(i - 1) * width + (j - 1)] + (deep ? 2 : 1) - cur) < 1e-9) {
      matches.push({ a: i - 1, b: j - 1, deep });
      i--; j--;
      continue;
    }
    if (score[(i - 1) * width + j] >= score[i * width + (j - 1)]) i--;
    else j--;
  }
  matches.reverse();

  const matchedNext = new Map<number, { node: UnionNode; deep: boolean }>();
  for (const mt of matches) matchedNext.set(mt.b, { node: active[mt.a], deep: mt.deep });

  // Apply matches; insert unmatched next elements so relative paint order is
  // preserved: after the previously applied match, before the next one.
  let cursor = 0; // insertion index for unmatched next elements
  for (let b = 0; b < m; b++) {
    const hit = matchedNext.get(b);
    if (hit != null) {
      if (hit.deep) extendDeep(hit.node, s);
      else {
        lastWindow(hit.node).end = s + 1;
        mergeLevel(hit.node.children, nextEls[b].children, s);
      }
      cursor = unionList.indexOf(hit.node) + 1;
    } else {
      let target = unionList.length;
      for (let b2 = b + 1; b2 < m; b2++) {
        const h2 = matchedNext.get(b2);
        if (h2 != null) {
          target = unionList.indexOf(h2.node);
          break;
        }
      }
      const pos = Math.max(cursor, Math.min(target, unionList.length));
      unionList.splice(pos, 0, nodeFromEl(nextEls[b], s));
      cursor = pos + 1;
    }
  }
}

function buildChromeUnion(chromeTrees: CapturedElement[][]): UnionNode[] {
  const roots = (chromeTrees[0] ?? []).map((el) => nodeFromEl(el, 0));
  for (let s = 1; s < chromeTrees.length; s++) mergeLevel(roots, chromeTrees[s], s);
  return roots;
}

// ── CSS track emission ──────────────────────────────────────────────────────

/** Shared keyframes/animation CSS builder with content-dedupe: identical
 *  keyframe bodies share one name; identical animation lists share one rule. */
class TrackCss {
  private kfByBody = new Map<string, string>();
  private kf: string[] = [];
  private rules = new Map<string, string[]>(); // animation list → selectors
  private n = 0;
  constructor(private uid: string, private totalMs: number) {}

  pct(ms: number): string {
    return `${Number(Math.max(0, Math.min(100, (ms / this.totalMs) * 100)).toFixed(4))}%`;
  }

  /** Register a step-end track over per-state values; returns the animation
   *  shorthand (or null when the value never changes). */
  track(prop: string, values: string[], boundaries: number[]): string | null {
    if (values.every((v) => v === values[0])) return null;
    const stops: string[] = [`0%{${prop}:${values[0]}}`];
    for (let s = 1; s < values.length; s++) {
      if (values[s] !== values[s - 1]) stops.push(`${this.pct(boundaries[s])}{${prop}:${values[s]}}`);
    }
    stops.push(`100%{${prop}:${values[values.length - 1]}}`);
    const body = stops.join("");
    let name = this.kfByBody.get(body);
    if (name == null) {
      name = `${this.uid}k${this.n++}`;
      this.kfByBody.set(body, name);
      this.kf.push(`@keyframes ${name}{${body}}`);
    }
    return `${name} ${(this.totalMs / 1000).toFixed(3)}s step-end infinite`;
  }

  assign(selector: string, anims: string[]): void {
    if (anims.length === 0) return;
    const key = anims.join(",");
    const sels = this.rules.get(key);
    if (sels != null) sels.push(selector);
    else this.rules.set(key, [selector]);
  }

  css(): string {
    const out = [...this.kf];
    for (const [anim, sels] of this.rules) out.push(`${sels.join(",")}{animation:${anim}}`);
    return out.join("\n");
  }
}

// ── The plan (pure; unit-testable without rendering) ────────────────────────

export interface CompressedRunPlan {
  stateCount: number;
  /** State start times (ms); boundaries[s] is when state s begins. */
  boundaries: number[];
  totalMs: number;
  groups: GlyphGroup[];
  chromeRoots: UnionNode[];
  edits: CompressedRunEdit[];
  thread: ThreadResult;
}

/** Build the pairing/threading/union plan for a run — everything except the
 *  actual SVG rendering. Exported for unit tests (not part of the package
 *  barrel); `composeCompressedRun` is the public entry. */
export function buildCompressedRunPlan(states: CompressedRunState[], idPrefix = "cr"): CompressedRunPlan {
  const stateCount = states.length;
  const boundaries: number[] = [];
  let acc = 0;
  for (const st of states) {
    boundaries.push(acc);
    acc += Math.max(0, st.holdMs);
  }
  const totalMs = Math.max(1, acc);

  const extracted = states.map((st) => extractState(st.tree));
  const thread = threadGlyphs(extracted.map((e) => e.glyphs), stateCount);
  const groups = buildGlyphGroups(thread.all, idPrefix);
  const chromeRoots = buildChromeUnion(extracted.map((e) => e.chromeTree));
  return { stateCount, boundaries, totalMs, groups, chromeRoots, edits: thread.edits, thread };
}

// ── Composition ─────────────────────────────────────────────────────────────

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Compose N captured continue+cut states into one nested animated SVG. See
 * the module header for the emission model. The input trees are not mutated.
 */
export function composeCompressedRun(states: CompressedRunState[], opts: CompressedRunOptions): CompressedRunResult {
  if (states.length === 0) throw new Error("composeCompressedRun: at least one state is required");
  const { width, height } = opts;
  const uid = (opts.idPrefix ?? "cr").replace(/[^a-zA-Z0-9_-]/g, "");
  const manageFonts = opts.manageFonts !== false;
  const log = opts.log ?? (() => {});

  if (manageFonts) {
    clearEmbeddedFonts();
    clearGlyphDefs(); // the glyph-defs registry shares the embedded-font lifecycle
  }

  // Raw flipbook size (the baseline the compressor replaces): each state
  // rendered independently, exactly as continue+cut frames would be.
  let rawBytes = 0;
  for (let s = 0; s < states.length; s++) {
    rawBytes += elementTreeToSvgInner(structuredClone(states[s].tree), width, height, `${uid}raw${s}-`, true, 2, false).length;
  }

  const plan = buildCompressedRunPlan(
    states.map((st) => ({ tree: structuredClone(st.tree), holdMs: st.holdMs })),
    uid,
  );
  const { boundaries, totalMs, stateCount } = plan;
  const css = new TrackCss(uid, totalMs);

  // Chrome union → element tree + display tracks.
  let chromeTrackCount = 0;
  const fullWindows = JSON.stringify([{ start: 0, end: stateCount }]);
  const emitUnion = (node: UnionNode, parentWindows: string): CapturedElement => {
    const mine = JSON.stringify(node.windows);
    const el: CapturedElement = { ...node.el, children: node.children.map((c) => emitUnion(c, mine)) };
    if (mine !== parentWindows) {
      const id = `${uid}c${chromeTrackCount++}`;
      el.animId = id;
      const visible: string[] = [];
      for (let s = 0; s < stateCount; s++) {
        visible.push(node.windows.some((w) => s >= w.start && s < w.end) ? "inline" : "none");
      }
      const anim = css.track("display", visible, boundaries);
      if (anim != null) css.assign(`.anim-${id}`, [anim]);
      else if (visible[0] === "none") el.displayNone = true; // never visible
    }
    return el;
  };
  const chromeTree = plan.chromeRoots.map((n) => emitUnion(n, fullWindows));

  // Glyph groups → synthetic elements + opacity/transform/fill tracks.
  const glyphEls: CapturedElement[] = [];
  for (const group of plan.groups) {
    glyphEls.push(groupElement(group));
    const first = group.glyphs[0];
    const anims: string[] = [];
    if (group.birth > 0 || group.death < stateCount) {
      const vis: string[] = [];
      for (let s = 0; s < stateCount; s++) vis.push(s >= group.birth && s < group.death ? "1" : "0");
      const a = css.track("opacity", vis, boundaries);
      if (a != null) anims.push(a);
    }
    {
      // Anchor at the final captured x (groupElement above): the offset is
      // measured BACKWARD from the last state, so the resting 100% waypoint is
      // translateX(0) — the run exits at identity and cuts byte-identically.
      const anchor = first.xs[first.xs.length - 1];
      const dxs: string[] = [];
      for (let s = 0; s < stateCount; s++) {
        const idx = Math.max(0, Math.min(first.xs.length - 1, s - group.birth));
        dxs.push(`translateX(${round2(first.xs[idx] - anchor)}px)`);
      }
      const a = css.track("transform", dxs, boundaries);
      if (a != null) anims.push(a);
    }
    css.assign(`.anim-${group.id}`, anims);
    {
      const fills: string[] = [];
      for (let s = 0; s < stateCount; s++) {
        const idx = Math.max(0, Math.min(first.fills.length - 1, s - group.birth));
        fills.push(first.fills[idx]);
      }
      const a = css.track("fill", fills, boundaries);
      // A CSS animation on the descendants outranks the `fill` presentation
      // attribute the renderer emits, so the recolor steps land per state.
      if (a != null) css.assign(`.anim-${group.id} *`, [a]);
    }
  }

  // Render the two layers through the production pipeline. Chrome first
  // (below), glyphs above — the occlusion guard demoted anything a later
  // box-painting element overlaps, so this flattening is paint-safe.
  const chromeInner = elementTreeToSvgInner(chromeTree, width, height, `${uid}c-`, true, 2, false);
  const glyphInner = glyphEls.length > 0 ? elementTreeToSvgInner(glyphEls, width, height, `${uid}g-`, true, 2, false) : "";

  // Auto-caret from the per-state edit points (docs/101 machinery).
  let caretMarkup = "";
  if (opts.caret != null && opts.caret !== false && plan.edits.length > 0) {
    const caretOpts = typeof opts.caret === "object" ? opts.caret : {};
    const track: ResolvedTextTrack = {
      shape: caretOpts.shape ?? "bar",
      color: caretOpts.color ?? "#111111",
      barWidthPx: DEFAULT_CARET_WIDTH_PX,
      blinkMs: CARET_BLINK_MS,
      waypoints: [],
      hides: [],
      selections: [],
    };
    const pointOf = (e: CompressedRunEdit) => ({
      x: e.x, baselineY: e.lineTop + e.ascent, ascentPx: e.ascent, descentPx: e.descent,
      fontSize: e.fontSize, cellWidthPx: e.cellWidth,
    });
    // Parked at the first upcoming edit point from t=0 (reads as "about to
    // type here"), then stepping to each edit's after-position at its boundary.
    const firstEdit = plan.edits[0];
    track.waypoints.push({ t: 0, point: { ...pointOf(firstEdit), x: firstEdit.x - firstEdit.cellWidth } });
    for (const e of plan.edits) track.waypoints.push({ t: boundaries[e.state], point: pointOf(e) });
    caretMarkup = textTrackMarkup(track, totalMs, 0);
  }

  const fontFaceCss = manageFonts ? getEmbeddedFontFaceCss() : "";
  const trackCss = css.css();
  const styleCss = `${fontFaceCss !== "" ? fontFaceCss + "\n" : ""}${trackCss}`;
  const bgRect = opts.background != null ? `<rect width="${width}" height="${height}" fill="${esc(opts.background)}"/>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<style>${styleCss}</style>${bgRect}${chromeInner}${glyphInner}${caretMarkup}</svg>`;

  const pairingStats: CompressedRunPairingStats = {
    states: stateCount,
    glyphs: plan.thread.totalNext,
    glyphsPaired: plan.thread.paired,
    pairedPct: plan.thread.totalNext > 0 ? plan.thread.paired / plan.thread.totalNext : 1,
    recolored: plan.thread.recolored,
    births: plan.thread.births,
    deaths: plan.thread.deaths,
    groupCount: plan.groups.length,
    chromeTrackCount,
    rawBytes,
    compressedBytes: svg.length - fontFaceCss.length,
  };
  const kb = (n: number): string => (n / 1024).toFixed(1);
  log(`compress: run of ${stateCount} states, ${(pairingStats.pairedPct * 100).toFixed(1)}% glyphs paired, ${kb(rawBytes)} KB → ${kb(svg.length)} KB`);

  return { svg, width, height, durationMs: totalMs, pairingStats, edits: plan.edits };
}

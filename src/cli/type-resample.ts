/**
 * DM-1556 (docs/93 roadmap §2): per-keystroke real-site re-sampling.
 *
 * The `typing` overlay (docs/93 v1) SYNTHESIZES a field's text as a monospace
 * `<text>` reveal painted on TOP of a single captured frame. That's cheap and
 * exact for the caret, but it renders OUR font and OUR characters — it can't show
 * what the *page* does to the input: input masking / auto-formatting (a card
 * number growing `4242…` → `4242 4242 …`), validation styling, IME composition,
 * or the field's own font. This module is the high-fidelity counterpart: it
 * actually drives the live field one keystroke at a time and **re-captures the
 * page after each keystroke**, so every intermediate state is the browser's own
 * paint — masking and all.
 *
 * The N per-keystroke captures are composed into ONE self-contained animated SVG
 * via the public `generateAnimatedSvg` (a flipbook: each state `cut`s to the next
 * on the keystroke clock, the final typed state holds). That nested SVG becomes a
 * single outer animate frame's `svgContent` — exactly the `cast` / `template`
 * nesting pattern (docs/67, docs/73) — so it needs NO change to the animator and
 * keeps the outer loop's 1 config-frame ↔ 1 animation-frame invariant (the cursor
 * overlay, magic-move bridge, and frame-tree indexing all rely on it).
 *
 * Capture-side cost is O(N) full captures — heavier than the overlay path, which
 * is why it's gated behind an explicit per-frame `typeResample` field rather than
 * being the default.
 */

import type { Page } from "@playwright/test";
import type { AnimationFrame, AnimationOverlay } from "../animation/index.js";
import type { BlinkOverlay } from "../animation/overlay-schema.js";
import { generateAnimatedSvg } from "../animation/index.js";
import { caretShapeRect, type CaretShape } from "../animation/caret-metrics.js";
import { captureElementTree } from "../capture/index.js";
import { elementTreeToSvgInner } from "../render/index.js";
import { namespaceEmbeddedAnimatedSvg } from "../animation/embed-namespace.js";
import { cullElementsOutsideViewBox } from "../tree-ops/index.js";

/** Resolved (defaults applied) per-keystroke re-sampling spec. */
export interface TypeResampleSpec {
  /** The field to type into (input / textarea). Must match exactly one focusable element. */
  selector: string;
  /** The keystrokes to send, one captured state per character. */
  text: string;
  /** Per-keystroke hold in ms (the flipbook step). */
  speed: number;
  /** Hold before the first keystroke (ms). Folded into the empty-field state. */
  delay: number;
  /** Hold on the final, fully-typed state (ms) before the internal loop restarts. */
  tailMs: number;
  /** Clear the field before typing (so the re-sample starts from empty). */
  clear: boolean;
  /** Draw the field's REAL caret (measured from `selectionEnd`) as a blinking bar. */
  caret: boolean;
  /** DM-1591: caret shape. `"auto"` (default) honors the field's computed CSS
   *  `caret-shape`; `bar`/`block`/`underscore` force a shape regardless. */
  caretShape: CaretShape | "auto";
  /** DM-1581: capture ONLY the field's region per keystroke and overlay it on a
   *  single static base, cutting output size from O(N·page) to O(page + N·field).
   *  Opt-in — with it OFF (default) every keystroke re-captures the full page, so
   *  changes OUTSIDE the field (a live char counter, validation message) animate
   *  too; with it ON only the field animates (its own masking/validation is still
   *  faithful, since the field itself is re-captured). */
  regionOnly: boolean;
}

/** Defaults for the optional `typeResample` config fields (docs/93). */
export const TYPE_RESAMPLE_DEFAULTS = {
  speed: 60,
  delay: 0,
  tailMs: 700,
  clear: true,
  caret: true,
  caretShape: "auto",
  regionOnly: false,
} as const;

/**
 * Resolve the raw config `typeResample` object into a fully-defaulted spec.
 * Pure (no browser) so the defaulting is unit-testable.
 */
export function resolveTypeResampleSpec(raw: {
  selector: string;
  text: string;
  speed?: number;
  delay?: number;
  tailMs?: number;
  clear?: boolean;
  caret?: boolean;
  caretShape?: CaretShape | "auto";
  regionOnly?: boolean;
}): TypeResampleSpec {
  return {
    selector: raw.selector,
    text: raw.text,
    speed: raw.speed ?? TYPE_RESAMPLE_DEFAULTS.speed,
    delay: raw.delay ?? TYPE_RESAMPLE_DEFAULTS.delay,
    tailMs: raw.tailMs ?? TYPE_RESAMPLE_DEFAULTS.tailMs,
    clear: raw.clear ?? TYPE_RESAMPLE_DEFAULTS.clear,
    caret: raw.caret ?? TYPE_RESAMPLE_DEFAULTS.caret,
    caretShape: raw.caretShape ?? TYPE_RESAMPLE_DEFAULTS.caretShape,
    regionOnly: raw.regionOnly ?? TYPE_RESAMPLE_DEFAULTS.regionOnly,
  };
}

/**
 * The per-state hold durations for a `charCount`-character re-sample. There are
 * `charCount + 1` states (0 chars typed … `charCount` chars typed). State 0 (the
 * empty field) holds `delay + speed` (the initial pause plus the first keystroke
 * interval); the final state holds `tailMs`; every state in between holds `speed`.
 * Pure so the flipbook timeline is unit-testable without a browser.
 */
export function typeResampleDurations(charCount: number, speed: number, delay: number, tailMs: number): number[] {
  const states = charCount + 1;
  const durs: number[] = [];
  for (let j = 0; j < states; j++) {
    if (j === 0) durs.push(delay + speed);
    else if (j === states - 1) durs.push(tailMs);
    else durs.push(speed);
  }
  return durs;
}

/** A measured caret in page-viewport coordinates (= canvas coords). The final
 *  rect is derived node-side via {@link caretShapeRect} so the bar/block/
 *  underscore geometry lives in one shared, tested place (DM-1591). */
interface CaretMeasurement {
  /** Insertion-point x (the caret's left edge). */
  x: number;
  /** Text baseline y. */
  baselineY: number;
  ascentPx: number;
  descentPx: number;
  /** Advance of the insertion cell (a space at end-of-text) — block/underscore width. */
  cellWidthPx: number;
  fontSize: number;
  shape: CaretShape;
  color: string;
}

/**
 * Measure the live field's caret position from `selectionEnd`, in viewport
 * coordinates. Uses the field's OWN computed font + its current (masked) value,
 * so the caret tracks the edge of what the browser actually shows — not the raw
 * keystrokes. Returns `null` when the element isn't a text input/textarea or the
 * measurement can't be taken (best-effort; the caller then omits the caret).
 */
async function measureCaret(page: Page, selector: string, shapeOverride: CaretShape | "auto"): Promise<CaretMeasurement | null> {
  return page.evaluate(({ sel, shapeOverride }: { sel: string; shapeOverride: string }) => {
    const el = document.querySelector(sel);
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return null;
    const cs = getComputedStyle(el);
    const idx = el.selectionEnd ?? el.value.length;
    const shown = el.value.slice(0, idx);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (ctx == null) return null;
    // `cs.font` is Chromium's resolved shorthand — the exact face the field paints.
    ctx.font = cs.font;
    // `canvas.measureText` IGNORES letter-/word-spacing, but the field's real
    // layout (which Domotion renders the value at, via the captured per-char
    // offsets) INCLUDES them — so without this the caret lands ~letterSpacing×chars
    // too far LEFT and overlaps the last glyph. Set them on the context (supported
    // in Chromium); fall back to adding them manually on older engines.
    const spaced = ctx as CanvasRenderingContext2D & { letterSpacing?: string; wordSpacing?: string };
    let textW: number;
    if ("letterSpacing" in spaced) {
      spaced.letterSpacing = cs.letterSpacing;
      spaced.wordSpacing = cs.wordSpacing;
      textW = ctx.measureText(shown).width;
    } else {
      const ls = parseFloat(cs.letterSpacing) || 0;
      const ws = parseFloat(cs.wordSpacing) || 0;
      const spaceCount = (shown.match(/ /g) ?? []).length;
      textW = ctx.measureText(shown).width + shown.length * ls + spaceCount * ws;
    }
    const r = el.getBoundingClientRect();
    const num = (v: string): number => {
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : 0;
    };
    const fontSize = num(cs.fontSize) || 16;
    const x = r.left + num(cs.borderLeftWidth) + num(cs.paddingLeft) + textW - el.scrollLeft;
    // Caret geometry matching how Blink actually draws a text caret (see the
    // `caretMetrics` note in `src/animation/caret-metrics.ts`, shared with the
    // typing overlay):
    //  - HEIGHT = the font's metrics height (ascent + descent) — that is the text
    //    fragment / line-box height Blink uses for a bar caret, NOT cap height (too
    //    short) nor a fixed 1.2×em multiplier. `fontBoundingBox{Ascent,Descent}`
    //    is Chromium's own font-metrics height.
    //  - POSITION: center the caret within the LINE BOX, and place the line box the
    //    same way `captureInputValue` places the value text — a single-line <input>
    //    centers its line in the content box; a <textarea> lays lines from the top —
    //    so the caret and the captured text share one line box and can't diverge.
    const fm = ctx.measureText("Hg");
    const fmAsc = fm.fontBoundingBoxAscent || 0;
    const fmDesc = fm.fontBoundingBoxDescent || 0;
    const fontBox = fmAsc + fmDesc;
    // Exact ascent/descent when the canvas exposes them, else the 1.15×em split.
    const ascentPx = fontBox > 0 ? fmAsc : fontSize * 0.9;
    const descentPx = fontBox > 0 ? fmDesc : fontSize * 0.25;
    const caretHeight = Math.round(ascentPx + descentPx);
    const lineH = num(cs.lineHeight) || fontBox || fontSize * 1.2;
    const contentTop = r.top + num(cs.borderTopWidth) + num(cs.paddingTop);
    const contentHeight = r.height - num(cs.borderTopWidth) - num(cs.borderBottomWidth) - num(cs.paddingTop) - num(cs.paddingBottom);
    const lineTop = el instanceof HTMLTextAreaElement
      ? contentTop
      : contentTop + Math.max(0, (contentHeight - lineH) / 2);
    // Caret box centered in the line box; baseline sits `ascent` below the box top.
    const boxTop = lineTop + (lineH - caretHeight) / 2;
    const baselineY = boxTop + ascentPx;
    // Insertion cell = a space at end-of-text (the block/underscore width).
    const cellWidthPx = ctx.measureText(" ").width || fontSize * 0.5;
    const caretColor = cs.caretColor && cs.caretColor !== "auto" ? cs.caretColor : cs.color;
    // Shape: an explicit override wins; else the field's computed CSS caret-shape
    // (Blink resolves `auto` → a bar for text); else bar.
    const valid = ["bar", "block", "underscore"];
    // `caret-shape` is a newer property not in the CSSStyleDeclaration lib types.
    const computed = cs.getPropertyValue("caret-shape").trim();
    const shape = (shapeOverride !== "auto" && valid.includes(shapeOverride))
      ? shapeOverride
      : (computed != null && valid.includes(computed)) ? computed : "bar";
    return { x, baselineY, ascentPx, descentPx, cellWidthPx, fontSize, shape: shape as "bar" | "block" | "underscore", color: caretColor };
  }, { sel: selector, shapeOverride });
}

/** Build the blinking-caret overlay for one re-sampled state, or `undefined`.
 *  Applies the shared {@link caretShapeRect} so the bar / block / underscore
 *  geometry matches the typing overlay (DM-1591). The bar keeps its historical
 *  1.5px width + 0.75 corner radius; block/underscore are square-cornered. */
function caretOverlay(m: CaretMeasurement | null): AnimationOverlay[] | undefined {
  if (m == null) return undefined;
  const rect = caretShapeRect({
    shape: m.shape, x: m.x, baselineY: m.baselineY,
    ascentPx: m.ascentPx, descentPx: m.descentPx, cellWidthPx: m.cellWidthPx,
    fontSize: m.fontSize, barWidthPx: 1.5,
  });
  const overlay: BlinkOverlay = {
    kind: "blink",
    x: Math.round(rect.x * 100) / 100,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    color: m.color,
    periodMs: 1060,
    radius: m.shape === "bar" ? 0.75 : undefined,
  };
  if (rect.opacity < 1) overlay.fillOpacity = rect.opacity;
  return [overlay];
}

/**
 * Drive `spec.selector` one keystroke at a time, re-capturing the page after each
 * keystroke, and compose the per-keystroke captures into one nested animated SVG.
 * The returned `svgContent` is ready to drop into an outer animate frame (XML
 * prolog stripped, document-global names namespaced with `framePrefix`); pair it
 * with `periodMs` as the frame's `embeddedAnimationPeriodMs` so the animator
 * re-anchors the typing to restart when the frame is shown.
 *
 * Assumes the page is already loaded / on the right DOM (the caller handles
 * continue-vs-load, ready-waits, and webfont discovery, exactly as for a normal
 * captured frame). `page.focus` / `page.keyboard.type` throw if the selector
 * matches nothing, giving the same fail-fast as a `fill` action.
 */
export async function buildTypeResampleAnimation(
  page: Page,
  spec: TypeResampleSpec,
  opts: { width: number; height: number; framePrefix: string; log: (msg: string) => void },
): Promise<{ svgContent: string; periodMs: number; rootBg: string | undefined }> {
  const { width, height, framePrefix, log } = opts;
  const chars = [...spec.text]; // code-point aware (surrogate pairs count as one keystroke)
  log(`  type-resample: typing ${chars.length} keystroke${chars.length === 1 ? "" : "s"} into "${spec.selector}", re-capturing after each…`);

  // Start from a clean, focused field so the re-sample begins at "empty".
  if (spec.clear) {
    await page.fill(spec.selector, ""); // fires the field's own input handlers (masking resets)
  }
  await page.focus(spec.selector);

  const durations = typeResampleDurations(chars.length, spec.speed, spec.delay, spec.tailMs);
  const subFrames: AnimationFrame[] = [];
  let rootBg: string | undefined;

  // DM-1581: `regionOnly` captures ONE full-page base (the static backdrop) and
  // then only the FIELD's subtree per keystroke — the flipbook overlays just the
  // changing field on that base, so the output is O(page + N·field) instead of
  // O(N·page). `captureElementTree(selector)` renders the field at its own
  // absolute coords (transparent elsewhere), so it drops cleanly over the base.
  let baseInner = "";
  for (let j = 0; j <= chars.length; j++) {
    if (j > 0) {
      // Type ONE character through the real keyboard so the page's keydown /
      // input / keyup handlers run (masking, auto-format, validation).
      await page.keyboard.type(chars[j - 1]);
    }
    if (spec.regionOnly && j === 0) {
      // Capture the full page ONCE (empty state) as the static base backdrop.
      const baseTree = await captureElementTree(page, "body", { x: 0, y: 0, width, height });
      cullElementsOutsideViewBox(baseTree, width, height, undefined, 0, 1);
      rootBg = baseTree[0]?.styles?.rootBgComputed;
      baseInner = elementTreeToSvgInner(baseTree, width, height, `${framePrefix}base-`, true, 2, false);
    }
    // Per-keystroke capture: only the field's subtree when `regionOnly`, else the
    // whole page (so out-of-field changes animate too).
    const captureSel = spec.regionOnly ? spec.selector : "body";
    const tree = await captureElementTree(page, captureSel, { x: 0, y: 0, width, height });
    cullElementsOutsideViewBox(tree, width, height, undefined, 0, 1);
    if (j === 0 && !spec.regionOnly) rootBg = tree[0]?.styles?.rootBgComputed;
    const svgContent = elementTreeToSvgInner(tree, width, height, `${framePrefix}s${j}-`, true, 2, false);
    const overlays = spec.caret ? caretOverlay(await measureCaret(page, spec.selector, spec.caretShape)) : undefined;
    subFrames.push({
      svgContent,
      duration: durations[j],
      transition: { type: "cut", duration: 0 },
      ...(overlays != null ? { overlays } : {}),
    });
  }

  // Compose the flipbook. fontFaceCss is "" — the per-keystroke captures render
  // with `includeEmbeddedFontCss=false` above, so their glyphs accumulate into
  // the OUTER animate run's shared embedded-font builder (collected once after the
  // outer loop). The nested SVG therefore defers its @font-face to that block,
  // exactly like a `cast` frame's `manageFonts: false`.
  // In `regionOnly` mode the field flipbook is a TRANSPARENT overlay (no
  // background — the static base + a bg rect paint it in the wrapper below).
  const nested = generateAnimatedSvg({
    width,
    height,
    frames: subFrames,
    fontFaceCss: "",
    ...(rootBg != null && !spec.regionOnly ? { background: rootBg } : {}),
  });
  // Namespace document-global names (ids, `.f-N` frame classes, `@keyframes`,
  // `--scene-dur`) so they can't collide with the outer animation or sibling
  // nested frames — but NOT the font-family refs (they point at the shared
  // builder's already-unique `dmfN` names), same as `cast`.
  const namespaced = namespaceEmbeddedAnimatedSvg(nested, `${framePrefix}${spec.regionOnly ? "fld" : ""}`, { namespaceFonts: false });
  const flipbook = namespaced.replace(/^<\?xml[^>]*\?>\s*/, "");
  const periodMs = durations.reduce((a, b) => a + b, 0);

  if (spec.regionOnly) {
    // Static base UNDER the animated field flipbook (a nested <svg>), + the root
    // background so the transparent overlay reads on the right canvas color.
    const bgRect = rootBg != null ? `<rect width="${width}" height="${height}" fill="${rootBg}" />` : "";
    const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${bgRect}${baseInner}${flipbook}</svg>`;
    return { svgContent, periodMs, rootBg };
  }
  return { svgContent: flipbook, periodMs, rootBg };
}

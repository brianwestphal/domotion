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
import { generateAnimatedSvg } from "../animation/index.js";
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
}

/** Defaults for the optional `typeResample` config fields (docs/93). */
export const TYPE_RESAMPLE_DEFAULTS = {
  speed: 60,
  delay: 0,
  tailMs: 700,
  clear: true,
  caret: true,
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
}): TypeResampleSpec {
  return {
    selector: raw.selector,
    text: raw.text,
    speed: raw.speed ?? TYPE_RESAMPLE_DEFAULTS.speed,
    delay: raw.delay ?? TYPE_RESAMPLE_DEFAULTS.delay,
    tailMs: raw.tailMs ?? TYPE_RESAMPLE_DEFAULTS.tailMs,
    clear: raw.clear ?? TYPE_RESAMPLE_DEFAULTS.clear,
    caret: raw.caret ?? TYPE_RESAMPLE_DEFAULTS.caret,
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

/** A measured caret rectangle in page-viewport coordinates (= canvas coords). */
interface CaretRect {
  x: number;
  y: number;
  height: number;
  color: string;
}

/**
 * Measure the live field's caret position from `selectionEnd`, in viewport
 * coordinates. Uses the field's OWN computed font + its current (masked) value,
 * so the caret tracks the edge of what the browser actually shows — not the raw
 * keystrokes. Returns `null` when the element isn't a text input/textarea or the
 * measurement can't be taken (best-effort; the caller then omits the caret).
 */
async function measureCaret(page: Page, selector: string): Promise<CaretRect | null> {
  return page.evaluate((sel: string) => {
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
    const textW = ctx.measureText(shown).width;
    const r = el.getBoundingClientRect();
    const num = (v: string): number => {
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : 0;
    };
    const fontSize = num(cs.fontSize) || 16;
    const caretHeight = Math.round(fontSize * 1.2);
    const x = r.left + num(cs.borderLeftWidth) + num(cs.paddingLeft) + textW - el.scrollLeft;
    // Content box (inside border + padding). A single-line <input> vertically
    // CENTERS its text within this box, so the caret must center too — pinning it
    // to the content top (paddingTop) left it high/misaligned vs the centered text.
    // A <textarea> lays text from the top, so keep the caret at the content top there.
    const contentTop = r.top + num(cs.borderTopWidth) + num(cs.paddingTop);
    const contentHeight = r.height - num(cs.borderTopWidth) - num(cs.borderBottomWidth) - num(cs.paddingTop) - num(cs.paddingBottom);
    const y = el instanceof HTMLTextAreaElement
      ? contentTop
      : contentTop + Math.max(0, (contentHeight - caretHeight) / 2);
    const caretColor = cs.caretColor && cs.caretColor !== "auto" ? cs.caretColor : cs.color;
    return { x, y, height: caretHeight, color: caretColor };
  }, selector);
}

/** Build the blinking-caret overlay for one re-sampled state, or `undefined`. */
function caretOverlay(rect: CaretRect | null): AnimationOverlay[] | undefined {
  if (rect == null) return undefined;
  return [
    {
      kind: "blink",
      x: Math.round(rect.x * 100) / 100,
      y: rect.y,
      width: 1.5,
      height: rect.height,
      color: rect.color,
      periodMs: 1060,
      radius: 0.75,
    },
  ];
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

  for (let j = 0; j <= chars.length; j++) {
    if (j > 0) {
      // Type ONE character through the real keyboard so the page's keydown /
      // input / keyup handlers run (masking, auto-format, validation).
      await page.keyboard.type(chars[j - 1]);
    }
    const tree = await captureElementTree(page, "body", { x: 0, y: 0, width, height });
    cullElementsOutsideViewBox(tree, width, height, undefined, 0, 1);
    if (j === 0) rootBg = tree[0]?.styles?.rootBgComputed;
    const svgContent = elementTreeToSvgInner(tree, width, height, `${framePrefix}s${j}-`, true, 2, false);
    const overlays = spec.caret ? caretOverlay(await measureCaret(page, spec.selector)) : undefined;
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
  const nested = generateAnimatedSvg({
    width,
    height,
    frames: subFrames,
    fontFaceCss: "",
    ...(rootBg != null ? { background: rootBg } : {}),
  });
  // Namespace document-global names (ids, `.f-N` frame classes, `@keyframes`,
  // `--scene-dur`) so they can't collide with the outer animation or sibling
  // nested frames — but NOT the font-family refs (they point at the shared
  // builder's already-unique `dmfN` names), same as `cast`.
  const namespaced = namespaceEmbeddedAnimatedSvg(nested, framePrefix, { namespaceFonts: false });
  const svgContent = namespaced.replace(/^<\?xml[^>]*\?>\s*/, "");
  const periodMs = durations.reduce((a, b) => a + b, 0);
  return { svgContent, periodMs, rootBg };
}

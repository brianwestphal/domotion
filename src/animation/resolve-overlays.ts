/**
 * `resolveOverlays(page, overlays)` — DM-1132.
 *
 * Lower an overlay's selector `anchor` (`{ selector, at, dx, dy }`) and a typing
 * overlay's `maxWidth: "anchor"` into concrete `x` / `y` / `wrapWidth` against a
 * live Playwright page, returning overlays ready for `generateAnimatedSvg`.
 *
 * This is the resolution step that previously lived only inside
 * `composeAnimateConfig` (so it was reachable only by declarative-config users).
 * Imperative callers of the scripting API (`captureElementTree` +
 * `generateAnimatedSvg`) can now opt into selector anchoring without adopting
 * the whole JSON config — and the CLI runner calls the SAME engine
 * (`resolveAnchoredOverlays`), so the two can't diverge.
 *
 * The anchor point is resolved against the element's **border** box (its
 * `getBoundingClientRect`), matching the declarative anchor's long-standing
 * behavior; `maxWidth: "anchor"` resolves to the element's **content** width
 * (`clientWidth` − horizontal padding). The corner/edge math is shared with
 * `contentBox` via `boxAnchorPoint` (DM-1133).
 */

import type { Page } from "@playwright/test";
import type { CapturedElement } from "../capture/types.js";
import { boxAnchorPoint, type BoxAnchor } from "../capture/content-box.js";
import { firstLineBaseline } from "./caret-metrics.js";
import type { TypingOverlay, TapOverlay, SvgOverlay, BlinkOverlay, ShineOverlay, InteractOverlay, AnimationOverlay } from "./overlay-schema.js";

/** Anchor an overlay to an element's box — same vocabulary as the declarative config's `anchor`. */
export interface OverlayAnchor {
  /** CSS selector resolved in page context (the live DOM, not the SVG output). */
  selector: string;
  /** Which corner / edge / center of the element's border box to anchor at. Default `"top-left"`. */
  at?: BoxAnchor;
  /** Horizontal nudge from the anchor point (px). */
  dx?: number;
  /** Vertical nudge from the anchor point (px). */
  dy?: number;
  /**
   * DM-1750 (typing overlays only): resolve the overlay's `y` to the anchored
   * element's FIRST-LINE text baseline instead of a border-box point. A typing
   * overlay's `y` IS its typed text's baseline, so with this the overlay glyphs
   * land exactly on the element's own text — no hand-tuned ascent `dy`. `x`
   * still comes from `at`'s horizontal component (+ `dx`); `dy` remains an
   * additional nudge from the measured baseline (default 0). Errors on any
   * other overlay kind.
   */
  baseline?: boolean;
}

/**
 * The input to `resolveOverlays`: a resolved overlay PLUS optional selector
 * anchoring sugar. After resolution the `anchor` / `maxWidth` keys are gone and
 * `x` / `y` (and a typing overlay's `wrapWidth`) are concrete — i.e. a plain
 * `AnimationOverlay`. (Note: the `svg` kind here takes the resolved `innerSvg`,
 * not a file `src` — file inlining is a CLI-only concern, not page resolution.)
 */
export type AnchoredOverlay =
  | (TypingOverlay & { anchor?: OverlayAnchor; maxWidth?: "anchor" | number })
  | (TapOverlay & { anchor?: OverlayAnchor })
  | (SvgOverlay & { anchor?: OverlayAnchor })
  | (BlinkOverlay & { anchor?: OverlayAnchor })
  | (ShineOverlay & { anchor?: OverlayAnchor })
  | (InteractOverlay & { anchor?: OverlayAnchor });

/**
 * The border box + content width of an anchored element, measured in page
 * context. `borderRadius` is the element's computed top-left `border-radius` in
 * px, used to auto-round a `shine` overlay's clip (DM-1549/DM-1551) or an
 * `interact` overlay's fill/ring (DM-1565) to the anchored element's corners.
 * `lineBox` (only measured when the anchor asks for `baseline`, DM-1750) carries
 * the raw first-line metrics — canvas `measureText("Hg")` font box + content-box
 * placement — from which `firstLineBaseline` derives the text baseline
 * node-side (the same math as the `typeResample` caret).
 */
interface AnchorBox {
  x: number; y: number; width: number; height: number; contentWidth: number; borderRadius: number; fontFamily: string; fontSize: number;
  lineBox?: { lineHeightPx: number; fontAscentPx: number; fontDescentPx: number; contentTop: number; contentHeight: number; centerInContentBox: boolean };
}

/**
 * Structural shape the shared engine resolves over. Both the public
 * `resolveOverlays` (resolved overlays + anchor sugar) and the CLI's authoring
 * overlays (which additionally carry an svg `src`) satisfy this, so they share
 * one implementation. Unknown keys (e.g. `text`, `src`, `caret`) pass through.
 */
interface AnchorableOverlay {
  kind: string;
  x?: number;
  y?: number;
  wrapWidth?: number;
  /** A `shine`/`interact` overlay's box, auto-sized from the anchor when omitted (DM-1549/DM-1565). */
  width?: number;
  height?: number;
  /** A `shine`/`interact` overlay's corner radius, auto-derived from the anchor (DM-1551/DM-1565). */
  radius?: number;
  anchor?: OverlayAnchor;
  maxWidth?: "anchor" | number;
  /** Typing overlay: `"anchor"` auto-resolves the font from the anchored field (DM-1579). */
  fontFamily?: string;
  fontSize?: number;
}

/**
 * Shared resolution engine (DM-1132). For each overlay: if it carries an
 * `anchor`, measure the selector's border box + content width and set `x` / `y`
 * from the requested corner + `dx`/`dy`; for a typing overlay's `maxWidth`, set
 * `wrapWidth` to the content width (`"anchor"`) or the given px. The `anchor` /
 * `maxWidth` keys are stripped from the result. Overlays without either pass
 * through unchanged. A missing anchor selector is a hard error (matching the
 * declarative anchor's fail-fast policy); `label` customizes the message
 * (the CLI prefixes the frame index).
 */
export async function resolveAnchoredOverlays<T extends AnchorableOverlay>(
  page: Page,
  overlays: T[] | undefined,
  label: (kind: string) => string = (kind) => `resolveOverlays: ${kind} overlay`,
): Promise<T[] | undefined> {
  if (overlays == null) return undefined;
  const out: T[] = [];
  for (const ov of overlays) {
    const anchor = ov.anchor;
    const maxWidth = ov.kind === "typing" ? ov.maxWidth : undefined;
    // DM-1579: a typing overlay with `fontFamily: "anchor"` adopts the anchored
    // field's own computed font (family + size), so "type into this real field"
    // matches without restating the font.
    const fontFromAnchor = ov.kind === "typing" && ov.fontFamily === "anchor";
    if (anchor == null && maxWidth == null && !fontFromAnchor) {
      out.push(ov);
      continue;
    }

    // DM-1750: `anchor.baseline` is a typing-only refinement — a typing
    // overlay's `y` is a text baseline, other kinds' `y` is a box corner, so a
    // baseline anchor on them is an authoring error, not a silent no-op.
    const wantBaseline = anchor?.baseline === true;
    if (wantBaseline && ov.kind !== "typing") {
      throw new Error(`${label(ov.kind)} anchor.baseline is only supported on typing overlays (a typing overlay's y is its text baseline; a ${ov.kind} overlay's y is a box corner)`);
    }

    let box: AnchorBox | null = null;
    if (anchor != null) {
      box = await page.evaluate(({ sel, wantBaseline }: { sel: string; wantBaseline: boolean }): AnchorBox | null => {
        // tsx/esbuild wraps named arrow consts in `__name(fn, "name")` for nicer
        // stack traces; that helper isn't in page.evaluate's serialized scope, so
        // polyfill it before the first named const below constructs (the same
        // footgun the webfont-discovery evaluate documents in capture/index.ts).
        if (typeof (window as unknown as { __name?: unknown }).__name === "undefined") {
          (window as unknown as { __name: (fn: unknown) => unknown }).__name = (fn) => fn;
        }
        const el = document.querySelector(sel);
        if (el == null) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const num = (v: string): number => {
          const n = parseFloat(v);
          return Number.isFinite(n) ? n : 0;
        };
        const padL = num(cs.paddingLeft);
        const padR = num(cs.paddingRight);
        const box: {
          x: number; y: number; width: number; height: number; contentWidth: number; borderRadius: number; fontFamily: string; fontSize: number;
          lineBox?: { lineHeightPx: number; fontAscentPx: number; fontDescentPx: number; contentTop: number; contentHeight: number; centerInContentBox: boolean };
        } = {
          x: r.x, y: r.y, width: r.width, height: r.height,
          contentWidth: Math.max(0, el.clientWidth - padL - padR),
          // The computed top-left border-radius (px), to auto-round a `shine`
          // overlay's clip (DM-1549/DM-1551) or `interact` fill/ring (DM-1565).
          borderRadius: num(cs.borderTopLeftRadius),
          // The field's own font (DM-1579) — a typing overlay's `fontFamily:
          // "anchor"` adopts it so the typed text matches the real field.
          fontFamily: cs.fontFamily,
          fontSize: num(cs.fontSize) || 16,
        };
        if (wantBaseline) {
          // DM-1750: raw first-line metrics for the baseline anchor — the
          // element's computed font measured on a canvas (Chromium's own font
          // metrics) + the content-box placement inputs. The placement math
          // itself runs node-side (`firstLineBaseline`), shared with the
          // `typeResample` caret so the two surfaces cannot disagree.
          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d");
          const fm = ctx != null ? ((ctx.font = cs.font), ctx.measureText("Hg")) : null;
          box.lineBox = {
            lineHeightPx: num(cs.lineHeight),
            fontAscentPx: fm?.fontBoundingBoxAscent ?? 0,
            fontDescentPx: fm?.fontBoundingBoxDescent ?? 0,
            contentTop: r.top + num(cs.borderTopWidth) + num(cs.paddingTop),
            contentHeight: r.height - num(cs.borderTopWidth) - num(cs.borderBottomWidth) - num(cs.paddingTop) - num(cs.paddingBottom),
            // A single-line <input> centers its one line box in the content
            // box; <textarea> / block content lays line boxes from the top.
            centerInContentBox: el instanceof HTMLInputElement,
          };
        }
        return box;
      }, { sel: anchor.selector, wantBaseline });
      if (box == null) throw new Error(`${label(ov.kind)} anchor selector "${anchor.selector}" matched no element`);
    }

    out.push(applyAnchorBox(ov, box, label));
  }
  return out;
}

/**
 * The anchor arithmetic, factored out of the page resolver (DM-1799) so the
 * tree-side resolver below runs byte-for-byte the same math. PURE: everything
 * page-specific ends at producing the `AnchorBox`. Strips the authoring-only
 * `anchor` / `maxWidth` keys and writes the concrete coordinates.
 */
function applyAnchorBox<T extends AnchorableOverlay>(
  ov: T,
  box: AnchorBox | null,
  label: (kind: string) => string,
): T {
  const anchor = ov.anchor;
  const maxWidth = ov.kind === "typing" ? ov.maxWidth : undefined;
  const fontFromAnchor = ov.kind === "typing" && ov.fontFamily === "anchor";
  const wantBaseline = anchor?.baseline === true;
  if (wantBaseline && ov.kind !== "typing") {
    throw new Error(`${label(ov.kind)} anchor.baseline is only supported on typing overlays (a typing overlay's y is its text baseline; a ${ov.kind} overlay's y is a box corner)`);
  }
  {
    // Strip the authoring-only keys; set the resolved coordinates below.
    const resolved = { ...ov };
    const mut = resolved as Record<string, unknown>;
    delete mut.anchor;
    if (ov.kind === "typing") delete mut.maxWidth;

    if (anchor != null && box != null) {
      const [ax, ay] = boxAnchorPoint(box, anchor.at ?? "top-left", anchor.dx ?? 0, anchor.dy ?? 0);
      resolved.x = ax;
      resolved.y = ay;
      if (wantBaseline) {
        // DM-1750: the typing overlay's `y` is its text baseline — land it on
        // the anchored element's measured first-line baseline. `x` keeps the
        // `at` horizontal component (+ dx) resolved above; `dy` nudges from the
        // baseline (default 0). The math is `firstLineBaseline` (shared with
        // the `typeResample` caret) over the raw page-side line-box metrics.
        if (box.lineBox == null) throw new Error(`${label(ov.kind)} anchor.baseline measurement failed for selector "${anchor.selector}" (no canvas 2d context in the page)`);
        resolved.y = firstLineBaseline({ fontSize: box.fontSize, ...box.lineBox }).baselineY + (anchor.dy ?? 0);
      }
      // A `shine` (DM-1549/1551) or `interact` (DM-1565) overlay auto-SIZES to the
      // box it's anchored to (an explicit positive width/height still wins) and
      // auto-rounds its clip / fill-ring to the element's computed border-radius
      // (an explicit `radius` wins). With the default `at: "top-left"` anchor,
      // (x, y) is the box's top-left, so the treatment covers the element.
      if (ov.kind === "shine" || ov.kind === "interact") {
        if (!(ov.width != null && ov.width > 0)) resolved.width = box.width;
        if (!(ov.height != null && ov.height > 0)) resolved.height = box.height;
        if (ov.radius == null) resolved.radius = box.borderRadius;
      }
    }
    if (ov.kind === "typing" && maxWidth != null) {
      // DM-1134: maxWidth controls WRAPPING, so it resolves into `wrapWidth`
      // (the mask width then defaults to the wrap width in the renderer).
      if (maxWidth === "anchor") {
        if (box == null) throw new Error(`${label(ov.kind)} maxWidth:"anchor" requires an anchor`);
        resolved.wrapWidth = box.contentWidth;
      } else {
        resolved.wrapWidth = maxWidth;
      }
    }
    if (fontFromAnchor) {
      // DM-1579: adopt the anchored field's font family, and its font SIZE too
      // unless the overlay pinned an explicit size.
      if (box == null) throw new Error(`${label(ov.kind)} fontFamily:"anchor" requires an anchor`);
      resolved.fontFamily = box.fontFamily;
      if (ov.fontSize == null) resolved.fontSize = box.fontSize;
    }
    return resolved;
  }
}

/**
 * Public primitive: resolve selector-anchored overlays against a live page into
 * concrete-coordinate overlays ready for `generateAnimatedSvg`. Imperative
 * callers building their own per-frame composition get the same selector
 * anchoring the declarative config has, without adopting the whole config.
 *
 * ```ts
 * const [overlay] = await resolveOverlays(page, [
 *   { kind: "typing", text, anchor: { selector: "#field", at: "top-left", dx: 2, dy: 2 }, maxWidth: "anchor", caret: true },
 * ]);
 * // overlay.x / overlay.y are concrete; maxWidth:"anchor" resolved into overlay.wrapWidth (DM-1134).
 * ```
 */
export async function resolveOverlays(page: Page, overlays: AnchoredOverlay[]): Promise<AnimationOverlay[]> {
  // DM-1574: the input `AnchoredOverlay` union carries all six overlay kinds and
  // the shared engine resolves each structurally (shine + interact anchoring now
  // work), so the resolved result can be ANY kind. The old
  // `(Typing|Tap|Svg|Blink)Overlay[]` return type silently dropped `Shine` +
  // `Interact` — an unsound narrowing. After resolution the `anchor`/`maxWidth`
  // sugar is stripped, leaving a plain `AnimationOverlay` (the schema's full
  // discriminated union), which is exactly what this returns.
  const resolved = await resolveAnchoredOverlays(page, overlays);
  return (resolved ?? []) as AnimationOverlay[];
}

// ── DM-1799: the TREE-side anchor resolver ─────────────────────────────────
//
// Everything above measures the anchor in PAGE context, which is exact whenever
// the page is standing at the moment the overlay belongs to. Inside a compressed
// run using per-region timing (`regions` + `advances`, docs/43 §11.1) it is not:
// states advancing disjoint regions share one whole-page capture, and each
// state's tree is ASSEMBLED afterwards by taking each region's subtree from the
// round holding that region's own state. The live page never stands in the
// assembled configuration, so a state's anchor into a region on a different
// schedule resolves against whatever that region happened to hold in the round
// the state was driven in (DM-1793).
//
// The assembled tree does hold every region at its own state — and it carries
// every input the page probe measures, including the canvas-measured
// `fontAscent` / `fontDescent` a `baseline` anchor needs (captured since DM-587
// for the renderer's own baseline math). So the same anchor arithmetic can run
// against the tree, and then it is exact for every state.
//
// This is deliberately ADDITIVE. The page resolver stays the default: it is
// correct wherever the page can stand at the right moment, it is what every
// shipped golden was measured under, and it can see things the tree never will
// (anything capture drops). Only the per-region-timing path needs this.

/** Locate a captured element by the `data-domotion-anim` id stamped on it. */
function findByAnimId(tree: readonly CapturedElement[], animId: string): CapturedElement | null {
  for (const el of tree) {
    if (el.animId === animId) return el;
    const hit = el.children != null ? findByAnimId(el.children, animId) : null;
    if (hit != null) return hit;
  }
  return null;
}

const numPx = (v: string | undefined): number => {
  const n = parseFloat(v ?? "");
  return Number.isFinite(n) ? n : 0;
};

/**
 * Build the same `AnchorBox` the page probe produces, from a captured element.
 *
 * Two documented differences from the page measurement, both consequences of
 * reading a serialized tree rather than a live layout:
 *
 *  - **content width** is `width − horizontal borders − horizontal padding`,
 *    where the page uses `clientWidth − padding`. They agree except when the
 *    element has a vertical scrollbar, which `clientWidth` excludes and the
 *    captured `width` does not. A scrollable anchor target is the one case this
 *    can differ, and it differs by the scrollbar's width.
 *  - **`fontAscent` / `fontDescent` are pre-scaled** by the element's cumulative
 *    ancestor scale at capture (DM-587), while the page probe measures the
 *    unscaled computed font. Inside a `transform: scale()` subtree the captured
 *    value is the one that matches painted output, so this resolver is if
 *    anything the more faithful of the two — but they are not interchangeable.
 */
function anchorBoxFromCaptured(el: CapturedElement): AnchorBox {
  const st = el.styles;
  const padL = numPx(st.paddingLeft);
  const padR = numPx(st.paddingRight);
  const bL = numPx(st.borderLeftWidth);
  const bR = numPx(st.borderRightWidth);
  const bT = numPx(st.borderTopWidth);
  const bB = numPx(st.borderBottomWidth);
  const box: AnchorBox = {
    x: el.x, y: el.y, width: el.width, height: el.height,
    contentWidth: Math.max(0, el.width - bL - bR - padL - padR),
    borderRadius: numPx(st.borderTopLeftRadius),
    fontFamily: st.fontFamily,
    fontSize: numPx(st.fontSize) || 16,
  };
  // Only meaningful on a text-bearing element; `fontAscent` is 0 elsewhere,
  // which the caller turns into the same authoring error the page path raises.
  if (el.fontAscent != null && el.fontAscent > 0) {
    box.lineBox = {
      lineHeightPx: numPx(st.lineHeight),
      fontAscentPx: el.fontAscent,
      fontDescentPx: el.fontDescent ?? 0,
      contentTop: el.y + bT + numPx(st.paddingTop),
      contentHeight: el.height - bT - bB - numPx(st.paddingTop) - numPx(st.paddingBottom),
      centerInContentBox: el.tag === "input",
    };
  }
  return box;
}

/**
 * Resolve anchored overlays against an ASSEMBLED captured tree instead of the
 * live page — the tree-side counterpart of `resolveAnchoredOverlays`, sharing
 * its arithmetic exactly (`applyAnchorBox`), so the two cannot drift.
 *
 * Anchor targets are located by the `data-domotion-anim` id the caller stamped
 * before capture, via `animIdForSelector`. That is the mechanism `regions` and
 * `textTracks` already use; a CSS-selector engine over the tree is deliberately
 * NOT built. A selector with no stamp, or a stamp with no captured element, is a
 * hard error — the same fail-fast policy the page path has.
 */
export function resolveAnchoredOverlaysInTree<T extends AnchorableOverlay>(
  tree: readonly CapturedElement[],
  overlays: T[] | undefined,
  animIdForSelector: (selector: string) => string | undefined,
  label: (kind: string) => string = (kind) => `resolveOverlays: ${kind} overlay`,
): T[] | undefined {
  if (overlays == null) return undefined;
  return overlays.map((ov) => {
    const anchor = ov.anchor;
    const needsBox = anchor != null
      || (ov.kind === "typing" && (ov.maxWidth != null || ov.fontFamily === "anchor"));
    if (!needsBox) return ov;
    let box: AnchorBox | null = null;
    if (anchor != null) {
      const animId = animIdForSelector(anchor.selector);
      const el = animId != null ? findByAnimId(tree, animId) : null;
      if (el == null) throw new Error(`${label(ov.kind)} anchor selector "${anchor.selector}" matched no captured element`);
      box = anchorBoxFromCaptured(el);
    }
    return applyAnchorBox(ov, box, label);
  });
}

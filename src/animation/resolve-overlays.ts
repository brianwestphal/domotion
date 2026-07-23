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
    out.push(resolved);
  }
  return out;
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

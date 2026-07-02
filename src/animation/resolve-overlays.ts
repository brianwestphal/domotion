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
import type { TypingOverlay, TapOverlay, SvgOverlay, BlinkOverlay, ShineOverlay, InteractOverlay } from "./overlay-schema.js";

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
 */
interface AnchorBox { x: number; y: number; width: number; height: number; contentWidth: number; borderRadius: number }

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
    if (anchor == null && maxWidth == null) {
      out.push(ov);
      continue;
    }

    let box: AnchorBox | null = null;
    if (anchor != null) {
      box = await page.evaluate((sel: string): AnchorBox | null => {
        const el = document.querySelector(sel);
        if (el == null) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const padL = parseFloat(cs.paddingLeft) || 0;
        const padR = parseFloat(cs.paddingRight) || 0;
        return {
          x: r.x, y: r.y, width: r.width, height: r.height,
          contentWidth: Math.max(0, el.clientWidth - padL - padR),
          // The computed top-left border-radius (px), to auto-round a `shine`
          // overlay's clip (DM-1549/DM-1551) or `interact` fill/ring (DM-1565).
          borderRadius: parseFloat(cs.borderTopLeftRadius) || 0,
        };
      }, anchor.selector);
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
export async function resolveOverlays(page: Page, overlays: AnchoredOverlay[]): Promise<(TypingOverlay | TapOverlay | SvgOverlay | BlinkOverlay)[]> {
  const resolved = await resolveAnchoredOverlays(page, overlays);
  return (resolved ?? []) as (TypingOverlay | TapOverlay | SvgOverlay | BlinkOverlay)[];
}

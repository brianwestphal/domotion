/**
 * Animated-SVG compositing (DM-1323).
 *
 * `composeAnimatedLayers` stacks several **already-rendered** SVGs — each of
 * which may itself be *animated* (a `cast`, a `scroll` capture, a `template`, an
 * `animate` result, or another composite) — into one self-contained animated SVG,
 * z-ordered, each placed at a position/size and on its own timeline, **with its
 * animation intact.** This is the general "nest one animated thing inside another
 * and keep it animating" capability (the website→window→OS-context composite),
 * built on two existing pieces:
 *
 *  - `namespaceEmbeddedAnimatedSvg` (doc 73) makes each layer's document-global
 *    names (ids, `@keyframes`, classes, fonts, `--scene-dur`) unique so layers
 *    can't collide — the id-space-collision concern, already solved.
 *  - `offsetEmbeddedAnimatedSvgTimeline` (DM-1319, generalized here for
 *    hold/stretch/loop) re-anchors each layer's internal timeline so it starts at
 *    its own `start` within the composite master loop, **independent** of the
 *    container — the user's "start time and durations independent of the
 *    container" requirement.
 *
 * Because the output is itself a complete animated SVG, composites nest
 * recursively (a composite is a valid layer in a parent composite) — every layer
 * of every level stays animated.
 *
 * A layer may also carry **layer-level animations** — move / scale / fade / clip
 * the whole layer over the composite timeline — which compose with the layer's
 * own internal animation (the resize-the-window-mid-playback case: the window
 * layer scales while the terminal inside it keeps running). Per the project's
 * one-transform-animation-per-element rule, layer transforms live on the layer's
 * own wrapper group, separate from the nested content's animations.
 */

import { namespaceEmbeddedAnimatedSvg } from "./embed-namespace.js";
import { offsetEmbeddedAnimatedSvgTimeline, type EmbeddedTimelineMode } from "./embed-timeline.js";

/** A layer-level animation: move / scale / fade / transform / resize-clip the whole layer. */
export interface CompositeLayerAnimation {
  /**
   * What to animate. `scale`/`translateX`/`translateY` are convenience transforms;
   * `transform` takes raw transform strings in `from`/`to`; `opacity` fades.
   *
   * `clipScaleX` / `clipScaleY` **resize the layer's visible box** (its clip)
   * without scaling its *contents* — the way to make a window grow/shrink while
   * its title-bar buttons keep their size and the inner content reflows. `from`/
   * `to` are scale factors (1 = full, 0.64 = 64% of the box). Implemented as a
   * `clip-path: url(#…)` whose clip-rect is `transform: scaleX/Y`-animated (a
   * transform — robust and cross-browser, unlike animating `clip-path: inset()`
   * directly, which fails over nested-SVG content). The clip shrinks from the
   * `transformOrigin` edge (default `left` for X, `top` for Y).
   */
  property: "scale" | "translateX" | "translateY" | "opacity" | "transform" | "clipScaleX" | "clipScaleY";
  from: string | number;
  to: string | number;
  /** When the layer animation starts in the composite timeline (ms). Default 0. */
  start?: number;
  /** How long it runs (ms). Default: to the end of the master loop. */
  duration?: number;
  /** CSS timing function. Default `"ease"`. */
  easing?: string;
  /** `transform-origin` for transform properties. Default `"0 0"` (the layer's top-left). */
  transformOrigin?: string;
}

/** One composited layer. */
export interface CompositeLayer {
  /** A complete SVG document (animated or static) to nest as this layer. */
  svg: string;
  /** The layer content's own animation period (ms). Omit / 0 for a static layer. */
  periodMs?: number;
  /** Intrinsic content size; parsed from the SVG's `width`/`height` or `viewBox` when omitted. */
  contentWidth?: number;
  contentHeight?: number;
  /** Placement in the composite (px). `x`/`y` default 0; `width`/`height` default the content size. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Clip the layer to its placement rect (rounded by `clipRadius`). Default false. */
  clip?: boolean;
  clipRadius?: number;
  /** When the layer's own animation begins in the composite timeline (ms). Default 0. */
  start?: number;
  /** Timeline mode for the layer's own animation (`hold` | `stretch` | `loop`). Default `hold`. */
  mode?: EmbeddedTimelineMode;
  /** For `stretch`, the window (ms) to scale the content into. Default = `periodMs`. */
  duration?: number;
  /** Layer-level animations (move / scale / fade / transform the whole layer). */
  animations?: CompositeLayerAnimation[];
  /** Optional label for ids/debugging (sanitized). */
  label?: string;
}

export interface ComposeLayersOptions {
  width: number;
  height: number;
  /** Master loop length (ms). Default: the longest layer end (content + layer animations). */
  durationMs?: number;
  /** Background fill for the whole composite. Omit / `"transparent"` → transparent. */
  background?: string;
}

export interface CompositeResult {
  /** The complete composited `<svg>` document. */
  svg: string;
  width: number;
  height: number;
  /** The master loop length actually used (ms). */
  durationMs: number;
}

const fmt = (n: number): string => String(Number(n.toFixed(4)));
const clampPct = (p: number): number => (p < 0 ? 0 : p > 100 ? 100 : p);

/** Best-effort intrinsic size of an SVG document (width/height attrs, else viewBox). */
function svgIntrinsicSize(svg: string): { w: number; h: number } {
  const open = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
  const wAttr = /\bwidth="([\d.]+)(px)?"/i.exec(open);
  const hAttr = /\bheight="([\d.]+)(px)?"/i.exec(open);
  if (wAttr != null && hAttr != null) return { w: parseFloat(wAttr[1]), h: parseFloat(hAttr[1]) };
  const vb = /\bviewBox="[\d.\s-]*?([\d.]+)\s+([\d.]+)"/i.exec(open);
  if (vb != null) return { w: parseFloat(vb[1]), h: parseFloat(vb[2]) };
  return { w: 0, h: 0 };
}

/** Strip the XML prolog + outer `<svg…>…</svg>` wrapper, keeping inner markup (incl. `<style>`). */
function innerOf(svg: string): string {
  return svg
    .replace(/^\s*<\?xml[^>]*\?>\s*/i, "")
    .replace(/^\s*<!doctype[^>]*>\s*/i, "")
    .replace(/^[\s\S]*?<svg[^>]*>/i, "")
    .replace(/<\/svg>\s*$/i, "");
}

/** Render a non-clip layer-animation endpoint to its CSS value (transform string / opacity). */
function renderAnimValue(property: "scale" | "translateX" | "translateY" | "opacity" | "transform", v: string | number): string {
  switch (property) {
    case "scale": return `scale(${v})`;
    case "translateX": return `translateX(${typeof v === "number" ? `${v}px` : v})`;
    case "translateY": return `translateY(${typeof v === "number" ? `${v}px` : v})`;
    case "opacity": return `${v}`;
    case "transform": return `${v}`;
  }
}

/**
 * Stack `layers` (z-ordered, first = bottom) into one self-contained animated SVG.
 */
export function composeAnimatedLayers(layers: CompositeLayer[], opts: ComposeLayersOptions): CompositeResult {
  const { width, height } = opts;

  // Resolve each layer's geometry + intrinsic size first so we can size the master.
  const resolved = layers.map((layer, i) => {
    const intrinsic = (layer.contentWidth != null && layer.contentHeight != null)
      ? { w: layer.contentWidth, h: layer.contentHeight }
      : svgIntrinsicSize(layer.svg);
    const w = layer.width ?? intrinsic.w;
    const h = layer.height ?? intrinsic.h;
    const x = layer.x ?? 0;
    const y = layer.y ?? 0;
    const start = layer.start ?? 0;
    const mode: EmbeddedTimelineMode = layer.mode ?? "hold";
    const period = layer.periodMs ?? 0;
    const windowMs = mode === "stretch" ? (layer.duration ?? period) : period;
    // A layer's contribution to the master length: its content window + its
    // layer-animation ends. A `loop` layer doesn't extend the master (it just
    // keeps cycling); count one cycle so a lone loop layer still has a sensible
    // length.
    let end = start + (mode === "loop" ? period : windowMs);
    for (const a of layer.animations ?? []) end = Math.max(end, (a.start ?? 0) + (a.duration ?? 0));
    return { layer, i, intrinsic, x, y, w, h, start, mode, period, windowMs, end };
  });

  const master = Math.max(
    1,
    opts.durationMs ?? Math.ceil(Math.max(0, ...resolved.map((r) => r.end))),
  );
  const masterSec = master / 1000;

  const styleBlocks: string[] = [];
  const groups: string[] = [];

  for (const r of resolved) {
    const token = `c${r.i}_`;
    // 1. Namespace the layer's global names so it can't collide with siblings…
    let content = namespaceEmbeddedAnimatedSvg(r.layer.svg, token);
    // 2. …then re-anchor its internal timeline to its own start within the master.
    if (r.period > 0) {
      content = offsetEmbeddedAnimatedSvgTimeline(content, {
        periodMs: r.period, startMs: r.start, masterMs: master,
        mode: r.mode, windowMs: r.windowMs,
      });
    }
    // 3. Strip the outer wrapper and re-nest at the layer's box (a nested <svg>
    //    with a viewBox scales the content to width×height and positions it).
    const inner = innerOf(content);
    const vb = `0 0 ${r.intrinsic.w || r.w} ${r.intrinsic.h || r.h}`;
    let nested = `<svg x="${fmt(r.x)}" y="${fmt(r.y)}" width="${fmt(r.w)}" height="${fmt(r.h)}" viewBox="${vb}" preserveAspectRatio="none" overflow="visible">${inner}</svg>`;

    if (r.layer.clip === true) {
      const clipId = `${token}clip`;
      const rad = r.layer.clipRadius ?? 0;
      styleBlocks.push(`<clipPath id="${clipId}"><rect x="${fmt(r.x)}" y="${fmt(r.y)}" width="${fmt(r.w)}" height="${fmt(r.h)}"${rad ? ` rx="${fmt(rad)}"` : ""}/></clipPath>`);
      nested = `<g clip-path="url(#${clipId})">${nested}</g>`;
    }

    // 4. Layer-level animations, each held before its start and after its end so
    //    it sits still outside its window. Transform / opacity animations go on
    //    the layer's wrapping `<g>` (accumulated into one `animation:` decl, the
    //    magic-move rule pattern, so several don't override each other).
    const groupDecls: string[] = [];
    let transformOrigin: string | null = null;
    const clipScales: CompositeLayerAnimation[] = [];
    (r.layer.animations ?? []).forEach((a, ai) => {
      if (a.property === "clipScaleX" || a.property === "clipScaleY") { clipScales.push(a); return; }
      const name = `${token}a${ai}`;
      const sPct = clampPct(((a.start ?? 0) / master) * 100);
      const ePct = clampPct((((a.start ?? 0) + (a.duration ?? master)) / master) * 100);
      const prop = a.property === "opacity" ? "opacity" : "transform";
      const from = renderAnimValue(a.property, a.from);
      const to = renderAnimValue(a.property, a.to);
      styleBlocks.push(`<style>@keyframes ${name}{0%,${fmt(sPct)}%{${prop}:${from}}${fmt(ePct)}%,100%{${prop}:${to}}}</style>`);
      groupDecls.push(`${name} ${fmt(masterSec)}s ${a.easing ?? "ease"} infinite`);
      if (a.property !== "opacity" && transformOrigin == null) transformOrigin = a.transformOrigin ?? "0 0";
    });
    const groupStyle = groupDecls.length > 0
      ? ` style="${transformOrigin != null ? `transform-box:fill-box;transform-origin:${transformOrigin};` : ""}animation:${groupDecls.join(",")}"`
      : "";

    // 5. clipScaleX/Y — resize the layer's visible BOX (not its contents) by
    //    transform-scaling a clip-rect. Robust across nested-SVG content (unlike
    //    animating `clip-path: inset()` directly). All clip-scale anims on a layer
    //    share one clip-rect + one transform animation (scale(sx,sy)).
    let clipAttr = "";
    if (clipScales.length > 0) {
      const sx = clipScales.find((a) => a.property === "clipScaleX");
      const sy = clipScales.find((a) => a.property === "clipScaleY");
      const anchor = clipScales[0];
      const name = `${token}clipa`;
      const clipId = `${token}rclip`;
      const sPct = clampPct(((anchor.start ?? 0) / master) * 100);
      const ePct = clampPct((((anchor.start ?? 0) + (anchor.duration ?? master)) / master) * 100);
      const fromT = `scale(${Number(sx?.from ?? 1)},${Number(sy?.from ?? 1)})`;
      const toT = `scale(${Number(sx?.to ?? 1)},${Number(sy?.to ?? 1)})`;
      // Origin: shrink from the left/top edge by default (a window's fixed corner).
      const ox = sx?.transformOrigin ?? "left";
      const oy = sy?.transformOrigin ?? "top";
      const rad = r.layer.clipRadius != null ? ` rx="${fmt(r.layer.clipRadius)}"` : "";
      styleBlocks.push(`<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse"><rect class="${token}clipper" x="${fmt(r.x)}" y="${fmt(r.y)}" width="${fmt(r.w)}" height="${fmt(r.h)}"${rad}/></clipPath>`);
      styleBlocks.push(`<style>@keyframes ${name}{0%,${fmt(sPct)}%{transform:${fromT}}${fmt(ePct)}%,100%{transform:${toT}}} .${token}clipper{transform-box:fill-box;transform-origin:${ox} ${oy};animation:${name} ${fmt(masterSec)}s ${anchor.easing ?? "ease"} infinite}</style>`);
      clipAttr = ` clip-path="url(#${clipId})"`;
    }

    groups.push(`<g class="${token}layer"${clipAttr}${groupStyle}>${nested}</g>`);
  }

  const bg = opts.background != null && opts.background !== "" && opts.background !== "transparent" && opts.background !== "rgba(0, 0, 0, 0)"
    ? `<rect width="${width}" height="${height}" fill="${opts.background}"/>`
    : "";

  const defs = styleBlocks.filter((s) => s.startsWith("<clipPath")).join("");
  const css = styleBlocks.filter((s) => s.startsWith("<style")).join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    (defs ? `<defs>${defs}</defs>` : "") +
    css +
    bg +
    groups.join("") +
    `</svg>`;

  return { svg, width, height, durationMs: master };
}

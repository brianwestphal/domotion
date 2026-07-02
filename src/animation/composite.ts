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

import { isTransparentBackground } from "../utils/transparent-background.js";
import { namespaceEmbeddedAnimatedSvg } from "./embed-namespace.js";
import { offsetEmbeddedAnimatedSvgTimeline, type EmbeddedTimelineMode } from "./embed-timeline.js";
import { parseSvgIntrinsicSize, fmt, clampPct } from "./svg-meta.js";

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
  /**
   * DM-1331: this layer was rendered through the composite's SHARED embedded-font
   * builder (`manageFonts:false`), so its `@font-face` is deferred to the single
   * top-level block in `ComposeLayersOptions.fontFaceCss`. Its `dmfN` family
   * references are kept un-prefixed during namespacing so they resolve against
   * that shared block — letting several cast layers that use the same font embed
   * its (union) subset once instead of one subset per layer. Set by
   * `composeCompositeConfig` for cast layers; leave off for self-contained SVGs.
   */
  deferFonts?: boolean;
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
  /**
   * DM-1331: one `@font-face` block shared by all `deferFonts` layers, emitted
   * once at the top of the composite. Produced by rendering those layers through
   * a shared embedded-font builder (`getEmbeddedFontFaceCss()`).
   */
  fontFaceCss?: string;
}

export interface CompositeResult {
  /** The complete composited `<svg>` document. */
  svg: string;
  width: number;
  height: number;
  /** The master loop length actually used (ms). */
  durationMs: number;
}


/** Strip the XML prolog + outer `<svg…>…</svg>` wrapper, keeping inner markup (incl. `<style>`). */
function innerOf(svg: string): string {
  return svg
    .replace(/^\s*<\?xml[^>]*\?>\s*/i, "")
    .replace(/^\s*<!doctype[^>]*>\s*/i, "")
    .replace(/^[\s\S]*?<svg[^>]*>/i, "")
    .replace(/<\/svg>\s*$/i, "");
}

/**
 * DM-1529: resolve a clip-scale `transformOrigin` (keyword or length) to an
 * ABSOLUTE userspace coordinate along one axis, given the clip-rect's start
 * (`base`) and `size` on that axis. Used so the clip-scale pivots about an
 * explicit SVG-userspace point instead of `transform-box:fill-box` + a keyword,
 * which Firefox ignores on a `<clipPath>` `<rect>` (it pivots about the viewport
 * origin instead). Keywords map to the rect's edges/center; `<n>%` is a fraction
 * of the box; `<n>px` is an offset from the box start; anything else → the start
 * edge.
 */
function resolveClipOriginPx(origin: string, base: number, size: number): number {
  switch (origin) {
    case "left": case "top": return base;
    case "right": case "bottom": return base + size;
    case "center": return base + size / 2;
  }
  const pct = /^([-\d.]+)%$/.exec(origin);
  if (pct != null) return base + (size * parseFloat(pct[1])) / 100;
  const px = /^([-\d.]+)px$/.exec(origin);
  if (px != null) return base + parseFloat(px[1]);
  return base;
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
      : parseSvgIntrinsicSize(layer.svg) ?? { w: 0, h: 0 };
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

  // `defsParts` holds `<clipPath>` defs; `styleParts` holds CSS (keyframes + rules)
  // that all go in one combined `<style>`. Two arrays (vs one filtered by string
  // prefix) so a future entry can't silently land in neither bucket.
  const defsParts: string[] = [];
  const styleParts: string[] = [];
  const groups: string[] = [];

  for (const r of resolved) {
    const token = `c${r.i}_`;
    // 1. Namespace the layer's global names so it can't collide with siblings.
    //    `deferFonts` layers keep their `dmfN` font families UN-prefixed (DM-1331):
    //    they were rendered through a shared embedded-font builder, so their
    //    families are already globally unique and point at the single top-level
    //    `@font-face` block (`opts.fontFaceCss`) — prefixing them would dangle the
    //    reference. The id/keyframe/class namespacing still runs.
    let content = namespaceEmbeddedAnimatedSvg(r.layer.svg, token, { namespaceFonts: r.layer.deferFonts !== true });
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
      defsParts.push(`<clipPath id="${clipId}"><rect x="${fmt(r.x)}" y="${fmt(r.y)}" width="${fmt(r.w)}" height="${fmt(r.h)}"${rad ? ` rx="${fmt(rad)}"` : ""}/></clipPath>`);
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
      styleParts.push(`@keyframes ${name}{0%,${fmt(sPct)}%{${prop}:${from}}${fmt(ePct)}%,100%{${prop}:${to}}}`);
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
      // DM-1529: resolve the origin to an EXPLICIT userspace point (px in the SVG
      // coordinate system) rather than `transform-box:fill-box` + a keyword.
      // Firefox does NOT honor `transform-box:fill-box` on a `<clipPath>`'s child
      // `<rect>` — it pivots the scale about the SVG viewport origin (0,0) instead
      // of the rect's own box, so the clip shrank toward (0,0) and its right/bottom
      // edge pulled inward (content clipped too narrow). Chromium/WebKit honored
      // fill-box, so it only broke in Firefox. Computing the origin in userspace
      // (relative to the rect's real x/y/w/h) needs no fill-box and is identical
      // across engines.
      const ox = resolveClipOriginPx(sx?.transformOrigin ?? "left", r.x, r.w);
      const oy = resolveClipOriginPx(sy?.transformOrigin ?? "top", r.y, r.h);
      const rad = r.layer.clipRadius != null ? ` rx="${fmt(r.layer.clipRadius)}"` : "";
      defsParts.push(`<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse"><rect class="${token}clipper" x="${fmt(r.x)}" y="${fmt(r.y)}" width="${fmt(r.w)}" height="${fmt(r.h)}"${rad}/></clipPath>`);
      styleParts.push(`@keyframes ${name}{0%,${fmt(sPct)}%{transform:${fromT}}${fmt(ePct)}%,100%{transform:${toT}}} .${token}clipper{transform-origin:${fmt(ox)}px ${fmt(oy)}px;animation:${name} ${fmt(masterSec)}s ${anchor.easing ?? "ease"} infinite}`);
      clipAttr = ` clip-path="url(#${clipId})"`;
    }

    groups.push(`<g class="${token}layer"${clipAttr}${groupStyle}>${nested}</g>`);
  }

  // Transparent (no backdrop rect) for every transparent CSS form — keywords,
  // zero-alpha hex, zero-alpha rgba()/hsla() — via the canonical predicate.
  const bg = isTransparentBackground(opts.background ?? "")
    ? ""
    : `<rect width="${width}" height="${height}" fill="${opts.background}"/>`;

  const defs = defsParts.join("");
  // DM-1331: the shared embedded-font block for `deferFonts` layers goes first in
  // the one combined <style>, ahead of the layer-animation keyframes.
  const fontCss = opts.fontFaceCss != null && opts.fontFaceCss !== "" ? opts.fontFaceCss : "";
  const styleInner = fontCss + styleParts.join("");
  let svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    (defs ? `<defs>${defs}</defs>` : "") +
    (styleInner !== "" ? `<style>${styleInner}</style>` : "") +
    bg +
    groups.join("") +
    `</svg>`;

  // DM-1329: collapse byte-identical embedded fonts across layers. Each layer
  // carries its own `@font-face` payload (a base64 TTF), so two layers built from
  // the same font + glyph subset — a reused layer, or the same composite nested
  // twice — embed the same big payload twice. Drop the duplicates and point their
  // family references at the surviving copy.
  svg = dedupeCompositeFonts(svg);

  return { svg, width, height, durationMs: master };
}

/**
 * Drop duplicate `@font-face` blocks (same descriptors + same base64 `src`) from
 * a composited SVG, renaming the removed families' references to the surviving
 * copy. The renderer emits byte-identical payloads for identical glyph subsets,
 * so layers that share a font + glyph set duplicate the (heavy) base64; this
 * collapses each unique payload to one rule. Only exact-payload duplicates are
 * merged — layers with *different* glyph subsets of the same font keep their own
 * subset (merging those would need re-subsetting; tracked separately).
 */
export function dedupeCompositeFonts(svg: string): string {
  // Invariants this relies on (all hold for domotion-emitted `@font-face`):
  //  - one `font-family` declaration per block (so the key-collapse / rename below
  //    target the right name), and
  //  - the base64 `src` payload contains no `{`/`}` (the base64 alphabet excludes
  //    them), so `[^{}]*` safely matches the whole block body.
  const faceRe = /@font-face\s*\{[^{}]*\}/g;
  const canonicalByKey = new Map<string, string>();
  const renames = new Map<string, string>(); // duplicate family -> canonical family
  for (const m of svg.matchAll(faceRe)) {
    const block = m[0];
    const fam = /font-family:\s*"([^"]+)"/.exec(block)?.[1];
    if (fam == null) continue;
    // Key on everything BUT the family name, so two rules that differ only in
    // family (the per-layer namespacing) collapse together.
    const key = block.replace(/font-family:\s*"[^"]+"/, 'font-family:""');
    const canonical = canonicalByKey.get(key);
    if (canonical == null) {
      canonicalByKey.set(key, fam);
    } else if (fam !== canonical) {
      renames.set(fam, canonical);
    }
  }
  if (renames.size === 0) return svg;

  // Remove the duplicate `@font-face` blocks (those whose family was renamed).
  let out = svg.replace(faceRe, (block) => {
    const fam = /font-family:\s*"([^"]+)"/.exec(block)?.[1];
    return fam != null && renames.has(fam) ? "" : block;
  });
  // Repoint every reference of a removed family at its surviving copy — only in
  // `font-family` declaration / attribute contexts (never a bare global replace,
  // so a base64 payload can't be corrupted).
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const [dup, canon] of renames) {
    const e = esc(dup);
    out = out
      .replace(new RegExp(`(font-family:\\s*")${e}(")`, "g"), `$1${canon}$2`)
      .replace(new RegExp(`(font-family=")${e}(")`, "g"), `$1${canon}$2`);
  }
  return out;
}

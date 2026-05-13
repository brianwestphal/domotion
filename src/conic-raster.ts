/**
 * DM-549 — Conic-gradient rasterizer + tile cache + capture-tree pre-pass.
 * See `docs/28-conic-gradient.md`.
 *
 * SVG has no native conic-gradient primitive. We rasterize each captured
 * `conic-gradient(...)` / `repeating-conic-gradient(...)` background layer
 * into a PNG tile (via sharp) and the renderer emits the bytes as
 * `<pattern><image href="data:image/png;base64,…"/></pattern>` (DM-550).
 *
 * The pre-pass walks the captured tree, dedupes (layerText, tileW, tileH)
 * tuples, rasterizes each unique tuple once at `tile × hiDPIFactor` then
 * downsamples through sharp's lanczos kernel for antialiased edges, and
 * stashes the resulting data URI in `_conicTileCache` keyed by
 * `(layerText, "${tileW}x${tileH}")`.
 */

import sharp from "sharp";
import {
  _conicTileCache,
  type CapturedElement,
} from "./dom-to-svg.js";
import { type RGBA, parseColor } from "./render/colors.js";
import { parseConicGradient, type ConicGradient, type ConicStop, type PosValue } from "./gradients.js";

export interface RasterizeConicOptions {
  /**
   * Multiplier on each tile's CSS-px dimensions when allocating the raw
   * pixel buffer. The buffer is then downsampled through sharp.lanczos3 to
   * the tile size for antialiased hard-stop edges. Default 2.0 — matches the
   * embed pipeline's `embedRemoteImagesHiDPIFactor` per user direction.
   * Values < 1 are clamped to 1.
   */
  hiDPIFactor?: number;
}

const DEFAULT_HIDPI_FACTOR = 2;
const MIN_HIDPI_FACTOR = 1;

/**
 * Walk the captured tree, identify every conic-gradient background layer
 * with a known consumer rect, and populate `_conicTileCache` with rasterized
 * PNG bytes for each unique (layerText, tileW, tileH) tuple.
 *
 * Idempotent: re-running with the same tree is a no-op (each tuple's PNG
 * is already cached).
 */
export async function rasterizeConicGradients(
  tree: CapturedElement[],
  options: RasterizeConicOptions = {},
): Promise<void> {
  const hiDPI = Math.max(MIN_HIDPI_FACTOR, options.hiDPIFactor ?? DEFAULT_HIDPI_FACTOR);

  type Tuple = { layerText: string; gradient: ConicGradient; sizeKey: string; tileW: number; tileH: number };
  const tuples = new Map<string, Tuple>();

  const consider = (layerText: string, tileW: number, tileH: number): void => {
    const tw = Math.max(1, Math.round(tileW));
    const th = Math.max(1, Math.round(tileH));
    const sizeKey = `${tw}x${th}`;
    const dedupeKey = `${layerText}\n${sizeKey}`;
    if (tuples.has(dedupeKey)) return;
    const sizeCache = _conicTileCache.get(layerText);
    if (sizeCache != null && sizeCache.has(sizeKey)) return;
    const gradient = parseConicGradient(layerText);
    if (gradient == null) return;
    tuples.set(dedupeKey, { layerText, gradient, sizeKey, tileW: tw, tileH: th });
  };

  const walk = (els: CapturedElement[]): void => {
    for (const el of els) {
      const bgImage = el.styles.backgroundImage;
      if (bgImage != null && bgImage !== "" && bgImage !== "none" && /conic-gradient/i.test(bgImage)) {
        const layers = splitTopLevelCommas(bgImage);
        const sizes = splitTopLevelCommas(el.styles.backgroundSize ?? "auto");
        for (let li = 0; li < layers.length; li++) {
          const layer = layers[li].trim();
          if (!/^(?:repeating-)?conic-gradient\(/i.test(layer)) continue;
          const sizeCss = (sizes[li] ?? sizes[0] ?? "auto").trim();
          const tile = computeTileSize(sizeCss, el.width, el.height);
          consider(layer, tile.w, tile.h);
        }
      }
      if (el.children.length > 0) walk(el.children);
    }
  };
  walk(tree);
  if (tuples.size === 0) return;

  const tasks = Array.from(tuples.values(), async ({ layerText, gradient, sizeKey, tileW, tileH }) => {
    try {
      const renderW = Math.max(1, Math.round(tileW * hiDPI));
      const renderH = Math.max(1, Math.round(tileH * hiDPI));
      const raw = rasterizeConic(gradient, renderW, renderH);
      // Decode raw RGBA → PNG bytes via sharp, downsampling to the CSS-px tile
      // size with lanczos3 so hard-stop edges keep subpixel antialiasing that
      // matches Chromium's painted output.
      const png = await sharp(raw, { raw: { width: renderW, height: renderH, channels: 4 } })
        .resize(tileW, tileH, { fit: "fill", kernel: "lanczos3" })
        .png({ compressionLevel: 9 })
        .toBuffer();
      const dataUri = `data:image/png;base64,${png.toString("base64")}`;
      rememberConicTile(layerText, sizeKey, dataUri);
    } catch {
      // Per-tuple failure: leave the cache miss in place; renderer falls back
      // to the parse-failure warning path.
    }
  });
  await Promise.all(tasks);
}

/**
 * Rasterize a parsed conic gradient into a raw RGBA buffer of size
 * `width × height`. Pure CPU; no I/O. Caller is responsible for downsampling
 * / encoding (this module's pre-pass routes the raw buffer through sharp).
 *
 * Algorithm: per pixel, compute the angle from the gradient center, normalize
 * to a fractional sweep offset in [0, 1), look up the color via stop-list
 * interpolation, and write RGBA bytes.
 */
export function rasterizeConic(
  gradient: ConicGradient,
  width: number,
  height: number,
): Buffer {
  const buf = Buffer.allocUnsafe(width * height * 4);
  const cx = resolvePx(gradient.position.x, width);
  const cy = resolvePx(gradient.position.y, height);
  // CSS conic: 0deg = top, sweep clockwise. atan2 in screen coords (y down)
  // gives angle from +x axis, counterclockwise (mathematical). To convert:
  //   visualDeg = atan2(y - cy, x - cx) * 180/π + 90  // shift so 0 = top
  // then add fromAngleDeg, then normalize to [0, 1).
  // The `+ 90` rotates the +x axis (mathematical 0deg = right) to the top
  // (CSS 0deg = top). Sweep direction: CSS clockwise == screen clockwise
  // (both have y increasing downward), so atan2's natural counterclockwise
  // signing inverts to clockwise correctly when we negate (or equivalently
  // when the gradient stop offsets increase along clockwise sweep).
  const stops = resolveConicStops(gradient.stops);
  if (stops.length === 0) {
    buf.fill(0);
    return buf;
  }
  const repeating = gradient.repeating === true;
  let i = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      // CSS conic: 0deg = top (12 o'clock), sweep clockwise. atan2(dx, -dy)
      // gives an angle in [-π, π] where 0 = top and positive sweeps clockwise
      // (because y increases downward in screen coords, so -dy points toward
      // the top). Convert to a [0, 1) fractional offset around the sweep.
      let theta = Math.atan2(dx, -dy);
      let frac = theta / (Math.PI * 2);
      frac -= gradient.fromAngleDeg / 360;
      // Normalize to [0, 1).
      frac = frac - Math.floor(frac);
      const color = lookupColor(stops, frac, repeating);
      buf[i++] = color.r;
      buf[i++] = color.g;
      buf[i++] = color.b;
      buf[i++] = Math.round(color.a * 255);
    }
  }
  return buf;
}

interface ResolvedStop {
  rgba: RGBA;
  offset: number;
}

/**
 * Resolve conic-gradient stop offsets for rasterization. Auto-distributes
 * stops without explicit positions (CSS rule: missing position = midpoint
 * between neighbors with positions; first defaults to 0; last defaults to 1).
 * Drops stops whose color can't be parsed.
 */
export function resolveConicStops(stops: ConicStop[]): ResolvedStop[] {
  if (stops.length === 0) return [];
  const out: { rgba: RGBA; offset?: number; rawPos?: string }[] = stops.map((s) => ({
    rgba: parseColor(s.color) ?? { r: 0, g: 0, b: 0, a: 0 },
    offset: s.offset,
    rawPos: s.rawPos,
  }));
  if (out[0].offset == null) out[0].offset = 0;
  if (out[out.length - 1].offset == null) out[out.length - 1].offset = 1;
  let i = 0;
  while (i < out.length) {
    if (out[i].offset != null) { i++; continue; }
    let j = i + 1;
    while (j < out.length && out[j].offset == null) j++;
    const prev = out[i - 1].offset ?? 0;
    const next = out[j]?.offset ?? 1;
    const span = j - i + 1;
    for (let k = i; k < j; k++) {
      out[k].offset = prev + ((next - prev) * (k - (i - 1))) / span;
    }
    i = j;
  }
  // Enforce monotonicity: each stop's effective offset is max(self, previous).
  let max = out[0].offset!;
  for (const s of out) {
    if (s.offset! < max) s.offset = max;
    if (s.offset! > max) max = s.offset!;
  }
  return out.map((s) => ({ rgba: s.rgba, offset: s.offset! }));
}

/**
 * Look up the interpolated color at `frac` ∈ [0, 1) in a resolved stop list.
 * For repeating gradients, mod the input by the stop period before lookup;
 * for non-repeating, clamp to the first/last stop outside [first.offset, last.offset].
 */
function lookupColor(stops: ResolvedStop[], frac: number, repeating: boolean): RGBA {
  if (stops.length === 1) return stops[0].rgba;
  const first = stops[0].offset;
  const last = stops[stops.length - 1].offset;
  if (repeating) {
    const period = last - first;
    if (period > 0) {
      const t = ((frac - first) / period);
      const wrapped = t - Math.floor(t);
      frac = first + wrapped * period;
    }
  } else {
    if (frac <= first) return stops[0].rgba;
    if (frac >= last) return stops[stops.length - 1].rgba;
  }
  // Find the bracketing pair.
  for (let i = 1; i < stops.length; i++) {
    if (stops[i].offset >= frac) {
      const a = stops[i - 1];
      const b = stops[i];
      const span = b.offset - a.offset;
      if (span <= 0) return b.rgba; // hard stop
      const t = (frac - a.offset) / span;
      return blendRgba(a.rgba, b.rgba, t);
    }
  }
  return stops[stops.length - 1].rgba;
}

function blendRgba(a: RGBA, b: RGBA, t: number): RGBA {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
    a: a.a + (b.a - a.a) * t,
  };
}

function resolvePx(p: PosValue, extent: number): number {
  if (p.kind === "px") return p.value;
  return p.value * extent;
}

/**
 * Resolve a `background-size` value to a tile (w, h) in CSS px. `auto`,
 * `cover`, `contain` all map to the element rect (no intrinsic for a
 * gradient — there's no way to compute a smaller tile). Numeric values
 * (px / %) resolve normally. Single-axis values default the missing axis
 * to `auto` per CSS.
 */
function computeTileSize(sizeCss: string, elW: number, elH: number): { w: number; h: number } {
  const trimmed = sizeCss.trim();
  if (trimmed === "" || trimmed === "auto" || trimmed === "cover" || trimmed === "contain") {
    return { w: elW, h: elH };
  }
  const parts = trimmed.split(/\s+/);
  const parseDim = (tok: string, basis: number): number => {
    if (tok === "auto") return basis;
    const m = /^(-?\d+(?:\.\d+)?|-?\.\d+)(%|px)?$/.exec(tok);
    if (m == null) return basis;
    const v = parseFloat(m[1]);
    const unit = m[2] ?? "px";
    if (unit === "%") return (v / 100) * basis;
    return v;
  };
  const w = parseDim(parts[0], elW);
  const h = parts.length > 1 ? parseDim(parts[1], elH) : w;
  return { w, h };
}

function rememberConicTile(layerText: string, sizeKey: string, dataUri: string): void {
  let sizeCache = _conicTileCache.get(layerText);
  if (sizeCache == null) {
    sizeCache = new Map<string, string>();
    _conicTileCache.set(layerText, sizeCache);
  }
  sizeCache.set(sizeKey, dataUri);
}

function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

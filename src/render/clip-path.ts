/**
 * CSS `clip-path` basic-shape → SVG conversion.
 *
 * Translates a CSS `clip-path` value (`inset()`, `circle()`, `ellipse()`,
 * `polygon()`, `path()`) into the matching SVG basic-shape / `<path>` markup,
 * positioned in viewport coordinates. Extracted from `element-tree-to-svg.ts`
 * (DM-1305) — a pure string transform with no module state.
 */

import { r } from "./format.js";
import { roundedRectPath } from "./borders.js";

export function translateClipPath(value: string, x: number, y: number, w: number, h: number): string {
  const resolvePx = (tok: string, basis: number): number => {
    const t = tok.trim();
    if (t === "center") return basis / 2;
    if (t === "top" || t === "left") return 0;
    if (t === "bottom" || t === "right") return basis;
    if (/%$/.test(t)) return (parseFloat(t) / 100) * basis;
    return parseFloat(t) || 0;
  };
  const inset = /^inset\(([^)]+)\)$/i.exec(value);
  if (inset != null) {
    // CSS: inset(top [right [bottom [left]]] [round <border-radius>]).
    // Split off the optional `round R...` suffix first; what's left is the
    // inset offsets.
    const innerStr = inset[1].trim();
    const roundIdx = innerStr.search(/\bround\b/i);
    const insetStr = roundIdx >= 0 ? innerStr.slice(0, roundIdx).trim() : innerStr;
    const radiusStr = roundIdx >= 0 ? innerStr.slice(roundIdx + 5).trim() : "";
    const parts = insetStr.split(/\s+/);
    const top = resolvePx(parts[0], h);
    const right = resolvePx(parts[1] ?? parts[0], w);
    const bottom = resolvePx(parts[2] ?? parts[0], h);
    const left = resolvePx(parts[3] ?? parts[1] ?? parts[0], w);
    const insetW = w - left - right;
    const insetH = h - top - bottom;
    if (radiusStr === "") {
      const rectAttrs = `x="${r(x + left)}" y="${r(y + top)}" width="${r(insetW)}" height="${r(insetH)}"`;
      return `<rect ${rectAttrs} />`;
    }
    // CSS Backgrounds 3 §5.3 border-radius shorthand: 1-4 horizontal values,
    // optionally `/` then 1-4 vertical values. Map to per-corner pairs:
    //   1 value     → all 4 corners
    //   2 values    → TL=BR=v0, TR=BL=v1
    //   3 values    → TL=v0,  TR=BL=v1,  BR=v2
    //   4 values    → TL=v0,  TR=v1,     BR=v2,  BL=v3
    const slashIdx = radiusStr.indexOf("/");
    const hPart = (slashIdx >= 0 ? radiusStr.slice(0, slashIdx) : radiusStr).trim();
    const vPart = (slashIdx >= 0 ? radiusStr.slice(slashIdx + 1) : hPart).trim();
    const hTok = hPart.split(/\s+/);
    const vTok = vPart.split(/\s+/);
    const pickCorner = (toks: string[], idx: number): string => {
      if (toks.length === 1) return toks[0];
      if (toks.length === 2) return toks[idx === 0 || idx === 2 ? 0 : 1];
      if (toks.length === 3) return toks[idx === 0 ? 0 : idx === 2 ? 2 : 1];
      return toks[idx];
    };
    const tlH = resolvePx(pickCorner(hTok, 0), insetW);
    const trH = resolvePx(pickCorner(hTok, 1), insetW);
    const brH = resolvePx(pickCorner(hTok, 2), insetW);
    const blH = resolvePx(pickCorner(hTok, 3), insetW);
    const tlV = resolvePx(pickCorner(vTok, 0), insetH);
    const trV = resolvePx(pickCorner(vTok, 1), insetH);
    const brV = resolvePx(pickCorner(vTok, 2), insetH);
    const blV = resolvePx(pickCorner(vTok, 3), insetH);
    // CSS Backgrounds 3 §5.5 corner-overlap scale-down: scale all four
    // corners uniformly so no pair on the same edge exceeds the edge length.
    const sums = [
      [tlH + trH, insetW], [trV + brV, insetH],
      [brH + blH, insetW], [blV + tlV, insetH],
    ];
    let scale = 1;
    for (const [s, lim] of sums) if (s > 0 && lim > 0) scale = Math.min(scale, lim / s);
    const corners = {
      tl: { h: tlH * scale, v: tlV * scale },
      tr: { h: trH * scale, v: trV * scale },
      br: { h: brH * scale, v: brV * scale },
      bl: { h: blH * scale, v: blV * scale },
      uniform: tlH === trH && tlH === brH && tlH === blH && tlH === tlV && tlH === trV && tlH === brV && tlH === blV,
    };
    if (corners.uniform) {
      const rxAttr = corners.tl.h > 0 ? ` rx="${r(corners.tl.h)}" ry="${r(corners.tl.v)}"` : "";
      return `<rect x="${r(x + left)}" y="${r(y + top)}" width="${r(insetW)}" height="${r(insetH)}"${rxAttr} />`;
    }
    return `<path d="${roundedRectPath(x + left, y + top, insetW, insetH, corners)}" />`;
  }
  const circle = /^circle\(([^)]*)\)$/i.exec(value);
  if (circle != null) {
    const inner = circle[1].trim();
    const mAt = /\bat\b/i.exec(inner);
    const radiusPart = (mAt != null ? inner.slice(0, mAt.index) : inner).trim();
    const atPart = mAt != null ? inner.slice(mAt.index + 2).trim() : "50% 50%";
    const atTokens = atPart.split(/\s+/);
    const cx = resolvePx(atTokens[0] ?? "50%", w);
    const cy = resolvePx(atTokens[1] ?? "50%", h);
    let radius: number;
    if (radiusPart === "" || /^closest-side$/i.test(radiusPart)) {
      // CSS default radius is closest-side (which for a centred circle equals
      // Math.min(w, h) / 2 but differs once the centre moves).
      radius = Math.min(cx, cy, w - cx, h - cy);
    } else if (/^farthest-side$/i.test(radiusPart)) {
      radius = Math.max(cx, cy, w - cx, h - cy);
    } else {
      // <length-percentage>; spec's basis for percentages is
      // sqrt(w² + h²) / √2.
      const radiusBasis = Math.sqrt((w * w + h * h) / 2);
      radius = resolvePx(radiusPart, radiusBasis);
    }
    return `<circle cx="${r(x + cx)}" cy="${r(y + cy)}" r="${r(radius)}" />`;
  }
  const ellipse = /^ellipse\(([^)]*)\)$/i.exec(value);
  if (ellipse != null) {
    const inner = ellipse[1].trim();
    const mAt = /\bat\b/i.exec(inner);
    const radiiPart = (mAt != null ? inner.slice(0, mAt.index) : inner).trim();
    const atPart = mAt != null ? inner.slice(mAt.index + 2).trim() : "50% 50%";
    const atTokens = atPart.split(/\s+/);
    const cx = resolvePx(atTokens[0] ?? "50%", w);
    const cy = resolvePx(atTokens[1] ?? "50%", h);
    const resolveRadius = (tok: string, axis: "x" | "y"): number => {
      const t = tok.trim();
      if (/^closest-side$/i.test(t)) return axis === "x" ? Math.min(cx, w - cx) : Math.min(cy, h - cy);
      if (/^farthest-side$/i.test(t)) return axis === "x" ? Math.max(cx, w - cx) : Math.max(cy, h - cy);
      return resolvePx(t, axis === "x" ? w : h);
    };
    let rx: number;
    let ry: number;
    if (radiiPart === "") {
      rx = w / 2;
      ry = h / 2;
    } else {
      const radiiTokens = radiiPart.split(/\s+/);
      rx = resolveRadius(radiiTokens[0] ?? "50%", "x");
      ry = resolveRadius(radiiTokens[1] ?? radiiTokens[0] ?? "50%", "y");
    }
    return `<ellipse cx="${r(x + cx)}" cy="${r(y + cy)}" rx="${r(rx)}" ry="${r(ry)}" />`;
  }
  const polygon = /^polygon\(([^)]+)\)$/i.exec(value);
  if (polygon != null) {
    const pts = polygon[1].split(",").map((pair) => {
      const [px, py] = pair.trim().split(/\s+/);
      return `${r(x + resolvePx(px, w))},${r(y + resolvePx(py, h))}`;
    });
    return `<polygon points="${pts.join(" ")}" />`;
  }
  // path("M ... Z") — coordinates are in the element's reference box (border-
  // box by default), so apply a translate(x,y) transform directly on the
  // <path> element. SVG's <clipPath> doesn't accept <g> wrappers — only basic
  // shapes, <path>, and <use> — so the transform has to live on the path
  // itself, not on a group.
  const pathFn = /^path\(\s*(?:"([^"]+)"|'([^']+)')\s*\)$/i.exec(value);
  if (pathFn != null) {
    const d = pathFn[1] ?? pathFn[2] ?? "";
    if (d === "") return "";
    const transform = (x === 0 && y === 0) ? "" : ` transform="translate(${r(x)},${r(y)})"`;
    return `<path d="${d}"${transform} />`;
  }
  return "";
}

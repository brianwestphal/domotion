/**
 * CSS `linear-gradient()` / `radial-gradient()` → SVG gradient `<def>` builders,
 * element-relative (userSpaceOnUse), with the stop parser, transparent-stop
 * normalization, and direction-keyword → angle math. Extracted from
 * element-tree-to-svg.ts (DM-1305) so both the background renderer and the mask
 * builder (mask.ts) can share them. Behavior-identical lift; imported deps only.
 */

import { colorStr, parseColor, type RGBA } from "./colors.js";
import { r, stopFmt } from "./format.js";
import { splitTopLevelCommas } from "./css-tokens.js";

export interface GradientStop { color: RGBA; pos: number }

/** Parse the comma-separated 'args' inside a linear-gradient(...) and emit an SVG <linearGradient>.
 * w/h are the element box dimensions — needed to compute corner-to-corner
 * directional keywords ('to top right' etc.) which are aspect-ratio-dependent,
 * not always 45deg. */
export function buildLinearGradientDef(id: string, args: string, repeating: boolean, w: number = 1, h: number = 1, elX: number = 0, elY: number = 0): string {
  const parts = splitTopLevelCommas(args).map((p) => p.trim());
  let angleDeg = 180; // default 'to bottom'
  let stopsStart = 0;
  const first = parts[0];
  const toMatch = /^to\s+(.+)$/i.exec(first);
  if (toMatch != null) {
    angleDeg = cssDirectionToAngle(toMatch[1], w, h);
    stopsStart = 1;
  } else {
    const angleMatch = /^(-?[\d.]+)(deg|rad|grad|turn)?$/i.exec(first);
    if (angleMatch != null) {
      const unit = (angleMatch[2] ?? "deg").toLowerCase();
      const n = parseFloat(angleMatch[1]);
      angleDeg = unit === "rad" ? (n * 180) / Math.PI : unit === "grad" ? n * 0.9 : unit === "turn" ? n * 360 : n;
      stopsStart = 1;
    }
  }
  // Compute the gradient line length up front so px stop positions can be
  // resolved to fractions before auto-distribution / monotonic clamp. Without
  // this, px-positioned stops (e.g. `repeating-linear-gradient(45deg,
  // #fef3c7 0 8px, #fde68a 8px 16px)`) would emit raw `offset="8"` values that
  // SVG clamps to 1, collapsing the stripe pattern. parseGradientStops divides
  // px by L to get a fraction; auto-distribute and monotonic clamp then work
  // in fraction space alongside any `%` stops in the same gradient.
  const preRad = (angleDeg * Math.PI) / 180;
  const lineLength = Math.abs(w * Math.sin(preRad)) + Math.abs(h * Math.cos(preRad));
  const stops = parseGradientStops(parts.slice(stopsStart), lineLength);
  if (stops.length === 0) return "";

  // CSS: 0deg points up. SVG coords: y grows down. Vector for CSS angle α is
  // (sin α, -cos α). Per the CSS Images L3 spec the gradient line passes
  // through the box center at the requested angle and its length is
  // `|W·sin α| + |H·cos α|` in real coordinates — NOT `1` in unit-square
  // coordinates. For non-square boxes the two are different: a 45° gradient
  // on a 180×120 box has gradient line length ≈ 212.13 (real px), with
  // endpoints at (15, 135) and (165, -15). The endpoint normalization to
  // the bounding box (which is what SVG's default `gradientUnits=
  // "objectBoundingBox"` consumes) lands at fractions outside [0, 1] —
  // (0.083, 1.125) and (0.917, -0.125) — which is valid SVG and renders
  // identically to Chrome. The previous `0.5 ± 0.5·sinα` / `0.5 ± 0.5·cosα`
  // formulation only matched a square box; on rectangular boxes the
  // gradient direction was stretched by the aspect ratio, producing a
  // visibly different angle than what Chrome paints. Surfaced via DM-395
  // probe of `mask-mode: alpha` / `mask-mode: luminance` cells in 23-mask
  // (180×120 boxes); 81% of pixels differed because the 45° gradient rotated
  // toward atan(W/H) ≈ 56.3° instead of staying at 45°.
  const dx = Math.sin(preRad);
  const dy = -Math.cos(preRad);
  const length = lineLength;
  const halfL = length / 2;
  // Endpoints in absolute SVG coordinates. We emit `gradientUnits=
  // "userSpaceOnUse"` because the SVG default `objectBoundingBox` rescales
  // x/y independently to the bounding box — distorting the visible gradient
  // angle on non-square elements. For a 45° gradient on a 180×120 box,
  // objectBoundingBox would render the gradient at ~33° instead of 45°,
  // which DM-395's per-pixel probe of `mask-mode: alpha` showed as 75%
  // of pixels diffing against Chrome's paint. userSpaceOnUse preserves the
  // angle by keeping the gradient line in real-px coordinates so each
  // point in the box projects onto the line correctly.
  const x1 = elX + w / 2 - halfL * dx;
  const y1 = elY + h / 2 - halfL * dy;
  const x2 = elX + w / 2 + halfL * dx;
  const y2 = elY + h / 2 + halfL * dy;

  // For repeating gradients, scale the SVG gradient vector to span exactly one
  // tile period along the gradient line, then let `spreadMethod="repeat"` tile
  // it across the rest of the box. SVG's repeat mode only repeats *outside*
  // the [0,1] range of the gradient vector, so a tile defined inside [0, 0.07]
  // of the full L would leave most of the box solid. Setting the vector to
  // one period instead makes the entire [0,1] range one tile.
  let vx1 = x1, vy1 = y1, vx2 = x2, vy2 = y2;
  let emitStops = stops;
  if (repeating && stops.length >= 2) {
    const first = stops[0].pos;
    const last = stops[stops.length - 1].pos;
    const period = last - first;
    if (period > 0 && period < 1) {
      vx1 = x1 + first * (x2 - x1);
      vy1 = y1 + first * (y2 - y1);
      vx2 = x1 + last * (x2 - x1);
      vy2 = y1 + last * (y2 - y1);
      emitStops = stops.map((s) => ({ ...s, pos: (s.pos - first) / period }));
    }
  }

  const spread = repeating ? ` spreadMethod="repeat"` : "";
  // Stop offsets need 4 decimals of precision — rounding 0.33 to 0.3 would turn
  // three equal thirds into uneven bands. Use stopFmt, not r(), here.
  const stopsMarkup = normalizeTransparentStops(emitStops).map((s) => `<stop offset="${stopFmt(s.pos)}" stop-color="${colorStr(s.color)}" />`).join("");
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${stopFmt(vx1)}" y1="${stopFmt(vy1)}" x2="${stopFmt(vx2)}" y2="${stopFmt(vy2)}"${spread}>${stopsMarkup}</linearGradient>`;
}

/** CSS gradient interpolation treats `transparent` as "the adjacent stop's
 *  RGB with alpha=0" — `linear-gradient(transparent, red)` fades a fully-
 *  transparent RED into opaque red, NEVER through dark midpoints. SVG
 *  `<stop>` interpolation uses the literal `stop-color` RGB though, so the
 *  same gradient with `stop-color="rgba(0,0,0,0)"` → `stop-color="red"`
 *  interpolates RGB (0,0,0) → (255,0,0) linearly with alpha going 0 → 1,
 *  producing a visible dark band in the middle. Most prominent on photo-
 *  card gradient overlays (nytimes mobile etc., DM-913).
 *
 *  Fix: rewrite any stop with alpha == 0 to inherit the nearest non-zero-
 *  alpha neighbour's RGB. Walk forward then back so first/last stops can
 *  inherit from whichever side has a real colour. */
function normalizeTransparentStops(stops: Array<{ pos: number; color: RGBA }>): Array<{ pos: number; color: RGBA }> {
  if (stops.length < 2) return stops;
  const transparentIdx: number[] = [];
  for (let i = 0; i < stops.length; i++) {
    if (stops[i].color.a < 1e-4 && stops[i].color.r === 0 && stops[i].color.g === 0 && stops[i].color.b === 0) {
      transparentIdx.push(i);
    }
  }
  if (transparentIdx.length === 0) return stops;
  const out = stops.map((s) => ({ pos: s.pos, color: { ...s.color } }));
  for (const i of transparentIdx) {
    // Prefer the NEXT non-transparent stop's RGB (a CSS `transparent` stop
    // at the start of `linear-gradient(transparent, red)` should fade IN
    // from rgba(red, 0)). If none ahead, fall back to the previous one.
    let neighbour: RGBA | null = null;
    for (let j = i + 1; j < out.length; j++) {
      if (!(out[j].color.a < 1e-4 && out[j].color.r === 0 && out[j].color.g === 0 && out[j].color.b === 0)) {
        neighbour = out[j].color;
        break;
      }
    }
    if (neighbour == null) {
      for (let j = i - 1; j >= 0; j--) {
        if (!(out[j].color.a < 1e-4 && out[j].color.r === 0 && out[j].color.g === 0 && out[j].color.b === 0)) {
          neighbour = out[j].color;
          break;
        }
      }
    }
    if (neighbour != null) {
      out[i].color.r = neighbour.r;
      out[i].color.g = neighbour.g;
      out[i].color.b = neighbour.b;
      // alpha stays 0
    }
  }
  return out;
}


/** Parse radial-gradient args and emit an SVG <radialGradient>.
 *
 * Emits in userSpaceOnUse so we can honor CSS shape (circle vs ellipse),
 * size keywords (closest/farthest side/corner), explicit radii, and position
 * accurately in a non-square box. elX/elY are the element's absolute top-left.
 */
/**
 * DM-1121: extract the pixel component of a computed `background-position`
 * (`"-90px 90px"`, `"0% 100%"`, `"left 10px bottom"`, …) as an `[x, y]` px pair.
 *
 * Only the px part contributes a real offset for an auto-sized gradient (the
 * image fills the box, so any percentage / keyword resolves to a zero
 * `(box − image) × pct` shift). Percentages and bare keywords therefore map to
 * 0. Two-value computed positions are the common case; the edge-offset form
 * (`"left 10px top 20px"`) is handled by summing the px token that follows each
 * horizontal / vertical keyword.
 */
export function parseBgPositionPx(posCss: string): [number, number] {
  const toks = posCss.trim().split(/\s+/).filter((t) => t !== "");
  if (toks.length === 0) return [0, 0];
  const px = (t: string): number | null => {
    const m = /^(-?\d+(?:\.\d+)?)px$/.exec(t);
    return m != null ? parseFloat(m[1]) : null;
  };
  // Edge-offset form: keyword followed by an optional px length, per axis.
  if (toks.some((t) => /^(left|right|top|bottom|center)$/i.test(t)) && toks.length > 2) {
    let x = 0, y = 0;
    for (let i = 0; i < toks.length; i++) {
      const kw = toks[i].toLowerCase();
      const next = i + 1 < toks.length ? px(toks[i + 1]) : null;
      if (kw === "right" && next != null) x = -next;       // offset from the right edge
      else if (kw === "left" && next != null) x = next;
      else if (kw === "bottom" && next != null) y = -next; // offset from the bottom edge
      else if (kw === "top" && next != null) y = next;
    }
    return [x, y];
  }
  return [px(toks[0]) ?? 0, toks.length > 1 ? (px(toks[1]) ?? 0) : 0];
}

export function buildRadialGradientDef(
  id: string, args: string, repeating: boolean,
  elX: number, elY: number, w: number, h: number,
  offsetX: number = 0, offsetY: number = 0,
): string {
  const parts = splitTopLevelCommas(args).map((p) => p.trim());
  let stopsStart = 0;
  let shape: "circle" | "ellipse" = "ellipse"; // CSS default
  let sizeKeyword: "closest-side" | "closest-corner" | "farthest-side" | "farthest-corner" = "farthest-corner";
  let explicitRx: number | null = null;
  let explicitRy: number | null = null;
  let cxFrac = 0.5, cyFrac = 0.5;

  // First argument can be: 'circle' | 'ellipse' [size-keyword] [at <pos>], OR
  // explicit size (one length, or two lengths for ellipse), optionally with shape, at <pos>.
  // Example valid first-args:
  //   'circle'
  //   'ellipse at top'
  //   'circle closest-side at 30% 30%'
  //   '80px 60px at 70% 40%'
  //   '100px'
  const first = parts[0];
  // Try to detect if first arg is shape/size info (no parens / no color chars)
  const isLikelyStopsStart = /#|rgb|hsl|hwb|lab|lch|oklab|oklch|color\(|transparent|[a-z]{3,}$/i.test(first) && !/\b(circle|ellipse|closest|farthest|at\b)/i.test(first);
  if (!isLikelyStopsStart) {
    stopsStart = 1;
    // Parse 'at <pos>' suffix.
    const mAt = /\bat\b/i.exec(first);
    const beforeAt = mAt != null ? first.slice(0, mAt.index).trim() : first.trim();
    const afterAt = mAt != null ? first.slice(mAt.index + 2).trim() : "";
    if (afterAt !== "") {
      const posTokens = afterAt.split(/\s+/);
      const p1 = posTokens[0] ?? "center";
      const p2 = posTokens[1] ?? "center";
      // Position can be keyword / % / px / plain number (treated as px in CSS).
      // resolvePosFraction (the linear-gradient helper) only understands keywords
      // + percent, so convert pixel values here against w/h.
      const toFrac = (tok: string, axis: "h" | "v"): number => {
        const t = tok.trim();
        if (t === "center") return 0.5;
        if (axis === "h" && t === "left") return 0;
        if (axis === "h" && t === "right") return 1;
        if (axis === "v" && t === "top") return 0;
        if (axis === "v" && t === "bottom") return 1;
        if (/%$/.test(t)) return parseFloat(t) / 100;
        // Pixels (or bare numbers treated as pixels per CSS spec).
        const px = parseFloat(t);
        if (!isNaN(px)) {
          const basis = axis === "h" ? w : h;
          return basis > 0 ? px / basis : 0;
        }
        return 0.5;
      };
      cxFrac = toFrac(p1, "h");
      cyFrac = toFrac(p2, "v");
    }
    // Parse shape / size keyword / explicit radii from beforeAt.
    const tokens = beforeAt.split(/\s+/).filter((t) => t !== "");
    for (const t of tokens) {
      if (t === "circle") shape = "circle";
      else if (t === "ellipse") shape = "ellipse";
      else if (t === "closest-side" || t === "closest-corner" || t === "farthest-side" || t === "farthest-corner") {
        sizeKeyword = t;
      } else if (/(px|%|em|rem)$/.test(t) || /^-?[\d.]+$/.test(t)) {
        const val = /%$/.test(t) ? parseFloat(t) / 100 : parseFloat(t);
        const isPct = /%$/.test(t);
        if (explicitRx == null) explicitRx = isPct ? val * w : val;
        else if (explicitRy == null) explicitRy = isPct ? val * h : val;
      }
    }
    if (explicitRx != null && explicitRy == null) {
      // Single length -> circle with that radius.
      explicitRy = explicitRx;
      shape = "circle";
    }
  }
  // Compute the gradient ray length for px-stop normalization. Use the
  // half-diagonal of the box as a conservative pre-estimate; the actual ray
  // length (rx, computed below from size keyword + center) is the correct
  // basis, so re-normalize stops once rx is known.
  const radialLineLength = Math.sqrt(w * w + h * h) / 2;
  const stops = parseGradientStops(parts.slice(stopsStart), radialLineLength);
  if (stops.length === 0) return "";

  // Compute center in absolute user-space coords. DM-1121: `background-position`
  // translates the whole gradient IMAGE within the box, which for an auto-sized
  // gradient (image == box) just slides the center by the px offset — the
  // size-keyword radii below stay image-box-relative (`cxFrac * w`), so they're
  // unchanged. Stripe's keynote glow uses `background-position: -90px 90px` to
  // push the pink core into the lower-left corner.
  const cx = elX + offsetX + cxFrac * w;
  const cy = elY + offsetY + cyFrac * h;

  // Compute effective radii per shape + size keyword.
  const dxL = cxFrac * w;        // distance to left side
  const dxR = (1 - cxFrac) * w;  // to right
  const dyT = cyFrac * h;        // to top
  const dyB = (1 - cyFrac) * h;  // to bottom
  const closestX = Math.min(dxL, dxR);
  const farthestX = Math.max(dxL, dxR);
  const closestY = Math.min(dyT, dyB);
  const farthestY = Math.max(dyT, dyB);

  let rx: number, ry: number;
  if (explicitRx != null && explicitRy != null) {
    rx = explicitRx;
    ry = explicitRy;
  } else if (shape === "circle") {
    let r0: number;
    switch (sizeKeyword) {
      case "closest-side":   r0 = Math.min(closestX, closestY); break;
      case "farthest-side":  r0 = Math.max(farthestX, farthestY); break;
      case "closest-corner": r0 = Math.sqrt(closestX * closestX + closestY * closestY); break;
      case "farthest-corner":
      default:               r0 = Math.sqrt(farthestX * farthestX + farthestY * farthestY); break;
    }
    rx = r0;
    ry = r0;
  } else {
    // ellipse
    switch (sizeKeyword) {
      case "closest-side":
        rx = closestX; ry = closestY; break;
      case "farthest-side":
        rx = farthestX; ry = farthestY; break;
      case "closest-corner":
      case "farthest-corner":
      default: {
        // Ellipse that passes through the corner along the shape's aspect ratio.
        // For farthest-corner: radii (rx, ry) satisfy rx/ry = farthestX/farthestY
        // AND rx = farthestX*sqrt(2), ry = farthestY*sqrt(2) (since the corner
        // at (farthestX, farthestY) satisfies (farthestX/rx)^2 + (farthestY/ry)^2 = 1).
        const aspectX = sizeKeyword === "closest-corner" ? closestX : farthestX;
        const aspectY = sizeKeyword === "closest-corner" ? closestY : farthestY;
        rx = aspectX * Math.SQRT2;
        ry = aspectY * Math.SQRT2;
        break;
      }
    }
  }

  const spread = repeating ? ` spreadMethod="repeat"` : "";
  const stopsMarkup = normalizeTransparentStops(stops).map((s) => `<stop offset="${stopFmt(s.pos)}" stop-color="${colorStr(s.color)}" />`).join("");

  // SVG radialGradient has a single r — use rx as r and scale Y via gradientTransform
  // to stretch it into an ellipse matching (rx, ry).
  const rScale = rx > 0 ? ry / rx : 1;
  const gradientTransform = Math.abs(rScale - 1) > 0.001
    ? ` gradientTransform="translate(0 ${stopFmt(cy * (1 - rScale))}) scale(1 ${stopFmt(rScale)})"`
    : "";

  return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${stopFmt(cx)}" cy="${stopFmt(cy)}" r="${stopFmt(Math.max(rx, 1))}"${spread}${gradientTransform}>${stopsMarkup}</radialGradient>`;
}

function resolvePosFraction(token: string, axis: "h" | "v"): number {
  const t = token.trim();
  if (t === "center") return 0.5;
  if (axis === "h") {
    if (t === "left") return 0;
    if (t === "right") return 1;
  } else {
    if (t === "top") return 0;
    if (t === "bottom") return 1;
  }
  if (/%$/.test(t)) return parseFloat(t) / 100;
  return 0.5;
}

export function parseGradientStops(tokens: string[], gradientLength: number = 0): GradientStop[] {
  // First pass: parse each token into {color, explicitPositions[]} OR {hint}.
  // A color-hint is a bare percentage between two color stops that shifts the
  // midpoint of the interpolation between them. We record hints inline so
  // they can apply to the neighboring colors after we finalize positions.
  type RawItem = { kind: "color"; color: RGBA; positions: number[] } | { kind: "hint"; pos: number };
  const raw: RawItem[] = [];
  for (const tokRaw of tokens) {
    const tok = tokRaw.trim();
    if (tok === "") continue;
    if (/^-?[\d.]+%$/.test(tok)) {
      raw.push({ kind: "hint", pos: parseFloat(tok) / 100 });
      continue;
    }
    const posMatch = tok.match(/(\s+-?[\d.]+(%|px)?\s*){1,2}$/);
    let colorStr = tok;
    const positions: number[] = [];
    if (posMatch != null) {
      colorStr = tok.slice(0, posMatch.index).trim();
      for (const pt of posMatch[0].trim().split(/\s+/)) {
        if (/%$/.test(pt)) positions.push(parseFloat(pt) / 100);
        else if (/px$/i.test(pt) && gradientLength > 0) positions.push(parseFloat(pt) / gradientLength);
        else positions.push(parseFloat(pt));
      }
    }
    const color = parseColor(colorStr) ?? { r: 0, g: 0, b: 0, a: 1 };
    raw.push({ kind: "color", color, positions });
  }
  // Filter hints out for the first-pass color expansion; we'll inject them after
  // stop positions are resolved.
  const hints: Array<{ pos: number; afterColorIdx: number }> = [];
  const colorRaw: Array<{ color: RGBA; positions: number[] }> = [];
  for (const r of raw) {
    if (r.kind === "color") colorRaw.push({ color: r.color, positions: r.positions });
    else hints.push({ pos: r.pos, afterColorIdx: colorRaw.length - 1 });
  }
  if (colorRaw.length === 0) return [];

  // Second pass: expand each color into 1+ stops (a color can have 2 positions
  // to form a hard stop). Track which stops came from which color-raw-index so
  // we can inject hint stops in the right spot.
  const stops: GradientStop[] = [];
  const stopColorIdx: number[] = [];
  for (let i = 0; i < colorRaw.length; i++) {
    const r = colorRaw[i];
    if (r.positions.length === 0) {
      stops.push({ color: r.color, pos: NaN });
      stopColorIdx.push(i);
    } else {
      for (const p of r.positions) { stops.push({ color: r.color, pos: p }); stopColorIdx.push(i); }
    }
  }
  if (isNaN(stops[0].pos)) stops[0].pos = 0;
  if (isNaN(stops[stops.length - 1].pos)) stops[stops.length - 1].pos = 1;

  // Fill interior NaN positions by evenly distributing between the nearest
  // resolved neighbors — matches CSS behavior for implicit stops.
  let i = 0;
  while (i < stops.length) {
    if (!isNaN(stops[i].pos)) { i++; continue; }
    let j = i;
    while (j < stops.length && isNaN(stops[j].pos)) j++;
    const left = stops[i - 1].pos;
    const right = j < stops.length ? stops[j].pos : 1;
    const count = j - i + 1;
    for (let k = 0; k < j - i; k++) stops[i + k].pos = left + ((k + 1) / count) * (right - left);
    i = j;
  }
  // Monotonic clamp: each stop >= previous (CSS rule).
  for (let k = 1; k < stops.length; k++) {
    if (stops[k].pos < stops[k - 1].pos) stops[k].pos = stops[k - 1].pos;
  }

  // Inject color hints: between two stops A (at posA) and B (at posB) with a
  // hint at posH, CSS shifts the 50% transition point to posH via a power
  // interpolation — the mix weight at fraction t = (pos-posA)/(posB-posA) is
  // `t^(ln0.5/lnH)`, where H = (posH-posA)/(posB-posA) is the hint's relative
  // position (so weight(H) = 0.5, the midpoint color lands on the hint). SVG
  // only does linear interpolation between stops, so DM-1242: sample that curve
  // at several interior points and emit a stop at each, approximating the curve
  // piecewise-linearly instead of with one mid-color stop (which read too linear).
  if (hints.length > 0) {
    const out: GradientStop[] = [];
    let hintIdx = 0;
    for (let s = 0; s < stops.length; s++) {
      out.push(stops[s]);
      // Is there a hint between this color's last stop and the next color's first stop?
      if (s === stops.length - 1) continue;
      const thisColorIdx = stopColorIdx[s];
      const nextColorIdx = stopColorIdx[s + 1];
      if (thisColorIdx === nextColorIdx) continue; // inside same color (hard stop)
      while (hintIdx < hints.length && hints[hintIdx].afterColorIdx <= thisColorIdx) {
        const h = hints[hintIdx++];
        if (h.afterColorIdx !== thisColorIdx) continue;
        const a = stops[s];
        const b = stops[s + 1];
        if (!(h.pos > a.pos && h.pos < b.pos)) continue;
        const span = b.pos - a.pos;
        const hRel = (h.pos - a.pos) / span;
        const ca = a.color, cb = b.color;
        const sameColor = ca.r === cb.r && ca.g === cb.g && ca.b === cb.b && ca.a === cb.a;
        // H ≈ 0.5 ⇒ exponent ≈ 1 ⇒ linear, and identical colors need no curve —
        // both leave SVG's own A→B linear interpolation to do the right thing.
        if (sameColor || Math.abs(hRel - 0.5) < 1e-3) continue;
        const expo = Math.log(0.5) / Math.log(hRel);
        // Sample at uniform mix-WEIGHT (w = k/N), inverting to the position
        // t = w^(1/expo). Since SVG interpolates color linearly between stops and
        // color is linear in w, equal-w steps put a stop exactly where each even
        // colour increment occurs — which clusters stops near the curve's steep
        // region (a vertical colour tangent at t→0 for hints below midpoint) and
        // lands one stop precisely on the hint (w=0.5). Far better fit per stop
        // than uniform-t sampling. 8 segments → 7 interior stops.
        const SEGMENTS = 8;
        for (let k = 1; k < SEGMENTS; k++) {
          const w = k / SEGMENTS;
          const t = Math.pow(w, 1 / expo);
          out.push({
            color: {
              r: Math.round(ca.r + (cb.r - ca.r) * w),
              g: Math.round(ca.g + (cb.g - ca.g) * w),
              b: Math.round(ca.b + (cb.b - ca.b) * w),
              a: ca.a + (cb.a - ca.a) * w,
            },
            pos: a.pos + t * span,
          });
        }
      }
    }
    return out;
  }
  return stops;
}

/** Map 'to top', 'to right', 'to top right' etc. to a CSS gradient angle (deg).
 *
 * Corner-to-corner directions ('to top right', etc.) depend on the box's
 * aspect ratio per CSS spec — the gradient line is drawn between opposite
 * corners, so the angle is atan2(w, h) for a w×h box (not always 45°). This
 * matters for narrow/tall boxes: a 3:1 landscape 'to top right' is ~72°, not 45°.
 */
function cssDirectionToAngle(dir: string, w: number = 1, h: number = 1): number {
  const parts = dir.trim().toLowerCase().split(/\s+/);
  const set = new Set(parts);
  const hasTop = set.has("top");
  const hasBottom = set.has("bottom");
  const hasLeft = set.has("left");
  const hasRight = set.has("right");
  if (hasTop && !hasLeft && !hasRight) return 0;
  if (hasBottom && !hasLeft && !hasRight) return 180;
  if (hasRight && !hasTop && !hasBottom) return 90;
  if (hasLeft && !hasTop && !hasBottom) return 270;
  // Corner: angle from vertical axis to the line from opposite corner to this corner.
  const cornerAngle = Math.atan2(w, h) * 180 / Math.PI;
  if (hasTop && hasRight) return cornerAngle;
  if (hasBottom && hasRight) return 180 - cornerAngle;
  if (hasBottom && hasLeft) return 180 + cornerAngle;
  if (hasTop && hasLeft) return 360 - cornerAngle;
  return 180;
}

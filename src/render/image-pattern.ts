/**
 * CSS `background-image: url()` → SVG `<pattern>` tiling.
 *
 * Computes the tile size + origin offset + effective repeat unit for a url()
 * background layer and emits the `<pattern>` def. Extracted verbatim from
 * `element-tree-to-svg.ts` (DM-1305); deps are imported helpers only.
 */

import { r, esc } from "./format.js";
import { embedResizedDataUri } from "../capture/embed.js";

/** Compute the tile size + origin offset + effective repeat unit for a url() background layer. */
export function buildImagePatternDef(
  id: string, href: string,
  elX: number, elY: number, w: number, h: number,
  sizeCss: string, posCss: string, repeatCss: string,
  intrinsic: { w: number; h: number } | null,
  /**
   * background-attachment. When 'fixed' the image is anchored to the viewport,
   * not the element. For a static capture we don't need dynamic scroll-following —
   * we just need the right offset at t=0: viewport coords === SVG canvas coords,
   * so patX/patY should be viewport-relative instead of element-relative.
   * 'fixedViewport' is {w, h} of the capture viewport (needed for size keywords
   * like cover/contain/%).
   */
  attachment: string = "scroll",
  fixedViewport: { w: number; h: number } | null = null,
): string {
  // When background-attachment is fixed, the sizing + positioning basis is
  // the viewport, not the elements box. Override w/h + origin for that path.
  const isFixed = attachment === "fixed" && fixedViewport != null;
  const basisW = isFixed ? fixedViewport!.w : w;
  const basisH = isFixed ? fixedViewport!.h : h;
  const originX = isFixed ? 0 : elX;
  const originY = isFixed ? 0 : elY;
  // Split repeat into per-axis (CSS: repeat-x/-y are shorthands).
  let repH = "repeat", repV = "repeat";
  const rTok = repeatCss.trim().split(/\s+/);
  if (rTok[0] === "repeat-x") { repH = "repeat"; repV = "no-repeat"; }
  else if (rTok[0] === "repeat-y") { repH = "no-repeat"; repV = "repeat"; }
  else {
    repH = rTok[0];
    repV = rTok[1] ?? rTok[0];
  }

  // Resolve background-size into a concrete tile w/h. For fixed backgrounds
  // the basis is the viewport, not the element.
  let tileW = basisW, tileH = basisH;
  const sizeTok = sizeCss.trim().split(/\s+/);
  if (sizeCss === "cover") {
    if (intrinsic != null) {
      const scale = Math.max(basisW / intrinsic.w, basisH / intrinsic.h);
      tileW = intrinsic.w * scale;
      tileH = intrinsic.h * scale;
    }
  } else if (sizeCss === "contain") {
    if (intrinsic != null) {
      const scale = Math.min(basisW / intrinsic.w, basisH / intrinsic.h);
      tileW = intrinsic.w * scale;
      tileH = intrinsic.h * scale;
    }
  } else {
    const resolveSizeToken = (tok: string, basis: number, intrinsicDim: number): number => {
      if (tok == null || tok === "auto") return intrinsicDim;
      if (/%$/.test(tok)) return (parseFloat(tok) / 100) * basis;
      return parseFloat(tok) || intrinsicDim;
    };
    const hasTwo = sizeTok.length > 1;
    const intrinsicW = intrinsic?.w ?? basisW;
    const intrinsicH = intrinsic?.h ?? basisH;
    tileW = resolveSizeToken(sizeTok[0], basisW, intrinsicW);
    if (hasTwo) {
      tileH = resolveSizeToken(sizeTok[1], basisH, intrinsicH);
    } else if (sizeTok[0] === "auto") {
      tileH = intrinsicH;
    } else if (intrinsic != null) {
      // Single value sizes width; height scales proportionally to intrinsic aspect.
      tileH = tileW * (intrinsicH / intrinsicW);
    } else {
      tileH = basisH;
    }
  }

  // Resolve background-position. Keywords: left/right/top/bottom/center; %/px.
  // For fixed backgrounds the basis is the viewport. Chrome normalizes the
  // 4-token form "right 20px bottom 20px" to calc() form — e.g.
  // "calc(100% - 20px) calc(100% - 20px)" — so our tokenizer must respect
  // parens and the resolver must evaluate simple calc expressions.
  const tokenizeTopLevel = (s: string): string[] => {
    const tokens: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of s) {
      if (ch === "(") { depth++; current += ch; continue; }
      if (ch === ")") { depth--; current += ch; continue; }
      if (/\s/.test(ch) && depth === 0) {
        if (current !== "") { tokens.push(current); current = ""; }
        continue;
      }
      current += ch;
    }
    if (current !== "") tokens.push(current);
    return tokens;
  };
  const posTok = tokenizeTopLevel(posCss.trim());
  const evalCalc = (t: string, basis: number, tile: number): number => {
    const m = /^calc\((.+)\)$/.exec(t);
    if (m == null) return NaN;
    const parts = m[1].trim().split(/\s+([+-])\s+/);
    if (parts.length !== 3) return NaN;
    const [a, op, c] = parts;
    const reso = (s: string): number => {
      if (/%$/.test(s)) return (parseFloat(s) / 100) * (basis - tile);
      return parseFloat(s) || 0;
    };
    const lhs = reso(a);
    const rhs = reso(c);
    return op === "+" ? lhs + rhs : lhs - rhs;
  };
  const resolveH = (t: string): number => {
    if (t === "left") return 0;
    if (t === "right") return basisW - tileW;
    if (t === "center") return (basisW - tileW) / 2;
    if (t.startsWith("calc(")) return evalCalc(t, basisW, tileW);
    if (/%$/.test(t)) return ((parseFloat(t) / 100) * (basisW - tileW));
    return parseFloat(t) || 0;
  };
  const resolveV = (t: string): number => {
    if (t === "top") return 0;
    if (t === "bottom") return basisH - tileH;
    if (t === "center") return (basisH - tileH) / 2;
    if (t.startsWith("calc(")) return evalCalc(t, basisH, tileH);
    if (/%$/.test(t)) return ((parseFloat(t) / 100) * (basisH - tileH));
    return parseFloat(t) || 0;
  };
  const isHoriz = (t: string): boolean => t === "left" || t === "right";
  const isVert = (t: string): boolean => t === "top" || t === "bottom";
  const isLen = (t: string): boolean => /^-?\d/.test(t) || t === "0";
  // Parse an explicit offset value (px or %) used after a side keyword in the
  // 4-token form. Percentages scale against the available space.
  const parseAxisOffset = (t: string, basis: number, tile: number): number => {
    if (/%$/.test(t)) return ((parseFloat(t) / 100) * (basis - tile));
    return parseFloat(t) || 0;
  };
  let posX: number;
  let posY: number;
  // 4-token form: side offset side offset — e.g. "right 20px bottom 20px".
  // Each side keyword is anchored to the matching edge and the offset pushes
  // the tile inward.
  if (
    posTok.length >= 4
    && (isHoriz(posTok[0]) || isVert(posTok[0]))
    && isLen(posTok[1])
    && (isHoriz(posTok[2]) || isVert(posTok[2]))
    && isLen(posTok[3])
  ) {
    const aIsH = isHoriz(posTok[0]);
    const hSide = aIsH ? posTok[0] : posTok[2];
    const hOff = aIsH ? posTok[1] : posTok[3];
    const vSide = aIsH ? posTok[2] : posTok[0];
    const vOff = aIsH ? posTok[3] : posTok[1];
    posX = hSide === "right"
      ? basisW - tileW - parseAxisOffset(hOff, basisW, tileW)
      : parseAxisOffset(hOff, basisW, tileW);
    posY = vSide === "bottom"
      ? basisH - tileH - parseAxisOffset(vOff, basisH, tileH)
      : parseAxisOffset(vOff, basisH, tileH);
  } else {
    posX = resolveH(posTok[0] ?? "0%");
    posY = resolveV(posTok[1] ?? posTok[0] ?? "0%");
    // Swap when keywords are given in vertical-first order (e.g. "top 50%").
    if (posTok[0] === "top" || posTok[0] === "bottom") {
      posY = resolveV(posTok[0]);
      posX = resolveH(posTok[1] ?? "50%");
    }
  }

  // 'round' rebinds tile size so count is integer.
  if (repH === "round" && intrinsic != null) {
    const count = Math.max(1, Math.round(basisW / tileW));
    tileW = basisW / count;
  }
  if (repV === "round" && intrinsic != null) {
    const count = Math.max(1, Math.round(basisH / tileH));
    tileH = basisH / count;
  }
  const periodW = (repH === "repeat" || repH === "round") ? tileW
                : repH === "space" ? Math.max(tileW, basisW / Math.max(1, Math.floor(basisW / tileW)))
                : basisW * 2; // no-repeat: make pattern huge so only one tile fits
  const periodH = (repV === "repeat" || repV === "round") ? tileH
                : repV === "space" ? Math.max(tileH, basisH / Math.max(1, Math.floor(basisH / tileH)))
                : basisH * 2;

  // Pattern position in userSpaceOnUse — absolute SVG canvas coords. The
  // pattern unit cell starts here and repeats every (periodW × periodH).
  // DM-935: for no-repeat with `background-size: cover` where the scaled
  // image is LARGER than the tile (image extends above / below the tile
  // with a negative posX/posY), DON'T shift the cell origin by
  // (posX, posY) — the previous shifting placed the FIRST pattern cell
  // at the image's top-left (outside the tile) and the tile sat in the
  // SECOND row of repeated cells where only the image's clipped-top
  // portion paints (typically empty padding above the visible content).
  // Anchor the cell at the element origin instead, and place the IMAGE
  // inside the cell at (posX, posY) so the tile area samples the
  // correct (center-overflow-clipped) portion of the image.
  //
  // Backwards-compat: when the image is SMALLER than or equal to the
  // basis on both axes (no overflow) keep the existing
  // shift-the-cell-origin behaviour — the prior layout works for
  // contain / explicit-size / repeating patterns where the image fits
  // and the original offset positions it correctly within the tile.
  const imageOverflows = tileW > basisW || tileH > basisH;
  let patX: number;
  let patY: number;
  let imgX: number;
  let imgY: number;
  if (imageOverflows && (repH === "no-repeat" || repV === "no-repeat")) {
    patX = originX;
    patY = originY;
    imgX = posX;
    imgY = posY;
  } else {
    patX = originX + posX;
    patY = originY + posY;
    imgX = 0;
    imgY = 0;
  }

  return `<pattern id="${id}" patternUnits="userSpaceOnUse" x="${r(patX)}" y="${r(patY)}" width="${r(periodW)}" height="${r(periodH)}"><image href="${esc(embedResizedDataUri(href, tileW, tileH))}" x="${r(imgX)}" y="${r(imgY)}" width="${r(tileW)}" height="${r(tileH)}" preserveAspectRatio="none" /></pattern>`;
}

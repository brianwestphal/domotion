/**
 * Mask + masking-fragment def builders, extracted from element-tree-to-svg.ts
 * (DM-1305). Covers CSS `mask` / `mask-image` (gradient + url() + composite),
 * `mask-border` 9-slice, and the captured-fragment `<mask>` / `<clipPath>`
 * rewrite + positioning helpers (DM-493 / DM-828). Behavior-identical lift;
 * external deps are imported utilities only.
 */

import { r, esc } from "./format.js";
import { embedResizedDataUri } from "../capture/embed.js";
import { parseCssUrl, splitTopLevelCommas } from "./css-tokens.js";
import { buildImagePatternDef } from "./image-pattern.js";
import { buildLinearGradientDef, buildRadialGradientDef } from "./gradient-defs.js";
import type { CapturedElement, MaskRasterRef } from "../capture/types.js";

/**
 * Rewrite a captured `<mask>` element's `outerHTML` so it can be safely
 * inlined in the output SVG's `<defs>`. The mask's own `id` becomes
 * `outputId`, and every other DOM id referenced inside the subtree gets
 * prefixed with `idPrefix` so it can't collide with ids elsewhere in the
 * output (multi-frame animated SVGs reuse the same prefix model). Every
 * `url(#X)` reference inside the subtree is updated to point at the
 * rewritten id. DM-493.
 */
export function rewriteFragmentMaskDef(
  outerHTML: string,
  outputId: string,
  idPrefix: string,
): string {
  // Discover all ids defined inside the subtree (the outer <mask>'s own id
  // plus any descendants that carry an id="…"). The outer mask id maps to
  // `outputId`; every other id maps to `${idPrefix}fragid-${original}` so the
  // mapping is stable across multiple references and unique across captures.
  const idMap = new Map<string, string>();
  const idDefRe = /\sid\s*=\s*"([^"]+)"|\sid\s*=\s*'([^']+)'/g;
  let firstId: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = idDefRe.exec(outerHTML)) != null) {
    const id = m[1] ?? m[2] ?? "";
    if (id === "") continue;
    if (firstId == null) {
      firstId = id;
      idMap.set(id, outputId);
    } else if (!idMap.has(id)) {
      idMap.set(id, `${idPrefix}fragid-${id}`);
    }
  }
  // Substitute id="X" — only ids we discovered, to avoid touching id strings
  // that happen to appear inside attribute values that aren't id attributes.
  let out = outerHTML.replace(/(\sid\s*=\s*)("([^"]+)"|'([^']+)')/g, (_, prefix, _full, dq, sq) => {
    const original = dq ?? sq ?? "";
    const replaced = idMap.get(original);
    if (replaced == null) return prefix + (dq != null ? `"${original}"` : `'${original}'`);
    return prefix + `"${replaced}"`;
  });
  // Substitute url(#X) refs throughout the subtree.
  out = out.replace(/url\(\s*(?:"|')?#([^"')\s]+)(?:"|')?\s*\)/g, (full, ref) => {
    const replaced = idMap.get(ref);
    return replaced == null ? full : `url(#${replaced})`;
  });
  // Substitute href="#X" / xlink:href="#X" refs (e.g. <use href="#…">).
  out = out.replace(/(\s(?:xlink:)?href\s*=\s*)("#([^"]+)"|'#([^']+)')/g, (full, prefix, _q, dq, sq) => {
    const original = dq ?? sq ?? "";
    const replaced = idMap.get(original);
    return replaced == null ? full : prefix + `"#${replaced}"`;
  });
  return out;
}

/**
 * Reposition a (previously rewritten) `<mask>` outerHTML so its content lives
 * in the masked element's absolute user-space. CSS `mask-image: url("#id")`
 * positions the mask source at the masked element's content-box origin, but
 * SVG `<mask>` with `maskUnits="userSpaceOnUse"` interprets its content
 * absolutely against the root SVG — so the captured mask coords (which are
 * relative to the original `<mask>` element) need shifting by `(elX, elY)`.
 * We do this by:
 *   1. Forcing `maskUnits="userSpaceOnUse"` on the outer `<mask>`.
 *   2. Replacing the mask's `x/y/width/height` with the masked element's
 *      absolute box (so the mask region matches the element).
 *   3. Wrapping the mask's children in `<g transform="translate(elX, elY)">`.
 * DM-493.
 */
export function positionFragmentMaskDef(
  rewrittenOuterHTML: string,
  elX: number, elY: number, elW: number, elH: number,
): string {
  // Find the opening <mask …> tag (anchored at start of string, since
  // rewriteFragmentMaskDef preserves the outerHTML structure of the captured
  // <mask> element).
  const openMatch = /^<mask\b([^>]*)>/i.exec(rewrittenOuterHTML);
  if (openMatch == null) return rewrittenOuterHTML;
  const closeIdx = rewrittenOuterHTML.lastIndexOf("</mask>");
  if (closeIdx < 0) return rewrittenOuterHTML;
  const inner = rewrittenOuterHTML.slice(openMatch[0].length, closeIdx);
  // Strip existing maskUnits / x / y / width / height — we replace them.
  let attrs = openMatch[1]
    .replace(/\smaskUnits\s*=\s*"[^"]*"/gi, "")
    .replace(/\smaskUnits\s*=\s*'[^']*'/gi, "")
    .replace(/\smaskContentUnits\s*=\s*"[^"]*"/gi, "")
    .replace(/\smaskContentUnits\s*=\s*'[^']*'/gi, "")
    .replace(/\sx\s*=\s*"[^"]*"/gi, "")
    .replace(/\sx\s*=\s*'[^']*'/gi, "")
    .replace(/\sy\s*=\s*"[^"]*"/gi, "")
    .replace(/\sy\s*=\s*'[^']*'/gi, "")
    .replace(/\swidth\s*=\s*"[^"]*"/gi, "")
    .replace(/\swidth\s*=\s*'[^']*'/gi, "")
    .replace(/\sheight\s*=\s*"[^"]*"/gi, "")
    .replace(/\sheight\s*=\s*'[^']*'/gi, "");
  attrs += ` maskUnits="userSpaceOnUse" x="${r(elX)}" y="${r(elY)}" width="${r(elW)}" height="${r(elH)}"`;
  return `<mask${attrs}><g transform="translate(${r(elX)}, ${r(elY)})">${inner}</g></mask>`;
}

/**
 * DM-828: position a `clipPathUnits="userSpaceOnUse"` fragment clipPath for an
 * HTML element at absolute (elX, elY). A userSpaceOnUse clipPath's coordinates
 * are element-local — origin at the element's border-box top-left (verified
 * against Chrome) — but Domotion draws the element's content at absolute
 * (elX, elY) with no positioning transform, so the clip geometry must be
 * shifted by (elX, elY) to land on it. `<clipPath>` can't wrap its children in
 * a `<g>` (not a permitted clipPath child in SVG 1.1), but it *does* accept a
 * `transform` attribute that maps its content into user space (Chrome honors
 * it), so we add `translate(elX, elY)` there — composing with any transform the
 * captured clipPath already carried (ours outermost, applied after theirs).
 */
export function positionFragmentClipPathDef(
  rewrittenOuterHTML: string,
  elX: number, elY: number,
): string {
  const openMatch = /^<clipPath\b([^>]*)>/i.exec(rewrittenOuterHTML);
  if (openMatch == null) return rewrittenOuterHTML;
  const translate = `translate(${r(elX)}, ${r(elY)})`;
  let attrs = openMatch[1];
  const existing = /\stransform\s*=\s*"([^"]*)"/i.exec(attrs) ?? /\stransform\s*=\s*'([^']*)'/i.exec(attrs);
  if (existing != null) {
    attrs = attrs.replace(existing[0], ` transform="${translate} ${existing[1]}"`);
  } else {
    attrs += ` transform="${translate}"`;
  }
  return `<clipPath${attrs}>${rewrittenOuterHTML.slice(openMatch[0].length)}`;
}

/**
 * Translate a CSS mask-image value + mask-* siblings into an SVG <mask>.
 * Handles single-layer gradients and url() sources. Position/size/repeat are
 * applied via an internal <pattern> for url sources; gradients use direct
 * gradient fills sized to the element box.
 *
 * SVG <mask> uses luminance by default (bright pixels visible). CSS mask-mode
 * 'alpha' makes the alpha channel control visibility. We set mask-type on the
 * <mask> element accordingly. Note: Chromium may render mask-mode:'match-source'
 * differently depending on the source; we pick alpha for gradients and url()
 * (common case) and respect explicit mask-mode when given.
 */
/**
 * DM-793: build the SVG `<mask>` def for a `mask-border` URL source with
 * non-trivial 9-slice values. Mirrors `renderBorderImage` (in `borders.ts`)
 * but emits each corner / edge / center piece as a child of the `<mask>`
 * rather than as direct paint, so the source's alpha channel becomes the
 * element's mask. Per spec `mask-border-mode` defaults to `alpha`, so we
 * always emit `mask-type="alpha"`.
 *
 * Returns `{ id, def, nextClipIdx }` so the caller can chain the next
 * clip / mask id allocation. Returns `null` when the slice / width values
 * resolve to a degenerate region (no mask painted).
 */
type MaskBorderRepeat = "stretch" | "repeat" | "round" | "space";
const MASK_BORDER_REPEATS = new Set<string>(["stretch", "repeat", "round", "space"]);

function normalizeMaskBorderRepeat(raw: string | undefined): MaskBorderRepeat {
  if (raw != null && MASK_BORDER_REPEATS.has(raw)) return raw as MaskBorderRepeat;
  return "stretch";
}

export function buildMaskBorder9Slice(
  el: CapturedElement,
  url: string,
  sliceRaw: string,
  widthRaw: string,
  outsetRaw: string,
  repeatRaw: string,
  maskId: string,
  idPrefix: string,
  clipIdxStart: number,
): { id: string; def: string; nextClipIdx: number } | null {
  const natW = el.styles.maskBorderIntrinsicWidth ?? 0;
  const natH = el.styles.maskBorderIntrinsicHeight ?? 0;
  if (natW <= 0 || natH <= 0) return null;

  // Slice — numbers are source pixels, percentages of source dims, optional `fill`.
  const fillCenter = /\bfill\b/i.test(sliceRaw);
  const sliceTokens = sliceRaw.replace(/\bfill\b/i, "").trim().split(/\s+/);
  const parseSliceTok = (t: string | undefined): { pct?: number; px?: number } => {
    if (t == null || t === "") return { px: 0 };
    if (/%$/.test(t)) return { pct: parseFloat(t) };
    return { px: parseFloat(t) };
  };
  const sliceNums = sliceTokens.map(parseSliceTok);
  const resolveSlice = (tok: { pct?: number; px?: number }, basis: number): number => {
    if (tok.pct != null) return (tok.pct / 100) * basis;
    return tok.px ?? 0;
  };
  const st = resolveSlice(sliceNums[0] ?? { px: 0 }, natH);
  const sr = resolveSlice(sliceNums[1] ?? sliceNums[0] ?? { px: 0 }, natW);
  const sb = resolveSlice(sliceNums[2] ?? sliceNums[0] ?? { px: 0 }, natH);
  const sl = resolveSlice(sliceNums[3] ?? sliceNums[1] ?? sliceNums[0] ?? { px: 0 }, natW);

  // Width — px / % / unitless multiplier of border-width (defaults to 0 for
  // mask-border since masks usually have no element border).
  const bwTop = parseFloat(el.styles.borderTopWidth ?? "0") || 0;
  const bwRight = parseFloat(el.styles.borderRightWidth ?? "0") || 0;
  const bwBottom = parseFloat(el.styles.borderBottomWidth ?? "0") || 0;
  const bwLeft = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
  const parseLen = (tok: string | undefined, basis: number, borderW: number): number => {
    if (tok == null || tok === "" || tok === "auto") return borderW;
    if (/%$/.test(tok)) return (parseFloat(tok) / 100) * basis;
    if (/(px|em|rem|pt|pc|cm|mm|in|Q)$/.test(tok)) return parseFloat(tok) || 0;
    const n = parseFloat(tok);
    return Number.isFinite(n) ? n * borderW : borderW;
  };
  const wTokens = widthRaw.trim().split(/\s+/);
  const wt = parseLen(wTokens[0], el.height, bwTop);
  const wr = parseLen(wTokens[1] ?? wTokens[0], el.width, bwRight);
  const wb = parseLen(wTokens[2] ?? wTokens[0], el.height, bwBottom);
  const wl = parseLen(wTokens[3] ?? wTokens[1] ?? wTokens[0], el.width, bwLeft);

  // Outset — defaults to 0.
  const parseOutset = (tok: string | undefined, basis: number, borderW: number): number => {
    if (tok == null || tok === "") return 0;
    if (/%$/.test(tok)) return (parseFloat(tok) / 100) * basis;
    if (/(px|em|rem|pt|pc|cm|mm|in|Q)$/.test(tok)) return parseFloat(tok) || 0;
    const n = parseFloat(tok);
    return Number.isFinite(n) ? n * borderW : 0;
  };
  const oTokens = outsetRaw.trim().split(/\s+/);
  const ot = parseOutset(oTokens[0], el.height, bwTop);
  const or_ = parseOutset(oTokens[1] ?? oTokens[0], el.width, bwRight);
  const ob = parseOutset(oTokens[2] ?? oTokens[0], el.height, bwBottom);
  const ol = parseOutset(oTokens[3] ?? oTokens[1] ?? oTokens[0], el.width, bwLeft);

  // Mask region = border-box ± outset.
  const boxX = el.x - ol;
  const boxY = el.y - ot;
  const boxW = el.width + ol + or_;
  const boxH = el.height + ot + ob;
  if (boxW <= 0 || boxH <= 0) return null;

  // Repeat — `stretch` / `repeat` / `round` / `space` (per axis, optional).
  const rTokens = repeatRaw.trim().toLowerCase().split(/\s+/);
  const rH = normalizeMaskBorderRepeat(rTokens[0]);
  const rV = rTokens[1] != null && rTokens[1] !== "" ? normalizeMaskBorderRepeat(rTokens[1]) : rH;

  const x0 = boxX, x1 = boxX + wl, x2 = boxX + boxW - wr, x3 = boxX + boxW;
  const y0 = boxY, y1 = boxY + wt, y2 = boxY + boxH - wb, y3 = boxY + boxH;
  const sxL = 0, sxR = natW - sr, sxC = sl, sxW_C = natW - sl - sr;
  const syT = 0, syB = natH - sb, syC = st, syH_C = natH - st - sb;

  const maskChildren: string[] = [];
  const maskDefs: string[] = []; // patterns + clipPaths nested inside the <mask>
  let clipIdx = clipIdxStart;

  // For each piece, emit either an `<image>` (stretched) or a `<rect>` filled
  // by a `<pattern>` that tiles the source slice. clipPath is needed to
  // restrict the stretched-image emit to the destination rect.
  const emitStretched = (
    dxSlot: number, dySlot: number, dwSlot: number, dhSlot: number,
    sx: number, sy: number, sw: number, sh: number,
  ): void => {
    if (dwSlot <= 0 || dhSlot <= 0 || sw <= 0 || sh <= 0) return;
    const clipId = `${idPrefix}mbic${clipIdx++}`;
    maskDefs.push(`<clipPath id="${clipId}"><rect x="${r(dxSlot)}" y="${r(dySlot)}" width="${r(dwSlot)}" height="${r(dhSlot)}" /></clipPath>`);
    const scaleX = dwSlot / sw;
    const scaleY = dhSlot / sh;
    const imgX = dxSlot - sx * scaleX;
    const imgY = dySlot - sy * scaleY;
    const imgW = natW * scaleX;
    const imgH = natH * scaleY;
    maskChildren.push(`<image href="${esc(embedResizedDataUri(url, imgW, imgH))}" x="${r(imgX)}" y="${r(imgY)}" width="${r(imgW)}" height="${r(imgH)}" preserveAspectRatio="none" clip-path="url(#${clipId})" />`);
  };

  const emitTiledEdge = (
    dxSlot: number, dySlot: number, dwSlot: number, dhSlot: number,
    sx: number, sy: number, sw: number, sh: number,
    axis: "x" | "y", mode: "repeat" | "round" | "space",
  ): void => {
    if (dwSlot <= 0 || dhSlot <= 0 || sw <= 0 || sh <= 0) return;
    let tileW: number, tileH: number;
    if (axis === "x") {
      tileH = dhSlot;
      tileW = sw * (dhSlot / sh);
      if (mode === "round") {
        const count = Math.max(1, Math.round(dwSlot / tileW));
        tileW = dwSlot / count;
      }
    } else {
      tileW = dwSlot;
      tileH = sh * (dwSlot / sw);
      if (mode === "round") {
        const count = Math.max(1, Math.round(dhSlot / tileH));
        tileH = dhSlot / count;
      }
    }
    let patternW = tileW, patternH = tileH;
    let patternX = dxSlot, patternY = dySlot;
    if (mode === "space") {
      if (axis === "x") {
        const count = Math.floor(dwSlot / tileW);
        if (count <= 0) return;
        patternW = dwSlot / count;
        patternX = dxSlot + (patternW - tileW) / 2;
      } else {
        const count = Math.floor(dhSlot / tileH);
        if (count <= 0) return;
        patternH = dhSlot / count;
        patternY = dySlot + (patternH - tileH) / 2;
      }
    }
    const patId = `${idPrefix}mbip${clipIdx++}`;
    const imgScaleX = tileW / sw;
    const imgScaleY = tileH / sh;
    const inImgX = -sx * imgScaleX;
    const inImgY = -sy * imgScaleY;
    const inImgW = natW * imgScaleX;
    const inImgH = natH * imgScaleY;
    const clipBgId = mode === "space" ? `${idPrefix}mbic${clipIdx++}` : "";
    const clipDef = mode === "space"
      ? `<clipPath id="${clipBgId}"><rect x="0" y="0" width="${r(tileW)}" height="${r(tileH)}" /></clipPath>`
      : "";
    const imgClip = mode === "space" ? ` clip-path="url(#${clipBgId})"` : "";
    maskDefs.push(`<pattern id="${patId}" patternUnits="userSpaceOnUse" x="${r(patternX)}" y="${r(patternY)}" width="${r(patternW)}" height="${r(patternH)}">${clipDef}<image href="${esc(embedResizedDataUri(url, inImgW, inImgH))}" x="${r(inImgX)}" y="${r(inImgY)}" width="${r(inImgW)}" height="${r(inImgH)}" preserveAspectRatio="none"${imgClip} /></pattern>`);
    maskChildren.push(`<rect x="${r(dxSlot)}" y="${r(dySlot)}" width="${r(dwSlot)}" height="${r(dhSlot)}" fill="url(#${patId})" />`);
  };

  // Center 9-piece tiler — handles 2D tiling (both `repeat` / `round` / `space`
  // axes simultaneously). Mirrors Chromium's `NinePieceImageGrid::SetDrawInfoMiddle`
  // + `ComputeTileParameters` in `third_party/blink/renderer/core/paint/`:
  //   - The center's `tile_scale` is the SAME ratio as the adjacent edge:
  //     `scaleX = top.Scale() = wt/st` (or `wb/sb` if no top); `scaleY = wl/sl` (or `wr/sr`).
  //     Each tile in dest = source-center-slice scaled by that factor.
  //   - `space` distributes (dst - tiles*tile_size) across (tiles + 1) gaps —
  //     a half-spacing gap at each end and full spacing between tiles. (NOT
  //     "flush with edges" as the spec text suggests; Chrome's impl is the
  //     spec it ships.)
  //   - `repeat` centres the pattern with phase = (dst - tile) / 2.
  //   - `round` rescales the tile so a whole number fits exactly.
  //   - `stretch` collapses to a single tile spanning the full slot — fall
  //     through to the existing `emitStretched`.
  const emitTiledCenter = (
    dxSlot: number, dySlot: number, dwSlot: number, dhSlot: number,
    sx: number, sy: number, sw: number, sh: number,
    scaleX: number, scaleY: number,
    modeH: MaskBorderRepeat, modeV: MaskBorderRepeat,
  ): void => {
    if (dwSlot <= 0 || dhSlot <= 0 || sw <= 0 || sh <= 0 || scaleX <= 0 || scaleY <= 0) return;
    let tileW = sw * scaleX;
    let tileH = sh * scaleY;
    if (tileW <= 0 || tileH <= 0) return;
    let periodW = tileW, periodH = tileH;
    let phaseX = 0, phaseY = 0;
    if (modeH === "round") {
      const c = Math.max(1, Math.round(dwSlot / tileW));
      tileW = dwSlot / c;
      periodW = tileW;
    } else if (modeH === "space") {
      const c = Math.floor(dwSlot / tileW);
      if (c <= 0) return;
      const sp = (dwSlot - c * tileW) / (c + 1);
      periodW = tileW + sp;
      phaseX = sp;
    } else if (modeH === "repeat") {
      phaseX = (dwSlot - tileW) / 2;
      // Anchor the centered pattern at dxSlot for SVG's userSpaceOnUse so
      // tiles step out symmetrically; phaseX may go negative, that's fine.
    } else {
      // stretch on x: one tile spans the full width.
      tileW = dwSlot;
      periodW = dwSlot;
    }
    if (modeV === "round") {
      const c = Math.max(1, Math.round(dhSlot / tileH));
      tileH = dhSlot / c;
      periodH = tileH;
    } else if (modeV === "space") {
      const c = Math.floor(dhSlot / tileH);
      if (c <= 0) return;
      const sp = (dhSlot - c * tileH) / (c + 1);
      periodH = tileH + sp;
      phaseY = sp;
    } else if (modeV === "repeat") {
      phaseY = (dhSlot - tileH) / 2;
    } else {
      tileH = dhSlot;
      periodH = dhSlot;
    }
    const imgScaleX = tileW / sw;
    const imgScaleY = tileH / sh;
    const inImgX = -sx * imgScaleX;
    const inImgY = -sy * imgScaleY;
    const inImgW = natW * imgScaleX;
    const inImgH = natH * imgScaleY;
    // Clip the in-pattern image to the tile bounds whenever the pattern
    // period exceeds the tile size — i.e. when an axis has `space` (which
    // introduces gaps between tiles) — so the source extends into the gap
    // region don't paint into the spacing.
    const needsClip = modeH === "space" || modeV === "space";
    const patId = `${idPrefix}mbip${clipIdx++}`;
    let clipDef = "", imgClip = "";
    if (needsClip) {
      const clipId = `${idPrefix}mbic${clipIdx++}`;
      clipDef = `<clipPath id="${clipId}"><rect x="0" y="0" width="${r(tileW)}" height="${r(tileH)}" /></clipPath>`;
      imgClip = ` clip-path="url(#${clipId})"`;
    }
    maskDefs.push(`<pattern id="${patId}" patternUnits="userSpaceOnUse" x="${r(dxSlot + phaseX)}" y="${r(dySlot + phaseY)}" width="${r(periodW)}" height="${r(periodH)}">${clipDef}<image href="${esc(embedResizedDataUri(url, inImgW, inImgH))}" x="${r(inImgX)}" y="${r(inImgY)}" width="${r(inImgW)}" height="${r(inImgH)}" preserveAspectRatio="none"${imgClip} /></pattern>`);
    maskChildren.push(`<rect x="${r(dxSlot)}" y="${r(dySlot)}" width="${r(dwSlot)}" height="${r(dhSlot)}" fill="url(#${patId})" />`);
  };

  // 4 corners — always stretched.
  emitStretched(x0, y0, wl, wt, sxL, syT, sl, st);   // NW
  emitStretched(x2, y0, wr, wt, sxR, syT, sr, st);   // NE
  emitStretched(x0, y2, wl, wb, sxL, syB, sl, sb);   // SW
  emitStretched(x2, y2, wr, wb, sxR, syB, sr, sb);   // SE
  // Top + Bottom edges.
  if (rH === "stretch") {
    emitStretched(x1, y0, x2 - x1, wt, sxC, syT, sxW_C, st);
    emitStretched(x1, y2, x2 - x1, wb, sxC, syB, sxW_C, sb);
  } else {
    emitTiledEdge(x1, y0, x2 - x1, wt, sxC, syT, sxW_C, st, "x", rH);
    emitTiledEdge(x1, y2, x2 - x1, wb, sxC, syB, sxW_C, sb, "x", rH);
  }
  // Left + Right edges.
  if (rV === "stretch") {
    emitStretched(x0, y1, wl, y2 - y1, sxL, syC, sl, syH_C);
    emitStretched(x2, y1, wr, y2 - y1, sxR, syC, sr, syH_C);
  } else {
    emitTiledEdge(x0, y1, wl, y2 - y1, sxL, syC, sl, syH_C, "y", rV);
    emitTiledEdge(x2, y1, wr, y2 - y1, sxR, syC, sr, syH_C, "y", rV);
  }
  // Center — when `fill` is present in the slice. Chrome's
  // `-webkit-mask-box-image` parser implicitly adds `fill` even when CSS
  // doesn't write it; the capture-side reads from the webkit-prefixed
  // properties so that resolved `fill` flows through here. Per spec the
  // center's tile_scale is Edge::Scale() from the adjacent edges (wt/st on
  // x, wl/sl on y) — NOT a stretch-to-fill — so `space` / `round` / `repeat`
  // modes tile the source-center subimage across the dest area at that
  // scale, NOT one giant stretched tile. (See DM-825 + the `niche-mask-border`
  // .mb-3 fixture: 5×3 grid of 32×32 source-center tiles with 2.67 px
  // horizontal `space` gaps + 0 vertical gap, fused with the 16×96 left/
  // right edge tiles + corners to paint 7 visible vertical slats.)
  if (fillCenter) {
    if (rH === "stretch" && rV === "stretch") {
      emitStretched(x1, y1, x2 - x1, y2 - y1, sxC, syC, sxW_C, syH_C);
    } else {
      // Edge::Scale() for the adjacent edges; fall back to bottom/right
      // when top/left are zero-width (degenerate but possible).
      const scaleX = st > 0 && wt > 0 ? wt / st : (sb > 0 && wb > 0 ? wb / sb : 1);
      const scaleY = sl > 0 && wl > 0 ? wl / sl : (sr > 0 && wr > 0 ? wr / sr : 1);
      emitTiledCenter(x1, y1, x2 - x1, y2 - y1, sxC, syC, sxW_C, syH_C, scaleX, scaleY, rH, rV);
    }
  }

  if (maskChildren.length === 0) return null;
  const def = `<mask id="${maskId}" maskUnits="userSpaceOnUse" mask-type="alpha">${maskDefs.join("")}${maskChildren.join("")}</mask>`;
  return { id: maskId, def, nextClipIdx: clipIdx };
}

/**
 * DM-1251: map a `mask-position` token list to an SVG `preserveAspectRatio`
 * alignment (`<xAlign><yAlign>`) for the `mask-size: contain|cover` path, where
 * the <image> fills the element box and the fitted image is aligned within it.
 * Keywords (left/right/top/bottom/center) and 0/50/100% map exactly; other
 * percentages / px approximate to the nearest Min/Mid/Max (SVG offers no finer
 * alignment). Keyword order is irrelevant (`top left` == `left top`).
 */
export function maskContainAlign(posTokens: string[]): string {
  let x = "xMid", y = "YMid";
  let xSet = false, ySet = false;
  const pctAlign = (v: number): string => (v <= 0 ? "Min" : v >= 100 ? "Max" : "Mid");
  for (const tok of posTokens) {
    const t = tok.trim().toLowerCase();
    if (t === "left") { x = "xMin"; xSet = true; }
    else if (t === "right") { x = "xMax"; xSet = true; }
    else if (t === "top") { y = "YMin"; ySet = true; }
    else if (t === "bottom") { y = "YMax"; ySet = true; }
    else if (t === "center" || t === "") { /* ambiguous axis — leave as Mid */ }
    else if (/%$/.test(t)) {
      // Positional: first unset axis is horizontal, then vertical.
      const a = pctAlign(parseFloat(t));
      if (!xSet) { x = "x" + a; xSet = true; }
      else if (!ySet) { y = "Y" + a; ySet = true; }
    }
    // px / unrecognized: leave as Mid (approximation).
  }
  return x + y;
}

/** Inputs for one mask-image layer — the per-layer slice of `buildMaskDef`'s
 *  args plus the already-resolved size/position/repeat for that layer index. */
interface MaskLayerInput {
  id: string;
  li: number;
  elX: number;
  elY: number;
  w: number;
  h: number;
  /** The trimmed layer value (a gradient / `element(#id)` / `url(...)`). */
  layer: string;
  layerSize: string;
  layerPos: string;
  layerRepeat: string;
  elementRasters?: ReadonlyMap<string, MaskRasterRef>;
}

/**
 * Build the SVG content (gradient/pattern defs + the painting rect/image) for a
 * SINGLE mask-image layer. Extracted from `buildMaskDef`'s per-layer loop
 * (DM-1458) — the loop body was ~200 lines of gradient / `element()` / `url()`
 * branch logic. Returns the layer's content strings (empty for unsupported or
 * no-op layers) plus `forceHide`, set when the layer is a remote SVG `url()`
 * source that Chrome renders as a full hide (SK-859/SK-860) — the caller forces
 * emission of an empty `<mask>` in that case.
 */
function buildMaskLayer(input: MaskLayerInput): { contents: string[]; forceHide: boolean } {
  const { id, li, elX, elY, w, h, layer, layerSize, layerPos, layerRepeat, elementRasters } = input;
  const contents: string[] = [];
  const gradient = /^(?:repeating-)?(linear|radial)-gradient\(/i.test(layer);
  if (gradient) {
    // Resolve mask-size (defaults to 'auto' = full element box) and
    // mask-position (defaults to 0% 0%) so gradient masks honor the same
    // positioning model as url() masks. mask-size:80px+mask-position:25% 25%
    // means the gradient is painted in an 80x80 patch positioned 25%/25% of
    // the available space — not stretched to fill the whole element.
    let gradW = w, gradH = h;
    const sizeTok = layerSize.trim().split(/\s+/);
    const resolveSize = (tok: string, basis: number, fallback: number): number => {
      if (tok == null || tok === "auto" || tok === "") return fallback;
      if (/%$/.test(tok)) return (parseFloat(tok) / 100) * basis;
      return parseFloat(tok) || fallback;
    };
    if (layerSize === "contain" || layerSize === "cover" || layerSize === "auto" || layerSize === "") {
      gradW = w; gradH = h;
    } else {
      gradW = resolveSize(sizeTok[0], w, w);
      // DM-679: single-length mask-size per CSS Backgrounds 3 §3.7
      // means `width=N, height=auto`. For gradient layers (no intrinsic
      // size) `auto` resolves to the container's corresponding axis, not
      // to the width again. Previously we squared the box (gradH = gradW)
      // which made `radial-gradient(circle, …) mask-size: 80px` paint a
      // smaller hard circle than Chrome (radius derived from 80×80 farthest-
      // corner ≈ 56.6 vs Chrome's 80×containerH farthest-corner ≈ 72).
      gradH = sizeTok.length > 1 ? resolveSize(sizeTok[1], h, h) : h;
    }
    const posTok = layerPos.trim().split(/\s+/);
    const resolveH = (t: string): number => {
      if (t === "left") return 0;
      if (t === "right") return w - gradW;
      if (t === "center") return (w - gradW) / 2;
      if (/%$/.test(t)) return (parseFloat(t) / 100) * (w - gradW);
      return parseFloat(t) || 0;
    };
    const resolveV = (t: string): number => {
      if (t === "top") return 0;
      if (t === "bottom") return h - gradH;
      if (t === "center") return (h - gradH) / 2;
      if (/%$/.test(t)) return (parseFloat(t) / 100) * (h - gradH);
      return parseFloat(t) || 0;
    };
    const gx = elX + resolveH(posTok[0] ?? "0%");
    const gy = elY + resolveV(posTok[1] ?? posTok[0] ?? "0%");
    const gradId = `${id}g${li}`;
    const linear = /^(?:repeating-)?linear-gradient\((.+)\)$/i.exec(layer);
    const radial = /^(?:repeating-)?radial-gradient\((.+)\)$/i.exec(layer);
    let def = "";
    if (linear != null) def = buildLinearGradientDef(gradId, linear[1], /^repeating-/i.test(layer), gradW, gradH, gx, gy);
    else if (radial != null) def = buildRadialGradientDef(gradId, radial[1], /^repeating-/i.test(layer), gx, gy, gradW, gradH);
    if (def === "") return { contents, forceHide: false };
    contents.push(def);
    contents.push(`<rect x="${r(gx)}" y="${r(gy)}" width="${r(gradW)}" height="${r(gradH)}" fill="url(#${gradId})" />`);
    return { contents, forceHide: false };
  }
  // DM-494: `element(#id)` paint reference — emit the post-capture
  // rasterized <image> directly into the <mask>. Position + size honor
  // mask-position / mask-size on the consuming element; mask-size:auto
  // uses the referenced element's painted box dimensions (the spec's
  // "natural size" for element()).
  const elementMatch = /^element\(\s*#([^)\s]+)\s*\)$/i.exec(layer);
  if (elementMatch != null) {
    if (elementRasters == null) return { contents, forceHide: false };
    const refId = elementMatch[1];
    const raster = elementRasters.get(refId);
    if (raster == null || raster.dataUri == null) return { contents, forceHide: false };
    const intrinsic = { w: raster.width, h: raster.height };
    let imgW = intrinsic.w, imgH = intrinsic.h;
    const sizeTok = layerSize.trim().split(/\s+/);
    const resolveSize = (tok: string, basis: number, intrinsicDim: number): number => {
      if (tok == null || tok === "auto" || tok === "") return intrinsicDim;
      if (/%$/.test(tok)) return (parseFloat(tok) / 100) * basis;
      return parseFloat(tok) || intrinsicDim;
    };
    let par: "meet" | "slice" = "meet";
    if (layerSize === "contain") {
      const scale = Math.min(w / intrinsic.w, h / intrinsic.h);
      imgW = intrinsic.w * scale;
      imgH = intrinsic.h * scale;
      par = "meet";
    } else if (layerSize === "cover") {
      const scale = Math.max(w / intrinsic.w, h / intrinsic.h);
      imgW = intrinsic.w * scale;
      imgH = intrinsic.h * scale;
      par = "slice";
    } else {
      imgW = resolveSize(sizeTok[0], w, intrinsic.w);
      imgH = sizeTok.length > 1 ? resolveSize(sizeTok[1], h, intrinsic.h) : imgW * (intrinsic.h / intrinsic.w);
    }
    const posTok = layerPos.trim().split(/\s+/);
    const resolveH = (t: string): number => {
      if (t === "left") return 0;
      if (t === "right") return w - imgW;
      if (t === "center") return (w - imgW) / 2;
      if (/%$/.test(t)) return (parseFloat(t) / 100) * (w - imgW);
      return parseFloat(t) || 0;
    };
    const resolveV = (t: string): number => {
      if (t === "top") return 0;
      if (t === "bottom") return h - imgH;
      if (t === "center") return (h - imgH) / 2;
      if (/%$/.test(t)) return (parseFloat(t) / 100) * (h - imgH);
      return parseFloat(t) || 0;
    };
    const ix = elX + resolveH(posTok[0] ?? "0%");
    const iy = elY + resolveV(posTok[1] ?? posTok[0] ?? "0%");
    contents.push(`<image href="${raster.dataUri}" x="${r(ix)}" y="${r(iy)}" width="${r(imgW)}" height="${r(imgH)}" preserveAspectRatio="xMidYMid ${par}" />`);
    return { contents, forceHide: false };
  }
  // Use parseCssUrl (which handles quoted/unquoted and data: URIs with
  // embedded quotes) rather than a primitive `[^"')]+` regex that breaks on
  // data: URIs whose contents contain `"` or `)` — common in mask-image
  // values like `url("data:image/svg+xml,<svg display=\"block\" ...>...</svg>")`
  // (DM-638 framer chevrons).
  const urlHref = parseCssUrl(layer);
  if (urlHref != null) {
    // Chrome hides the element entirely for `mask-image: url(*.svg)` (the
    // remote SVG case — DM SK-859/SK-860). The likely cause is mask-mode:
    // match-source resolving to luminance for SVG sources and the common
    // icon SVG (transparent background + colored shape) computing near-zero
    // luminance, so the mask alpha is effectively zero. Reproducing that
    // ourselves would need embedding an <image> inside the mask with
    // mask-type sampling logic that matches Chrome's exact source-type
    // resolution, complex and variable across renderer versions. User
    // guidance on SK-859/SK-860: match Chrome by rendering nothing.
    // Contribute no mask content for this layer — the element gets hidden
    // wherever an SVG url() mask layer claims it, matching Chrome.
    //
    // EXCEPTION: data:image/svg+xml URIs containing a single icon path. The
    // framer marketing site renders chevrons / icons by setting
    // `background: white` + `mask-image: url("data:image/svg+xml,<svg><path
    // stroke=...></svg>")` on a small <div>. mask-mode: alpha is explicit,
    // so the path's painted stroke IS the mask. Falling through to the
    // generic image-mask branch produces the correct alpha. The remote-SVG
    // hide rule above doesn't fit the data:URI case — the data SVG is
    // small, self-contained, and authored as a mask.
    if (/\.svg(\?|#|$)/i.test(urlHref) && !/^data:image\/svg/i.test(urlHref)) { return { contents, forceHide: true }; }
    // For no-repeat mask images, emit the image DIRECTLY inside the mask —
    // not wrapped in a pattern + filled rect. The pattern+rect path paints
    // the rect opaque where the pattern is transparent, defeating alpha
    // masking. Direct <image> makes the sources alpha channel propagate
    // cleanly: opaque pixels = mask visible, transparent pixels = hidden.
    const isNoRepeat = /\bno-repeat\b/i.test(layerRepeat);
    if (isNoRepeat) {
      // Resolve mask-size + mask-position to a concrete image rect.
      let imgW = w, imgH = h;
      const sizeTok = layerSize.trim().split(/\s+/);
      const resolveSize = (tok: string, basis: number, intrinsicDim: number): number => {
        if (tok == null || tok === "auto" || tok === "") return intrinsicDim;
        if (/%$/.test(tok)) return (parseFloat(tok) / 100) * basis;
        return parseFloat(tok) || intrinsicDim;
      };
      if (layerSize === "contain" || layerSize === "cover") {
        // DM-1251: contain/cover scale the mask image (preserving its aspect)
        // to fit-inside / cover the element box. SVG's
        // `preserveAspectRatio="<align> meet|slice"` on an <image> sized to the
        // box does exactly that using the image's OWN intrinsic aspect — so no
        // captured intrinsic dims are needed (verified vs Chrome). mask-position
        // maps to the align keyword (left/top→Min, center→Mid, right/bottom→Max;
        // 0/50/100% positional) — computed below; intermediate %/px approximate
        // to the nearest Min/Mid/Max (preserveAspectRatio offers no finer grain).
        imgW = w; imgH = h;
      } else {
        imgW = resolveSize(sizeTok[0], w, w);
        imgH = sizeTok.length > 1 ? resolveSize(sizeTok[1], h, h) : imgW;
      }
      const posTok = layerPos.trim().split(/\s+/);
      const resolveH = (t: string): number => {
        if (t === "left") return 0;
        if (t === "right") return w - imgW;
        if (t === "center") return (w - imgW) / 2;
        if (/%$/.test(t)) return (parseFloat(t) / 100) * (w - imgW);
        return parseFloat(t) || 0;
      };
      const resolveV = (t: string): number => {
        if (t === "top") return 0;
        if (t === "bottom") return h - imgH;
        if (t === "center") return (h - imgH) / 2;
        if (/%$/.test(t)) return (parseFloat(t) / 100) * (h - imgH);
        return parseFloat(t) || 0;
      };
      const ix = elX + resolveH(posTok[0] ?? "0%");
      const iy = elY + resolveV(posTok[1] ?? posTok[0] ?? "0%");
      // For contain/cover, position is expressed via the preserveAspectRatio
      // align (the <image> fills the box and the fitted image aligns within it);
      // for an explicit size the image box is the resolved size at ix/iy.
      const par = (layerSize === "contain" || layerSize === "cover")
        ? `${maskContainAlign(posTok)} ${layerSize === "contain" ? "meet" : "slice"}`
        : "xMidYMid meet";
      contents.push(`<image href="${esc(embedResizedDataUri(urlHref, imgW, imgH))}" x="${r(ix)}" y="${r(iy)}" width="${r(imgW)}" height="${r(imgH)}" preserveAspectRatio="${par}" />`);
    } else {
      // Repeating mask: fall back to pattern. Since mask-type=alpha, the
      // pattern itself needs to be backed by an <image> that's clipped to
      // the tile size so outside-tile pixels are transparent.
      const patId = `${id}p${li}`;
      const patDef = buildImagePatternDef(patId, urlHref, elX, elY, w, h, layerSize, layerPos, layerRepeat, null);
      if (patDef === "") return { contents, forceHide: false };
      contents.push(patDef);
      contents.push(`<rect x="${r(elX)}" y="${r(elY)}" width="${r(w)}" height="${r(h)}" fill="url(#${patId})" />`);
    }
  }
  return { contents, forceHide: false };
}

export function buildMaskDef(
  id: string, maskImage: string,
  elX: number, elY: number, w: number, h: number,
  maskMode: string, sizeCss: string, posCss: string, repeatCss: string,
  compositeCss: string,
  /** DM-494: lookup table for `mask-image: element(#id)` references. Optional —
   *  callers without element() refs can omit it. The renderer's main caller
   *  threads through `elementMaskRasters` (collected from tree[0].maskRasters);
   *  unit tests can pass undefined to exercise the non-element() branches. */
  elementRasters?: ReadonlyMap<string, MaskRasterRef>,
): { id: string; def: string } {
  const layers = splitTopLevelCommas(maskImage);
  const sizeLayers = splitTopLevelCommas(sizeCss);
  const posLayers = splitTopLevelCommas(posCss);
  const repeatLayers = splitTopLevelCommas(repeatCss);
  const compositeLayers = splitTopLevelCommas(compositeCss);

  // Determine mask-type per CSS mask-mode.
  //   - alpha: explicit author opt-in to alpha-channel masking.
  //   - luminance: explicit author opt-in to RGB-luminance masking.
  //   - match-source (default): the source type drives the mode. Per CSS Masking:
  //     gradient + bitmap url() sources → alpha (the practical behavior we
  //     already emit), but element() paint references → luminance (the painted
  //     RGB drives mask alpha; this is what Chromium implements for `element()`
  //     under `match-source`). DM-494: when ANY layer in this mask is an
  //     element() ref AND the author hasn't picked a mode explicitly, switch
  //     to luminance for spec compliance.
  const hasElementLayer = layers.some((l) => /^element\(\s*#/i.test(l.trim()));
  let maskType: "alpha" | "luminance";
  if (maskMode === "luminance") maskType = "luminance";
  else if (maskMode === "alpha") maskType = "alpha";
  else maskType = hasElementLayer ? "luminance" : "alpha";

  // Per-layer contents. contents[li] = array of SVG strings (gradient defs
  // + painted rect/image) for layer li. We keep each layer separate so
  // mask-composite: intersect can emit one <mask> per layer and chain them
  // via the `mask` attribute on nested content (intersection). For plain
  // mask-composite: add (the default) we flatten all layers into a single
  // <mask> — SVG's native layer-stacking is additive.
  const layerContents: string[][] = [];
  for (let li = 0; li < layers.length; li++) layerContents.push([]);
  // Set when we encountered an SVG url() mask source that we deliberately
  // contribute no content for (SK-859/SK-860). An empty <mask> hides the
  // element entirely in SVG, matching Chrome's observed behavior for these
  // sources. Without this flag an all-empty layer list would skip mask
  // emission altogether and the element would show UNMASKED (opposite of
  // what we want), so force emission of an empty mask when it's set.
  let forceHide = false;
  for (let li = layers.length - 1; li >= 0; li--) {
    const result = buildMaskLayer({
      id, li, elX, elY, w, h,
      layer: layers[li].trim(),
      layerSize: (sizeLayers[li] ?? sizeLayers[0] ?? "auto").trim(),
      layerPos: (posLayers[li] ?? posLayers[0] ?? "0% 0%").trim(),
      layerRepeat: (repeatLayers[li] ?? repeatLayers[0] ?? "repeat").trim(),
      elementRasters,
    });
    layerContents[li] = result.contents;
    if (result.forceHide) forceHide = true;
  }
  // Drop empty layers (e.g. unsupported layer values) to simplify downstream.
  const nonEmpty = layerContents.filter((c) => c.length > 0);
  if (nonEmpty.length === 0) {
    if (forceHide) {
      // Empty <mask> hides the referenced element — matches Chrome's empty
      // rendering for SVG url() mask sources.
      return { id, def: `<mask id="${id}" maskUnits="userSpaceOnUse" mask-type="${maskType}"></mask>` };
    }
    return { id, def: "" };
  }

  // Resolve per-layer composite operator. CSS accepts one value applied to
  // all layers or a comma-separated list. Chromium's `mask-composite`
  // standard property maps to the same keyword names; the legacy
  // `-webkit-mask-composite` form uses source-over / source-in / source-
  // out / xor. We accept both by normalising via `normaliseComposite()`
  // because Chromium's getComputedStyle reports whichever longhand the
  // author last set, and the capture falls back to the webkit alias when
  // the standard property is empty (e.g. on older Chromium builds that
  // haven't shipped the unprefixed property).
  //
  // Only `intersect` and `subtract` / `exclude` need special handling —
  // `add` is the SVG default (layers stack additively in a single
  // <mask>). `intersect` chains nested masks; `subtract` / `exclude`
  // emit SVG filters with `feComposite` since neither is directly
  // expressible by stacking mask layers (DM-586).
  const normaliseComposite = (raw: string): string => {
    const t = raw.trim().toLowerCase();
    if (t === "source-over") return "add";
    if (t === "source-in") return "intersect";
    if (t === "source-out") return "subtract";
    if (t === "xor") return "exclude";
    return t;
  };
  const composite = normaliseComposite(compositeLayers[0] ?? "add");
  const isIntersect = composite === "intersect"
    && compositeLayers.every((c) => normaliseComposite(c) === "intersect");
  const isSubtract = composite === "subtract"
    && compositeLayers.every((c) => normaliseComposite(c) === "subtract");
  const isExclude = composite === "exclude"
    && compositeLayers.every((c) => normaliseComposite(c) === "exclude");

  // Helper: inject `mask="url(#X)"` into the last self-closing tag of a
  // layer's contents (the rect/image that PAINTS the mask source — earlier
  // entries are supporting defs like <pattern>/<linearGradient>). Returns
  // a new items array.
  const gateLastWithMask = (items: string[], maskId: string): string[] => {
    if (items.length === 0) return items;
    const cloned = items.slice();
    cloned[cloned.length - 1] = cloned[cloned.length - 1].replace(/\/>$/, ` mask="url(#${maskId})"/>`);
    return cloned;
  };

  // Filter that inverts alpha — used by subtract/exclude to build per-layer
  // "transparent where this layer is opaque" masks. The matrix maps alpha:
  // A' = -1 * A + 1, leaving RGB at 0. Inserted once into the defs block
  // when any subtract/exclude path needs it.
  const buildInvertAlphaFilter = (filterId: string): string =>
    `<filter id="${filterId}"><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1 1"/></filter>`;

  // For the default add case (single layer OR all-add), flatten every
  // layer's contents into one <mask>. SVG stacks them additively — alpha
  // accumulates where layers overlap.
  if (!isIntersect && !isSubtract && !isExclude) {
    const flat = nonEmpty.flat().join("");
    const def = `<mask id="${id}" maskUnits="userSpaceOnUse" mask-type="${maskType}">${flat}</mask>`;
    return { id, def };
  }
  if (nonEmpty.length === 1) {
    // Single-layer composite is just the layer itself regardless of op.
    const flat = nonEmpty[0].join("");
    const def = `<mask id="${id}" maskUnits="userSpaceOnUse" mask-type="${maskType}">${flat}</mask>`;
    return { id, def };
  }

  if (isIntersect) {
    // Intersect: chain N masks so each layer gates the next. Layer 0 is the
    // outer mask (the one the element references); each layer's painted rect
    // carries a mask="url(#inner)" attribute pointing at layer i+1, so its
    // pixels only show where layer i+1 is also opaque. Walk from the innermost
    // layer outward so we can reference already-built inner mask ids.
    const defs: string[] = [];
    let innerId: string | null = null;
    for (let li = nonEmpty.length - 1; li >= 0; li--) {
      const isOuter = li === 0;
      const layerMaskId = isOuter ? id : `${id}i${li}`;
      const items = innerId != null ? gateLastWithMask(nonEmpty[li], innerId) : nonEmpty[li];
      defs.push(`<mask id="${layerMaskId}" maskUnits="userSpaceOnUse" mask-type="${maskType}">${items.join("")}</mask>`);
      innerId = layerMaskId;
    }
    return { id, def: defs.join("") };
  }

  if (isSubtract) {
    // Subtract: result α = L0 * (1 - L1) * (1 - L2) * ... — each subsequent
    // layer erases from the cumulative result. Implement via per-layer
    // alpha-inverted inner masks chained together: layer i's paint is
    // gated by mask=url(#layer_{i+1}-inverted), which is gated by
    // mask=url(#layer_{i+2}-inverted), and so on. (Same chain structure
    // as intersect, except each inner mask wraps its paint in a
    // <g filter="url(#invertAlpha)"> so the inner mask's emitted alpha
    // is `1 - layer_alpha` rather than `layer_alpha`.)
    const defs: string[] = [];
    const invFilterId = `${id}inv`;
    defs.push(buildInvertAlphaFilter(invFilterId));
    let innerId: string | null = null;
    for (let li = nonEmpty.length - 1; li >= 1; li--) {
      const layerMaskId = `${id}s${li}`;
      const items = innerId != null ? gateLastWithMask(nonEmpty[li], innerId) : nonEmpty[li];
      // Wrap the paint inside a filter-applying <g> so the emitted alpha
      // is (1 - layer_alpha).
      defs.push(`<mask id="${layerMaskId}" maskUnits="userSpaceOnUse" mask-type="${maskType}"><g filter="url(#${invFilterId})">${items.join("")}</g></mask>`);
      innerId = layerMaskId;
    }
    // Outer mask: layer 0's paint, gated by the inverted-subsequent-layers chain.
    const outerItems = innerId != null ? gateLastWithMask(nonEmpty[0], innerId) : nonEmpty[0];
    defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" mask-type="${maskType}">${outerItems.join("")}</mask>`);
    return { id, def: defs.join("") };
  }

  // Exclude: a XOR b = a * (1 - b) + b * (1 - a). Generalises to N layers as
  // the symmetric difference, but CSS exclude is rarely authored with > 2
  // layers — we handle the common 2-layer case and fall back to add-style
  // for higher arity (paint stacks with the inverted chain applied to each
  // contribution). Build:
  //   - inv0 = invertAlpha(L0)
  //   - inv1 = invertAlpha(L1)
  //   - outer mask: L0-paint mask=url(#inv1), L1-paint mask=url(#inv0)
  // For 3+ layers: each layer's paint is gated by the cumulative inverse of
  // every OTHER layer (i.e. layer i paints where all layers j != i are
  // transparent). Less common but follows the same pattern.
  {
    const defs: string[] = [];
    const invFilterId = `${id}inv`;
    defs.push(buildInvertAlphaFilter(invFilterId));
    // Build one inverted mask per layer.
    const invMaskIds: string[] = [];
    for (let li = 0; li < nonEmpty.length; li++) {
      const invMaskId = `${id}x${li}`;
      defs.push(`<mask id="${invMaskId}" maskUnits="userSpaceOnUse" mask-type="${maskType}"><g filter="url(#${invFilterId})">${nonEmpty[li].join("")}</g></mask>`);
      invMaskIds.push(invMaskId);
    }
    // For N layers, chain the inverted masks of all other layers via
    // intersect-style mask= attribute nesting. For N = 2 this collapses to
    // a single mask= per layer.
    const outerContents: string[] = [];
    for (let li = 0; li < nonEmpty.length; li++) {
      // Build a chain mask of all other layers' inversions.
      let chainId: string | null = null;
      for (let lj = nonEmpty.length - 1; lj >= 0; lj--) {
        if (lj === li) continue;
        if (chainId == null) { chainId = invMaskIds[lj]; continue; }
        // Build a sub-mask that gates invMaskIds[lj]'s paint with chainId.
        const subMaskId = `${id}x${li}c${lj}`;
        // The inverted mask's paint is the filter-wrapped layer; gate it
        // with the existing chainId by injecting a mask= onto its painted
        // rect inside the filter wrapper. Easier: just inline another
        // <g mask=url(#chainId)> wrapping the filter <g>.
        defs.push(`<mask id="${subMaskId}" maskUnits="userSpaceOnUse" mask-type="${maskType}"><g mask="url(#${chainId})"><g filter="url(#${invFilterId})">${nonEmpty[lj].join("")}</g></g></mask>`);
        chainId = subMaskId;
      }
      const items = chainId != null ? gateLastWithMask(nonEmpty[li], chainId) : nonEmpty[li];
      outerContents.push(items.join(""));
    }
    defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" mask-type="${maskType}">${outerContents.join("")}</mask>`);
    return { id, def: defs.join("") };
  }
}

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
import { advancedGradientTile, needsChromiumGradientRaster } from "./advanced-gradient-raster.js";
import type { CapturedElement, MaskRasterRef } from "../capture/types.js";
import {
  resolveMaskContainCoverRect,
  resolveMaskPosition,
  type MaskImageRect,
  type MaskIntrinsicSize,
} from "./mask-position.js";
import {
  resolveMaskOriginClipLayer,
  resolveHtmlMaskReferenceBox,
  type MaskOriginClipContext,
  type MaskPhysicalEdges,
} from "./mask-origin-clip.js";

// Mask-position resolves in Blink's 1/64px LayoutUnit space. The renderer's
// general one-decimal formatter is intentionally compact, but throwing away
// that precision here can move a high-DPR mask edge by a device pixel.
const mr = (value: number): string => Number(value.toFixed(4)).toString();

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
 * Materialize Blink's objectBoundingBox URL-clip transform against an HTML
 * consumer's border box (DM-2362).
 *
 * Leaving `clipPathUnits="objectBoundingBox"` on the generated SVG wrapper is
 * not equivalent: SVG would derive the box from the wrapper's painted child
 * geometry, while Blink passes the HTML border box explicitly to
 * LayoutSVGResourceClipper::CalculateClipTransform.  Convert the normalized
 * coordinates to output user space once so transparent containers and
 * overflowing/offset children keep the source reference box.
 *
 * Blink starts with the clipPath element's transform and then appends the
 * reference-box translate/scale. SVG transform lists serialize that same
 * product as `existing translate(...) scale(...)`.
 */
export function positionObjectBoundingBoxClipPathDef(
  rewrittenOuterHTML: string,
  elX: number, elY: number, elW: number, elH: number,
): string {
  const openMatch = /^<clipPath\b([^>]*)>/i.exec(rewrittenOuterHTML);
  if (openMatch == null) return rewrittenOuterHTML;
  const boxTransform = `translate(${r(elX)}, ${r(elY)}) scale(${r(elW)}, ${r(elH)})`;
  let attrs = openMatch[1]
    .replace(/\sclipPathUnits\s*=\s*"[^"]*"/gi, "")
    .replace(/\sclipPathUnits\s*=\s*'[^']*'/gi, "");
  const existing = /\stransform\s*=\s*"([^"]*)"/i.exec(attrs) ?? /\stransform\s*=\s*'([^']*)'/i.exec(attrs);
  if (existing != null) {
    attrs = attrs.replace(existing[0], ` transform="${existing[1]} ${boxTransform}"`);
  } else {
    attrs += ` transform="${boxTransform}"`;
  }
  attrs += ` clipPathUnits="userSpaceOnUse"`;
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

/** Inputs for one mask-image layer — the per-layer slice of `buildMaskDef`'s
 *  args plus the already-resolved size/position/repeat for that layer index. */
interface MaskLayerInput {
  id: string;
  li: number;
  elX: number;
  elY: number;
  w: number;
  h: number;
  /** Painting/destination area. Size and position still use elX/Y/w/h. */
  paintX: number;
  paintY: number;
  paintW: number;
  paintH: number;
  /** The trimmed layer value (a gradient / `element(#id)` / `url(...)`). */
  layer: string;
  layerSize: string;
  layerPos: string;
  layerRepeat: string;
  elementRasters?: ReadonlyMap<string, MaskRasterRef>;
  intrinsic?: MaskIntrinsicSize | null;
}

function maskRepeatAxes(value: string): [string, string] {
  const tokens = value.trim().toLowerCase().split(/\s+/);
  if (tokens[0] === "repeat-x") return ["repeat", "no-repeat"];
  if (tokens[0] === "repeat-y") return ["no-repeat", "repeat"];
  return [tokens[0] || "repeat", tokens[1] ?? tokens[0] ?? "repeat"];
}

export interface MaskFragmentGeometry {
  fragments: ReadonlyArray<{ x: number; y: number; width: number; height: number }>;
  writingMode?: string;
  direction?: string;
  boxDecorationBreak?: string;
  fragmentAxis?: string;
}

interface MaskPaintArea extends MaskImageRect {
  clip?: MaskImageRect;
}

interface ResolvedMaskPaintArea {
  positioningArea: MaskImageRect;
  paintingArea: MaskImageRect;
  /** Finite CSS/fragment intersection; absent for mask-clip:no-clip. */
  clip?: MaskImageRect;
}

/**
 * Reconstruct InlineBoxFragmentPainter::PaintRectForImageStrip. A sliced
 * inline paints one continuous image strip, translated for each line and
 * clipped to that line's physical fragment. Clone/block fragments restart
 * their own positioning area. Physical x/y remain physical in every writing
 * mode; writing mode only selects the strip axis. DM-2379.
 */
export function maskPaintAreas(
  fallback: MaskImageRect,
  context?: MaskFragmentGeometry,
): MaskPaintArea[] {
  const fragments = context?.fragments ?? [];
  if (fragments.length <= 1) return [fallback];
  const clone = context?.boxDecorationBreak === "clone";
  const blockFragmented = context?.fragmentAxis === "block";
  if (clone || blockFragmented) {
    return fragments.map((fragment) => ({ ...fragment, clip: { ...fragment } }));
  }

  const vertical = /^(?:vertical|sideways)-/.test(context?.writingMode ?? "horizontal-tb");
  const rtl = context?.direction === "rtl";
  const total = fragments.reduce((sum, fragment) => sum + (vertical ? fragment.height : fragment.width), 0);
  let consumed = 0;
  return fragments.map((fragment) => {
    const extent = vertical ? fragment.height : fragment.width;
    const offset = rtl ? total - consumed - extent : consumed;
    consumed += extent;
    const area = vertical
      ? { x: fragment.x, y: fragment.y - offset, width: fragment.width, height: total }
      : { x: fragment.x - offset, y: fragment.y, width: total, height: fragment.height };
    return { ...area, clip: { ...fragment } };
  });
}

function fragmentPhysicalEdges(
  edges: MaskPhysicalEdges,
  index: number,
  count: number,
  context?: MaskFragmentGeometry,
): MaskPhysicalEdges {
  if (context?.boxDecorationBreak === "clone" || context?.fragmentAxis === "block") return edges;
  const vertical = /^(?:vertical|sideways)-/.test(context?.writingMode ?? "horizontal-tb");
  const rtl = context?.direction === "rtl";
  if (vertical) {
    const ownsTop = rtl ? index === count - 1 : index === 0;
    const ownsBottom = rtl ? index === 0 : index === count - 1;
    return { ...edges, top: ownsTop ? edges.top : 0, bottom: ownsBottom ? edges.bottom : 0 };
  }
  const ownsLeft = rtl ? index === count - 1 : index === 0;
  const ownsRight = rtl ? index === 0 : index === count - 1;
  return { ...edges, left: ownsLeft ? edges.left : 0, right: ownsRight ? edges.right : 0 };
}

/**
 * Thread Blink's independent positioning and painting rectangles through the
 * existing slice/clone strip reconstruction. The stitched strip owns origin
 * geometry; each physical fragment owns the final clip intersection.
 */
function resolvedMaskPaintAreas(
  fallback: MaskImageRect,
  layerIndex: number,
  fragmentGeometry?: MaskFragmentGeometry,
  originClip?: MaskOriginClipContext,
): ResolvedMaskPaintArea[] {
  const areas = maskPaintAreas(fallback, fragmentGeometry);
  if (originClip == null) {
    return areas.map((area) => ({
      positioningArea: area,
      paintingArea: area.clip ?? area,
      clip: area.clip,
    }));
  }
  return areas.map((area, areaIndex) => {
    const layer = resolveMaskOriginClipLayer(area, layerIndex, originClip);
    if (area.clip == null) {
      return {
        positioningArea: layer.positioningArea,
        paintingArea: layer.paintingArea ?? originClip.noClipPaintingArea ?? area,
        clip: layer.paintingArea ?? undefined,
      };
    }
    // Inline slice fragments omit the inline-start/end border and padding on
    // interior fragments. Contract only the physical sides that Blink's
    // fragment owns; clone/block fragments own all four sides.
    const border = fragmentPhysicalEdges(originClip.border, areaIndex, areas.length, fragmentGeometry);
    const padding = fragmentPhysicalEdges(originClip.padding, areaIndex, areas.length, fragmentGeometry);
    const fragmentClip = layer.clip === "no-clip"
      ? area.clip
      : resolveHtmlMaskReferenceBox(area.clip, layer.clip, border, padding);
    return {
      positioningArea: layer.positioningArea,
      paintingArea: fragmentClip,
      clip: fragmentClip,
    };
  });
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
  const {
    id, li, elX, elY, w, h, paintX, paintY, paintW, paintH,
    layer, layerSize, layerPos, layerRepeat, elementRasters, intrinsic: capturedIntrinsic,
  } = input;
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
    if (gradW <= 0 || gradH <= 0) return { contents, forceHide: false };
    const gradientOffset = resolveMaskPosition(layerPos, w - gradW, h - gradH);
    let gx = elX + gradientOffset.x;
    let gy = elY + gradientOffset.y;
    const linear = /^(?:repeating-)?linear-gradient\((.+)\)$/i.exec(layer);
    const radial = /^(?:repeating-)?radial-gradient\((.+)\)$/i.exec(layer);
    if (needsChromiumGradientRaster(layer)) {
      const raster = advancedGradientTile(layer, gradW, gradH);
      if (raster != null) {
        const patId = `${id}p${li}`;
        const patDef = buildImagePatternDef(patId, raster, elX, elY, w, h, layerSize, layerPos, layerRepeat, { w: gradW, h: gradH });
        contents.push(patDef, `<rect x="${r(paintX)}" y="${r(paintY)}" width="${r(paintW)}" height="${r(paintH)}" fill="url(#${patId})" />`);
        return { contents, forceHide: false };
      }
      console.warn(`[domotion] Chromium raster tile unavailable for advanced mask gradient; using best-effort SVG interpolation: ${layer}`);
    }
    let [repeatX, repeatY] = maskRepeatAxes(layerRepeat);
    const widthAuto = layerSize === "auto" || layerSize === "" || sizeTok[0] === "auto";
    const heightAuto = layerSize === "auto" || layerSize === "" || sizeTok.length < 2 || sizeTok[1] === "auto";
    if (repeatX === "round") {
      const oldW = gradW;
      gradW = w / Math.max(1, Math.round(w / gradW));
      if (heightAuto && repeatY !== "round") gradH *= gradW / oldW;
    }
    if (repeatY === "round") {
      const oldH = gradH;
      gradH = h / Math.max(1, Math.round(h / gradH));
      if (widthAuto && repeatX !== "round") gradW *= gradH / oldH;
    }
    const axis = (repeat: string, areaStart: number, areaSize: number, tileStart: number, tileSize: number): { starts: number[] } => {
      if (repeat === "no-repeat") return { starts: [tileStart] };
      if (repeat === "space") {
        const count = Math.floor(areaSize / tileSize);
        if (count <= 1) return { starts: [tileStart] };
        const gap = (areaSize - count * tileSize) / (count - 1);
        return { starts: Array.from({ length: count }, (_, index) => areaStart + index * (tileSize + gap)) };
      }
      const first = tileStart + Math.floor((areaStart - tileStart) / tileSize) * tileSize;
      const starts: number[] = [];
      for (let value = first; value < areaStart + areaSize; value += tileSize) starts.push(value);
      return { starts };
    };
    const xs = axis(repeatX, paintX, paintW, gx, gradW).starts;
    const ys = axis(repeatY, paintY, paintH, gy, gradH).starts;
    let tileIndex = 0;
    for (const tileY of ys) for (const tileX of xs) {
      const gradId = `${id}g${li}${xs.length * ys.length > 1 ? `t${tileIndex++}` : ""}`;
      const def = linear != null
        ? buildLinearGradientDef(gradId, linear[1], /^repeating-/i.test(layer), gradW, gradH, tileX, tileY)
        : radial != null ? buildRadialGradientDef(gradId, radial[1], /^repeating-/i.test(layer), tileX, tileY, gradW, gradH) : "";
      if (def === "") continue;
      contents.push(def, `<rect x="${r(tileX)}" y="${r(tileY)}" width="${r(gradW)}" height="${r(gradH)}" fill="url(#${gradId})" />`);
    }
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
    let fitted: MaskImageRect | null = null;
    if (layerSize === "contain" || layerSize === "cover") {
      fitted = resolveMaskContainCoverRect(
        { x: elX, y: elY, width: w, height: h }, intrinsic, layerSize, layerPos,
      );
      if (fitted == null) return { contents, forceHide: false };
      imgW = fitted.width; imgH = fitted.height;
    } else {
      imgW = resolveSize(sizeTok[0], w, intrinsic.w);
      imgH = sizeTok.length > 1 ? resolveSize(sizeTok[1], h, intrinsic.h) : imgW * (intrinsic.h / intrinsic.w);
    }
    const imageOffset = resolveMaskPosition(layerPos, w - imgW, h - imgH);
    const ix = fitted?.x ?? (elX + imageOffset.x);
    const iy = fitted?.y ?? (elY + imageOffset.y);
    contents.push(`<image href="${raster.dataUri}" x="${mr(ix)}" y="${mr(iy)}" width="${mr(imgW)}" height="${mr(imgH)}" preserveAspectRatio="none" />`);
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
    const [urlRepeatX, urlRepeatY] = maskRepeatAxes(layerRepeat);
    const isNoRepeat = urlRepeatX === "no-repeat" && urlRepeatY === "no-repeat";
    if (isNoRepeat) {
      // Resolve mask-size + mask-position to a concrete image rect.
      let imgW = w, imgH = h;
      const sizeTok = layerSize.trim().split(/\s+/);
      const resolveSize = (tok: string, basis: number, intrinsicDim: number): number => {
        if (tok == null || tok === "auto" || tok === "") return intrinsicDim;
        if (/%$/.test(tok)) return (parseFloat(tok) / 100) * basis;
        return parseFloat(tok) || intrinsicDim;
      };
      let fitted: MaskImageRect | null = null;
      if (layerSize === "contain" || layerSize === "cover") {
        fitted = capturedIntrinsic == null ? null : resolveMaskContainCoverRect(
          { x: elX, y: elY, width: w, height: h },
          capturedIntrinsic,
          layerSize,
          layerPos,
        );
        if (fitted == null) {
          console.warn(`[domotion] mask-size:${layerSize} requires captured mask intrinsic dimensions; omitting inexact layer`);
          // A CSS image mask layer whose source cannot supply natural sizing
          // contributes transparent black; do not turn a failed exactness
          // probe into an unmasked (fully visible) element.
          contents.push(`<rect x="${r(paintX)}" y="${r(paintY)}" width="${r(paintW)}" height="${r(paintH)}" fill="transparent" />`);
          return { contents, forceHide: false };
        }
        imgW = fitted.width; imgH = fitted.height;
      } else {
        imgW = resolveSize(sizeTok[0], w, w);
        imgH = sizeTok.length > 1 ? resolveSize(sizeTok[1], h, h) : imgW;
      }
      const imageOffset = resolveMaskPosition(layerPos, w - imgW, h - imgH);
      const ix = fitted?.x ?? (elX + imageOffset.x);
      const iy = fitted?.y ?? (elY + imageOffset.y);
      // SVG only samples the concrete Blink-owned tile rectangle; it must not
      // perform a second contain/cover alignment decision (DM-2379).
      contents.push(`<image href="${esc(embedResizedDataUri(urlHref, imgW, imgH))}" x="${mr(ix)}" y="${mr(iy)}" width="${mr(imgW)}" height="${mr(imgH)}" preserveAspectRatio="none" />`);
    } else {
      // Repeating mask: fall back to pattern. Since mask-type=alpha, the
      // pattern itself needs to be backed by an <image> that's clipped to
      // the tile size so outside-tile pixels are transparent.
      const patId = `${id}p${li}`;
      const patDef = buildImagePatternDef(
        patId,
        urlHref,
        elX,
        elY,
        w,
        h,
        layerSize,
        layerPos,
        layerRepeat,
        capturedIntrinsic ?? null,
        "scroll",
        null,
        null,
        { x: paintX, y: paintY, width: paintW, height: paintH },
      );
      if (patDef === "") return { contents, forceHide: false };
      contents.push(patDef);
      contents.push(`<rect x="${r(paintX)}" y="${r(paintY)}" width="${r(paintW)}" height="${r(paintH)}" fill="url(#${patId})" />`);
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
  /** Per-mask-image natural dimensions captured from Chromium. */
  maskIntrinsic?: ReadonlyArray<MaskIntrinsicSize | null>,
  /** Wrapped-inline / fragmented paint geometry (DM-2379). */
  fragmentGeometry?: MaskFragmentGeometry,
  /** Independent per-layer HTML mask-origin/mask-clip geometry (DM-2472). */
  originClip?: MaskOriginClipContext,
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

  const borderBox = { x: elX, y: elY, width: w, height: h };
  const hasNoClipLayer = originClip != null && layers.some((_, layerIndex) =>
    resolveMaskOriginClipLayer(borderBox, layerIndex, originClip).clip === "no-clip");
  const maskRegion = hasNoClipLayer
    ? originClip?.noClipPaintingArea ?? borderBox
    : borderBox;
  const explicitMaskRegion = hasNoClipLayer
    ? ` x="${r(maskRegion.x)}" y="${r(maskRegion.y)}" width="${r(maskRegion.width)}" height="${r(maskRegion.height)}"`
    : "";

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
  const cyclic = (values: string[], index: number, fallback: string): string => values.length > 0 ? values[index % values.length] : fallback;
  for (let li = layers.length - 1; li >= 0; li--) {
    const contents: string[] = [];
    const paintAreas = resolvedMaskPaintAreas(
      { x: elX, y: elY, width: w, height: h },
      li,
      fragmentGeometry,
      originClip,
    );
    for (let areaIndex = 0; areaIndex < paintAreas.length; areaIndex++) {
      const area = paintAreas[areaIndex];
      const fragmentSuffix = paintAreas.length > 1 ? `f${areaIndex}` : "";
      const positioning = area.positioningArea;
      const painting = area.paintingArea;
      const result = buildMaskLayer({
        id: `${id}${fragmentSuffix}`, li,
        elX: positioning.x, elY: positioning.y, w: positioning.width, h: positioning.height,
        paintX: painting.x, paintY: painting.y, paintW: painting.width, paintH: painting.height,
        layer: layers[li].trim(),
        layerSize: cyclic(sizeLayers, li, "auto").trim(),
        layerPos: cyclic(posLayers, li, "0% 0%").trim(),
        layerRepeat: cyclic(repeatLayers, li, "repeat").trim(),
        elementRasters,
        intrinsic: maskIntrinsic == null || maskIntrinsic.length === 0
          ? null
          : maskIntrinsic[li % maskIntrinsic.length],
      });
      if (area.clip == null) {
        contents.push(...result.contents);
      } else if (result.contents.length > 0) {
        const clipId = `${id}fc${li}-${areaIndex}`;
        contents.push(
          `<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse"><rect x="${r(area.clip.x)}" y="${r(area.clip.y)}" width="${r(area.clip.width)}" height="${r(area.clip.height)}" /></clipPath>`,
          `<g clip-path="url(#${clipId})">${result.contents.join("")}</g>`,
        );
      }
      if (result.forceHide) forceHide = true;
    }
    layerContents[li] = contents;
  }
  // Drop empty layers (e.g. unsupported layer values) to simplify downstream.
  const activeLayers = layerContents.map((contents, index) => ({ contents, index })).filter((layer) => layer.contents.length > 0);
  const nonEmpty = activeLayers.map((layer) => layer.contents);
  if (nonEmpty.length === 0) {
    if (forceHide) {
      // Empty <mask> hides the referenced element — matches Chrome's empty
      // rendering for SVG url() mask sources.
      return { id, def: `<mask id="${id}" maskUnits="userSpaceOnUse"${explicitMaskRegion} mask-type="${maskType}"></mask>` };
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
    const last = cloned[cloned.length - 1];
    cloned[cloned.length - 1] = /\/>$/.test(last)
      ? last.replace(/\/>$/, ` mask="url(#${maskId})"/>`)
      : `<g mask="url(#${maskId})">${last}</g>`;
    return cloned;
  };

  // Filter that inverts alpha — used by subtract/exclude to build per-layer
  // "transparent where this layer is opaque" masks. The matrix maps alpha:
  // A' = -1 * A + 1, leaving RGB at 0. Inserted once into the defs block
  // when any subtract/exclude path needs it.
  const buildInvertAlphaFilter = (filterId: string): string =>
    `<filter id="${filterId}"><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1 1"/></filter>`;

  // Blink paints from the bottom layer upward and applies each non-bottom
  // layer's own Porter-Duff operator to the accumulated destination. The old
  // uniform-operator shortcuts below are compact and exact for two layers;
  // arbitrary lists and 3+ layers need the actual sequential recurrence.
  const operatorAt = (layerIndex: number): string => normaliseComposite(cyclic(compositeLayers, layerIndex, "add"));
  const topOperators = activeLayers.slice(0, -1).map((layer) => operatorAt(layer.index));
  const needsSequentialComposition = activeLayers.length > 2 || new Set(topOperators).size > 1;
  if (needsSequentialComposition) {
    const defs: string[] = [];
    const fullRect = (maskId: string): string => `<rect x="${r(maskRegion.x)}" y="${r(maskRegion.y)}" width="${r(maskRegion.width)}" height="${r(maskRegion.height)}" fill="#fff" mask="url(#${maskId})" />`;
    const rawIds = new Map<number, string>();
    for (const layer of activeLayers) {
      const rawId = `${id}raw${layer.index}`;
      rawIds.set(layer.index, rawId);
      defs.push(`<mask id="${rawId}" maskUnits="userSpaceOnUse" x="${r(maskRegion.x)}" y="${r(maskRegion.y)}" width="${r(maskRegion.width)}" height="${r(maskRegion.height)}" mask-type="${maskType}">${layer.contents.join("")}</mask>`);
    }
    const invFilterId = `${id}inv`;
    defs.push(`<filter id="${invFilterId}" filterUnits="userSpaceOnUse" x="${r(maskRegion.x)}" y="${r(maskRegion.y)}" width="${r(maskRegion.width)}" height="${r(maskRegion.height)}"><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1 1"/></filter>`);
    const inverse = (sourceId: string, suffix: string): string => {
      const inverseId = `${id}not${suffix}`;
      defs.push(`<mask id="${inverseId}" maskUnits="userSpaceOnUse" x="${r(maskRegion.x)}" y="${r(maskRegion.y)}" width="${r(maskRegion.width)}" height="${r(maskRegion.height)}" mask-type="alpha"><g filter="url(#${invFilterId})"><rect x="${r(maskRegion.x)}" y="${r(maskRegion.y)}" width="${r(maskRegion.width)}" height="${r(maskRegion.height)}" fill="transparent" />${fullRect(sourceId)}</g></mask>`);
      return inverseId;
    };
    let accumulated = rawIds.get(activeLayers[activeLayers.length - 1].index)!;
    for (let position = activeLayers.length - 2; position >= 0; position--) {
      const layer = activeLayers[position];
      const source = rawIds.get(layer.index)!;
      const combined = `${id}acc${position}`;
      const op = operatorAt(layer.index);
      let body: string;
      if (op === "intersect") {
        body = `<g mask="url(#${source})">${fullRect(accumulated)}</g>`;
      } else if (op === "subtract") {
        body = `<g mask="url(#${inverse(accumulated, `a${position}`)})">${fullRect(source)}</g>`;
      } else if (op === "exclude") {
        const notAccumulated = inverse(accumulated, `a${position}`);
        const notSource = inverse(source, `s${position}`);
        body = `<g mask="url(#${notAccumulated})">${fullRect(source)}</g><g mask="url(#${notSource})">${fullRect(accumulated)}</g>`;
      } else {
        body = `${fullRect(accumulated)}${fullRect(source)}`;
      }
      defs.push(`<mask id="${combined}" maskUnits="userSpaceOnUse" x="${r(maskRegion.x)}" y="${r(maskRegion.y)}" width="${r(maskRegion.width)}" height="${r(maskRegion.height)}" mask-type="alpha">${body}</mask>`);
      accumulated = combined;
    }
    defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" x="${r(maskRegion.x)}" y="${r(maskRegion.y)}" width="${r(maskRegion.width)}" height="${r(maskRegion.height)}" mask-type="alpha">${fullRect(accumulated)}</mask>`);
    return { id, def: defs.join("") };
  }

  // For the default add case (single layer OR all-add), flatten every
  // layer's contents into one <mask>. SVG stacks them additively — alpha
  // accumulates where layers overlap.
  if (!isIntersect && !isSubtract && !isExclude) {
    const flat = nonEmpty.flat().join("");
    const def = `<mask id="${id}" maskUnits="userSpaceOnUse"${explicitMaskRegion} mask-type="${maskType}">${flat}</mask>`;
    return { id, def };
  }
  if (nonEmpty.length === 1) {
    // Single-layer composite is just the layer itself regardless of op.
    const flat = nonEmpty[0].join("");
    const def = `<mask id="${id}" maskUnits="userSpaceOnUse"${explicitMaskRegion} mask-type="${maskType}">${flat}</mask>`;
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
      defs.push(`<mask id="${layerMaskId}" maskUnits="userSpaceOnUse"${explicitMaskRegion} mask-type="${maskType}">${items.join("")}</mask>`);
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
      defs.push(`<mask id="${layerMaskId}" maskUnits="userSpaceOnUse"${explicitMaskRegion} mask-type="${maskType}"><g filter="url(#${invFilterId})">${items.join("")}</g></mask>`);
      innerId = layerMaskId;
    }
    // Outer mask: layer 0's paint, gated by the inverted-subsequent-layers chain.
    const outerItems = innerId != null ? gateLastWithMask(nonEmpty[0], innerId) : nonEmpty[0];
    defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse"${explicitMaskRegion} mask-type="${maskType}">${outerItems.join("")}</mask>`);
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
      defs.push(`<mask id="${invMaskId}" maskUnits="userSpaceOnUse"${explicitMaskRegion} mask-type="${maskType}"><g filter="url(#${invFilterId})">${nonEmpty[li].join("")}</g></mask>`);
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
        defs.push(`<mask id="${subMaskId}" maskUnits="userSpaceOnUse"${explicitMaskRegion} mask-type="${maskType}"><g mask="url(#${chainId})"><g filter="url(#${invFilterId})">${nonEmpty[lj].join("")}</g></g></mask>`);
        chainId = subMaskId;
      }
      const items = chainId != null ? gateLastWithMask(nonEmpty[li], chainId) : nonEmpty[li];
      outerContents.push(items.join(""));
    }
    defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse"${explicitMaskRegion} mask-type="${maskType}">${outerContents.join("")}</mask>`);
    return { id, def: defs.join("") };
  }
}

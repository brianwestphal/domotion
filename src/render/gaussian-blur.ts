import { r } from "./format.js";
import {
  legacyMaskBlitAlphaTable,
  planGaussBorder,
  shadowMaskBlurStdDeviation,
  skiaBoxBlurWindow,
} from "./shadow-blur-authority.js";

/** Blink ShadowData::BlurRadiusToStdDev in
 * third_party/blink/renderer/core/style/shadow_data.h:76. */
export function blurRadiusToStdDev(radius: number): number {
  return radius / 2;
}

export function emitGaussianBlurFilter(
  id: string,
  blurRadius: number,
  options: {
    region?: { x: number; y: number; width: number; height: number };
    sourceAlphaColor?: string;
  } = {},
): string {
  const region = options.region;
  const attrs =
    region == null
      ? ' x="-50%" y="-50%" width="200%" height="200%"'
      : ` filterUnits="userSpaceOnUse" x="${r(region.x)}" y="${r(region.y)}" width="${r(region.width)}" height="${r(region.height)}"`;
  const stdDev = r(blurRadiusToStdDev(blurRadius));
  const contents =
    options.sourceAlphaColor == null
      ? `<feGaussianBlur stdDeviation="${stdDev}"/>`
      : `<feGaussianBlur in="SourceAlpha" stdDeviation="${stdDev}" result="blur"/><feFlood flood-color="${options.sourceAlphaColor}" result="color"/><feComposite in="color" in2="blur" operator="in"/>`;
  return `<filter id="${id}"${attrs}>${contents}</filter>`;
}

type FilterRegion = { x: number; y: number; width: number; height: number };

function shadowFilterOpen(id: string, region: FilterRegion): string {
  return `<filter id="${id}" filterUnits="userSpaceOnUse" x="${r(region.x)}" y="${r(region.y)}" width="${r(region.width)}" height="${r(region.height)}" color-interpolation-filters="sRGB">`;
}

function shadowCoverageBlur(blurRadius: number): string {
  return `<feGaussianBlur in="SourceAlpha" stdDeviation="${shadowMaskBlurStdDeviation(blurRadius)}"/>`;
}

/**
 * The legacy ARGB32 blitter's color step as a component transfer: for mask
 * coverage `aa` it writes alpha `(ca·(aa+1)) >> 8` and the color's
 * unpremultiplied channels. Blink's discrete transfer truncates `255·value`
 * (fe_component_transfer.cc:65-77, Chromium 7d859f27), so each entry is the
 * target byte plus one half.
 */
function shadowMaskBlit(color: { r: number; g: number; b: number; a: number }): string {
  const alphaByte = Math.round(Math.min(1, Math.max(0, color.a)) * 255);
  const byte = (value: number) => ((value + 0.5) / 255).toFixed(4);
  const channel = (name: string, value: number) =>
    `<feFunc${name} type="linear" slope="0" intercept="${byte(value)}"/>`;
  const alpha =
    alphaByte === 255
      ? ""
      : `<feFuncA type="discrete" tableValues="${legacyMaskBlitAlphaTable(alphaByte).map(byte).join(" ")}"/>`;
  return `<feComponentTransfer>${channel("R", color.r)}${channel("G", color.g)}${channel("B", color.b)}${alpha}</feComponentTransfer>`;
}

/**
 * A normal box-shadow's mask-filter blit (see `shadow-blur-authority.ts`): the
 * shape's alpha is blurred, then `shadowMaskBlit` colors it. sRGB
 * interpolation keeps the transfer away from a linearRGB round trip.
 */
export function emitShadowMaskBlurFilter(
  id: string,
  blurRadius: number,
  color: { r: number; g: number; b: number; a: number },
  region: FilterRegion,
): string {
  return `${shadowFilterOpen(id, region)}${shadowCoverageBlur(blurRadius)}${shadowMaskBlit(color)}</filter>`;
}

/**
 * The same blit split in two, for a shadow under an antialiased clip-out:
 * `SkAAClipBlitter::blitMask` merges the clip's coverage into the blurred
 * mask (`SkMulDiv255Round`, SkAAClip.cpp:1806, Skia 62efacd3) before the color
 * blit. The caller applies its knockout mask between the coverage blur (on
 * the shape) and the color blit (on a group around the masked shape).
 */
export function emitShadowMaskBlurStages(
  ids: { blur: string; blit: string },
  blurRadius: number,
  color: { r: number; g: number; b: number; a: number },
  region: FilterRegion,
): string {
  return (
    `${shadowFilterOpen(ids.blur, region)}${shadowCoverageBlur(blurRadius)}</filter>` +
    `${shadowFilterOpen(ids.blit, region)}${shadowMaskBlit(color)}</filter>`
  );
}

/**
 * The filter region of a blurred normal shadow whose shape spans
 * (x, y, width, height). A three-box blur reaches exactly its border past the
 * shape's first pixel (`PlanGauss::border`, SkMaskBlurFilter.cpp:79, Skia
 * 62efacd3), the extent of Skia's blurred A8 mask, so the region starts there.
 * Its far edge reaches the image filter's kernel bounds, `ceil(3σ)`
 * (`SkBlurImageFilter`), plus a pixel. The earlier default region, 50% of the
 * shape on each side, clipped every blur of 8px and more on a 20px box.
 */
export function shadowMaskBlurRegion(
  x: number,
  y: number,
  width: number,
  height: number,
  blurRadius: number,
): FilterRegion {
  const sigma = shadowMaskBlurStdDeviation(blurRadius);
  const kernel = Math.ceil(3 * sigma);
  const border = sigma >= 2 ? planGaussBorder(skiaBoxBlurWindow(sigma)) : kernel;
  const left = Math.floor(x) - border;
  const top = Math.floor(y) - border;
  return {
    x: left,
    y: top,
    width: Math.ceil(x + width) + kernel + 1 - left,
    height: Math.ceil(y + height) + kernel + 1 - top,
  };
}

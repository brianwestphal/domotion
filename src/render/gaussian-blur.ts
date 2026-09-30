import { r } from "./format.js";

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

/**
 * Device-chrome wrapper (DM-1206).
 *
 * Wraps a finished capture SVG in a hand-drawn device bezel — a phone body, a
 * browser window, etc. — and returns the framed SVG plus its new outer
 * dimensions. The capture is NESTED as a child `<svg>` (not re-rendered), so the
 * glyph paths are byte-identical to the bare capture; re-rendering the element
 * tree through a second path-render would drop the host system font to `.notdef`
 * tofu (learned building the phone-framed demo, DM-217).
 *
 * The bezel is pure SVG primitives (rects, no text), so it is cross-platform —
 * nothing here depends on a system font or `process.platform`.
 *
 * The same geometry previously lived inline in
 * `site/scripts/demos/phone-screen/build-phone-screen.ts` and
 * `site/scripts/build-install-demo.ts`; this is the shared renderer they (and
 * the `domotion capture --chrome` flag) crib from.
 */

/** Devices the `--chrome` flag understands. */
export const DEVICE_CHROMES = ["phone"] as const;
export type DeviceChrome = (typeof DEVICE_CHROMES)[number];

export function isDeviceChrome(value: string): value is DeviceChrome {
  return (DEVICE_CHROMES as readonly string[]).includes(value);
}

export interface FramedSvg {
  /** The complete framed `<svg>` document. */
  svg: string;
  /** Outer dimensions (screen + bezel rim). */
  width: number;
  height: number;
}

/**
 * Strip the outer `<svg …>…</svg>` wrapper off a complete SVG document, leaving
 * the body markup so it can be re-nested at an offset. Tolerates a leading XML
 * declaration / doctype.
 */
function innerOf(svgDocument: string): string {
  return svgDocument
    .replace(/^\s*<\?xml[^>]*\?>\s*/i, "")
    .replace(/^\s*<!doctype[^>]*>\s*/i, "")
    .replace(/^[\s\S]*?<svg[^>]*>/i, "")
    .replace(/<\/svg>\s*$/i, "");
}

/**
 * Wrap a capture SVG in the named device chrome.
 *
 * @param captureSvg  a complete `<svg>` document (what `wrapSvg` / the renderer produces)
 * @param device      which bezel to draw
 * @param screenW     the capture's width  (the inner screen size)
 * @param screenH     the capture's height
 */
export function wrapInDeviceChrome(
  captureSvg: string,
  device: DeviceChrome,
  screenW: number,
  screenH: number,
): FramedSvg {
  const inner = innerOf(captureSvg);
  switch (device) {
    case "phone":
      return phoneBezel(inner, screenW, screenH);
    default: {
      // Exhaustiveness guard — unreachable while DEVICE_CHROMES is the only source.
      const _never: never = device;
      throw new Error(`device-chrome: unsupported device "${String(_never)}"`);
    }
  }
}

/**
 * iPhone-class bezel: rounded titanium body, dynamic-island notch, home
 * indicator. The screen content fills `screenW × screenH`; the body adds an
 * even rim on every side, so the output grows by `2 × RIM` in each axis (e.g. a
 * 390 × 844 capture → 418 × 872 framed).
 */
function phoneBezel(inner: string, screenW: number, screenH: number): FramedSvg {
  const RIM = 14;
  const RADIUS = 56;
  const outerW = screenW + RIM * 2;
  const outerH = screenH + RIM * 2;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outerW}" height="${outerH}" viewBox="0 0 ${outerW} ${outerH}">` +
    `<defs><clipPath id="phone-screen-clip"><rect x="${RIM}" y="${RIM}" width="${screenW}" height="${screenH}" rx="${RADIUS - RIM}"/></clipPath></defs>` +
    // Outer body + inner rim highlight.
    `<rect width="${outerW}" height="${outerH}" rx="${RADIUS}" fill="#1c1c1e"/>` +
    `<rect x="3" y="3" width="${outerW - 6}" height="${outerH - 6}" rx="${RADIUS - 3}" fill="none" stroke="#3a3a3c" stroke-width="1.5"/>` +
    // Screen backdrop (so any letterboxing reads as black, not transparent).
    `<rect x="${RIM}" y="${RIM}" width="${screenW}" height="${screenH}" rx="${RADIUS - RIM}" fill="#0d1117"/>` +
    // Nested capture, clipped to the rounded screen.
    `<g clip-path="url(#phone-screen-clip)"><svg x="${RIM}" y="${RIM}" width="${screenW}" height="${screenH}" viewBox="0 0 ${screenW} ${screenH}">${inner}</svg></g>` +
    // Dynamic-island notch.
    `<rect x="${outerW / 2 - 56}" y="${RIM + 9}" width="112" height="30" rx="15" fill="#000"/>` +
    // Home indicator.
    `<rect x="${outerW / 2 - 65}" y="${outerH - RIM - 12}" width="130" height="5" rx="2.5" fill="#e6edf3" opacity="0.85"/>` +
    `</svg>`;

  return { svg, width: outerW, height: outerH };
}

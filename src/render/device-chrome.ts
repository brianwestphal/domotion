/**
 * Device-chrome wrapper (DM-1206, DM-1211).
 *
 * Wraps a finished capture SVG in a hand-drawn device bezel — a phone body, a
 * browser window, a plain app window — and returns the framed SVG plus its new
 * outer dimensions. The capture is NESTED as a child `<svg>` (not re-rendered),
 * so the glyph paths are byte-identical to the bare capture; re-rendering the
 * element tree through a second path-render would drop the host system font to
 * `.notdef` tofu (learned building the phone-framed demo, DM-217).
 *
 * The bezel is pure SVG primitives — rects, paths, and (for the browser/window
 * label only) a single `<text>` rendered with a generic font stack. The label
 * is decoration painted live by the SVG viewer, not captured content, so a
 * little cross-viewer font variance on a URL/title string is acceptable; the
 * rest carries no font dependency, so the bezel renders consistently on macOS /
 * Linux / Windows.
 *
 * The phone geometry previously lived inline in
 * `site/scripts/demos/phone-screen/build-phone-screen.ts` and
 * `site/scripts/build-install-demo.ts`; this is the shared renderer they (and
 * the `domotion capture --chrome` flag) crib from.
 */

/** Devices the `--chrome` flag understands. */
export const DEVICE_CHROMES = ["phone", "browser", "window"] as const;
export type DeviceChrome = (typeof DEVICE_CHROMES)[number];

export function isDeviceChrome(value: string): value is DeviceChrome {
  return (DEVICE_CHROMES as readonly string[]).includes(value);
}

export interface DeviceChromeOptions {
  /**
   * Text shown in the chrome bar — the address in the `browser` URL bar, or the
   * centered title for `window`. Ignored by `phone`. Omitted → an empty URL
   * pill / blank title bar.
   */
  label?: string;
}

export interface FramedSvg {
  /** The complete framed `<svg>` document. */
  svg: string;
  /** Outer dimensions (screen + bezel rim). */
  width: number;
  height: number;
}

/** Generic monospace stack for the browser URL; sans for the window title. */
const MONO = "ui-monospace, 'SF Mono', Menlo, monospace";
const SANS = "-apple-system, system-ui, 'Segoe UI', sans-serif";

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
 * @param opts        per-device options (e.g. the browser/window `label`)
 */
export function wrapInDeviceChrome(
  captureSvg: string,
  device: DeviceChrome,
  screenW: number,
  screenH: number,
  opts: DeviceChromeOptions = {},
): FramedSvg {
  const inner = innerOf(captureSvg);
  switch (device) {
    case "phone":
      return phoneBezel(inner, screenW, screenH);
    case "browser":
      return windowFrame(inner, screenW, screenH, "browser", opts.label);
    case "window":
      return windowFrame(inner, screenW, screenH, "window", opts.label);
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

/** Three macOS traffic-light buttons, left-aligned, centered on the bar. */
function trafficLights(barHeight: number): string {
  const cy = barHeight / 2;
  const r = 6;
  return (
    `<circle cx="18" cy="${cy}" r="${r}" fill="#ff5f56"/>` +
    `<circle cx="38" cy="${cy}" r="${r}" fill="#ffbd2e"/>` +
    `<circle cx="58" cy="${cy}" r="${r}" fill="#27c93f"/>`
  );
}

/** A tiny padlock glyph (body rect + arc shackle), centered vertically on `cy`. */
function lockGlyph(x: number, cy: number): string {
  return (
    `<rect x="${x}" y="${cy - 1}" width="9" height="7" rx="1.5" fill="#7d8590"/>` +
    `<path d="M${x + 2} ${cy - 1} V${cy - 3.5} a2.5 2.5 0 0 1 5 0 V${cy - 1}" fill="none" stroke="#7d8590" stroke-width="1.2"/>`
  );
}

/**
 * macOS-style window chrome shared by `browser` and `window`. A top chrome bar
 * (traffic lights + a URL pill for `browser`, or a centered title for `window`)
 * over the nested capture; the whole thing is a rounded-corner window with the
 * content's bottom corners clipped to the radius. Grows only in height (by the
 * bar) — the screen spans the full width.
 *
 * 390 × 600 capture → 390 × 644 (browser, 44px bar) or 390 × 636 (window, 36px).
 */
function windowFrame(
  inner: string,
  screenW: number,
  screenH: number,
  kind: "browser" | "window",
  label: string | undefined,
): FramedSvg {
  const BAR = kind === "browser" ? 44 : 36;
  const RADIUS = 11;
  const outerW = screenW;
  const outerH = screenH + BAR;
  const clipId = `chrome-screen-clip`;

  // Content area: square top corners (they butt the bar), rounded bottom corners.
  const contentClip =
    `M0 ${BAR} H${outerW} V${outerH - RADIUS} ` +
    `a${RADIUS} ${RADIUS} 0 0 1 -${RADIUS} ${RADIUS} H${RADIUS} ` +
    `a${RADIUS} ${RADIUS} 0 0 1 -${RADIUS} -${RADIUS} Z`;

  let barContent = trafficLights(BAR);
  if (kind === "browser") {
    // URL pill spanning from after the lights to the right edge, with a lock +
    // optional address.
    const pillX = 80;
    const pillW = outerW - pillX - 16;
    const cy = BAR / 2;
    barContent +=
      `<rect x="${pillX}" y="${cy - 11}" width="${pillW}" height="22" rx="11" fill="#1c1c1e"/>` +
      lockGlyph(pillX + 12, cy);
    if (label != null && label !== "") {
      barContent +=
        `<text x="${pillX + 28}" y="${cy + 4}" font-family="${MONO}" font-size="12" fill="#8b949e">${escapeXml(label)}</text>`;
    }
  } else if (label != null && label !== "") {
    // Centered window title.
    barContent +=
      `<text x="${outerW / 2}" y="${BAR / 2 + 4}" text-anchor="middle" font-family="${SANS}" font-size="13" font-weight="600" fill="#8b949e">${escapeXml(label)}</text>`;
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outerW}" height="${outerH}" viewBox="0 0 ${outerW} ${outerH}">` +
    `<defs><clipPath id="${clipId}"><path d="${contentClip}"/></clipPath></defs>` +
    // Window body (the chrome-bar color; the content covers the rest).
    `<rect width="${outerW}" height="${outerH}" rx="${RADIUS}" fill="#2b2b2e"/>` +
    // Screen backdrop so any letterboxing reads as black.
    `<g clip-path="url(#${clipId})"><rect x="0" y="${BAR}" width="${screenW}" height="${screenH}" fill="#0d1117"/>` +
    // Nested capture, clipped to the bottom-rounded content area.
    `<svg x="0" y="${BAR}" width="${screenW}" height="${screenH}" viewBox="0 0 ${screenW} ${screenH}">${inner}</svg></g>` +
    // Chrome-bar furniture + a hairline under the bar and around the window.
    barContent +
    `<line x1="0" y1="${BAR}" x2="${outerW}" y2="${BAR}" stroke="#000" stroke-width="1" opacity="0.4"/>` +
    `<rect x="0.5" y="0.5" width="${outerW - 1}" height="${outerH - 1}" rx="${RADIUS}" fill="none" stroke="#3a3a3c" stroke-width="1"/>` +
    `</svg>`;

  return { svg, width: outerW, height: outerH };
}

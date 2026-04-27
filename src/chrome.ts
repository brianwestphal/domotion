/**
 * Device chrome wrappers — render terminal / browser / phone bezels
 * around captured SVG content.
 *
 * The chrome adds margin and decorative elements at known fixed offsets,
 * then translates the captured content into the inner area. The total
 * rendered SVG grows by the chrome's outer dimensions.
 *
 * Each renderer returns:
 *   - `outerWidth` / `outerHeight` — the resulting SVG's full size.
 *   - `contentX` / `contentY` — where the captured content should be drawn.
 *   - `defs` — extra `<defs>` content to embed in the wrapper SVG.
 *   - `before` / `after` — markup to wrap the translated captured content.
 *
 * The composer (`generateAnimatedSvg` / `wrapWithChrome`) is responsible for
 * stitching these into the final SVG.
 */

export type DeviceChromeKind = "terminal" | "browser" | "phone";

export interface DeviceChromeConfig {
  type: DeviceChromeKind;
  /** For browser chrome: the URL to display in the address bar. */
  url?: string;
  /** For terminal/browser chrome: the title text in the title bar / tab. */
  title?: string;
}

export interface ChromeFrame {
  outerWidth: number;
  outerHeight: number;
  contentX: number;
  contentY: number;
  defs: string;
  before: string;
  after: string;
}

export function buildChrome(config: DeviceChromeConfig, contentWidth: number, contentHeight: number): ChromeFrame {
  if (config.type === "terminal") return terminalChrome(contentWidth, contentHeight, config.title ?? "Terminal");
  if (config.type === "browser") return browserChrome(contentWidth, contentHeight, config.url ?? "https://example.com", config.title ?? "");
  if (config.type === "phone")   return phoneChrome(contentWidth, contentHeight);
  throw new Error(`buildChrome: unknown chrome type "${(config as DeviceChromeConfig).type}"`);
}

/**
 * Wrap a complete `<svg>...</svg>` document in device chrome. The chrome
 * is rendered as outer SVG markup and the captured content is embedded
 * via a translated `<g>`.
 *
 * `inner` should be the SVG fragment (`defs + groups`) returned by
 * `elementTreeToSvg` (NOT a wrapped `<svg>` document) so it can be embedded
 * directly into the chrome's translation group.
 */
export function wrapWithChrome(
  inner: string,
  contentWidth: number,
  contentHeight: number,
  chrome: DeviceChromeConfig,
): string {
  const f = buildChrome(chrome, contentWidth, contentHeight);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f.outerWidth} ${f.outerHeight}" width="${f.outerWidth}" height="${f.outerHeight}">`
    + (f.defs !== "" ? `<defs>${f.defs}</defs>` : "")
    + f.before
    + `<g transform="translate(${f.contentX}, ${f.contentY})">${inner}</g>`
    + f.after
    + `</svg>`;
}

function terminalChrome(width: number, height: number, title: string): ChromeFrame {
  const padding = 16;
  const titleBarHeight = 36;
  const outerWidth = width + padding * 2;
  const outerHeight = height + titleBarHeight + padding;
  const contentX = padding;
  const contentY = titleBarHeight;

  const before = `<rect width="${outerWidth}" height="${outerHeight}" rx="10" fill="#1e1e2e" />`
    + `<rect width="${outerWidth}" height="${titleBarHeight}" rx="10" fill="#2b2b3d" />`
    + `<rect y="${titleBarHeight - 4}" width="${outerWidth}" height="4" fill="#2b2b3d" />`
    + `<circle cx="20" cy="${titleBarHeight / 2}" r="6" fill="#ff5f57" />`
    + `<circle cx="40" cy="${titleBarHeight / 2}" r="6" fill="#febc2e" />`
    + `<circle cx="60" cy="${titleBarHeight / 2}" r="6" fill="#28c840" />`
    + `<text x="${outerWidth / 2}" y="${titleBarHeight / 2 + 4}" text-anchor="middle" font-family="-apple-system, sans-serif" font-size="12" fill="#8b8fa3">${escapeXml(title)}</text>`;

  return { outerWidth, outerHeight, contentX, contentY, defs: "", before, after: "" };
}

function browserChrome(width: number, height: number, url: string, title: string): ChromeFrame {
  const titleBarHeight = 40;
  const addressBarHeight = 32;
  const chromeHeight = titleBarHeight + addressBarHeight;
  const outerWidth = width;
  const outerHeight = height + chromeHeight;
  const contentX = 0;
  const contentY = chromeHeight;
  const tabLabel = title === "" ? hostFrom(url) : title;

  const before = `<rect width="${outerWidth}" height="${outerHeight}" rx="10" fill="#161b22" />`
    + `<rect width="${outerWidth}" height="${chromeHeight}" rx="10" fill="#21262d" />`
    + `<rect y="${chromeHeight - 4}" width="${outerWidth}" height="4" fill="#21262d" />`
    + `<circle cx="20" cy="20" r="6" fill="#ff5f57" />`
    + `<circle cx="40" cy="20" r="6" fill="#febc2e" />`
    + `<circle cx="60" cy="20" r="6" fill="#28c840" />`
    + `<rect x="80" y="8" width="180" height="24" rx="6" fill="#161b22" />`
    + `<text x="92" y="24" font-family="-apple-system, sans-serif" font-size="11" fill="#e6edf3">${escapeXml(tabLabel)}</text>`
    + `<rect x="12" y="${titleBarHeight + 4}" width="${outerWidth - 24}" height="24" rx="6" fill="#0d1117" />`
    + `<text x="24" y="${titleBarHeight + 20}" font-family="-apple-system, sans-serif" font-size="11" fill="#8b949e">${escapeXml(url)}</text>`;

  return { outerWidth, outerHeight, contentX, contentY, defs: "", before, after: "" };
}

function phoneChrome(width: number, height: number): ChromeFrame {
  const framePadding = 12;
  const statusBarHeight = 44;
  const homeIndicatorHeight = 34;
  const outerWidth = width + framePadding * 2;
  const outerHeight = height + statusBarHeight + homeIndicatorHeight + framePadding * 2;
  const contentX = framePadding;
  const contentY = framePadding + statusBarHeight;

  const before = `<rect width="${outerWidth}" height="${outerHeight}" rx="40" fill="#1a1a1a" />`
    + `<rect x="${framePadding}" y="${framePadding}" width="${width}" height="${outerHeight - framePadding * 2}" rx="4" fill="#0d1117" />`
    + `<rect x="${outerWidth / 2 - 60}" y="${framePadding}" width="120" height="28" rx="12" fill="#1a1a1a" />`
    + `<text x="${framePadding + 16}" y="${framePadding + 28}" font-family="-apple-system, sans-serif" font-size="12" font-weight="600" fill="#e6edf3">9:41</text>`
    + `<rect x="${outerWidth / 2 - 67}" y="${outerHeight - framePadding - 20}" width="134" height="5" rx="2.5" fill="#e6edf3" opacity="0.3" />`;

  return { outerWidth, outerHeight, contentX, contentY, defs: "", before, after: "" };
}

function hostFrom(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

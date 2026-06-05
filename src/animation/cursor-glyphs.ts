/**
 * Cursor glyph catalog (DM-1106).
 *
 * Maps every CSS `cursor` keyword to a small SVG glyph drawn from Lucide icons
 * (MIT-licensed, https://lucide.dev) — scaled, rotated, and occasionally
 * composited (an arrow + a badge, the way real OS drag-drop cursors look) to
 * approximate what a browser paints. Lucide's line-art look is intentionally
 * OS-agnostic: it doesn't pixel-match macOS / Windows / X11, but it reads as the
 * right cursor at a glance and renders crisply at any scale (the whole point of
 * the SVG pipeline).
 *
 * Each glyph is authored in Lucide's native 24×24 coordinate box. The renderer
 * paints a white halo under a dark stroke so the cursor stays legible on any
 * background (mirroring the white-outlined arrow the overlay already used). The
 * `hotspot` is the point IN THAT 24×24 BOX that aligns to the cursor's (x, y) —
 * e.g. the arrow tip, the I-beam center — so callers translate the glyph by
 * `(x − hotspotX·scale, y − hotspotY·scale)`.
 *
 * This module is pure markup generation (no DOM); the overlay (DM-1106 phase 2)
 * picks a glyph per captured `cursor` value and animates its position.
 */

/** A glyph authored in the Lucide 24×24 box. */
export interface CursorGlyph {
  /** Inner SVG markup (paths/lines/circles) in the 24×24 Lucide coordinate box. */
  body: string;
  /** Filled silhouette (white fill + dark outline, like a classic arrow) vs.
   *  stroked line-art (dark stroke + white halo, the Lucide default look). */
  fill?: boolean;
  /** The point in the 24×24 box that lands on the cursor coordinate. */
  hotspot: [number, number];
  /** Optional rotation (degrees, about the box center 12,12) — e.g. vertical-text. */
  rotate?: number;
}

// ── Lucide icon bodies (verbatim path data from lucide-icons/lucide) ──────────
const L = {
  arrow: `<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/>`,
  pointer: `<path d="M22 14a8 8 0 0 1-8 8"/><path d="M18 11v-1a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v1"/><path d="M10 9.5V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v10"/><path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>`,
  ibeam: `<path d="M17 22h-1a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4h1"/><path d="M7 22h1a4 4 0 0 0 4-4"/><path d="M7 2h1a4 4 0 0 1 4 4"/>`,
  menu: `<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/>`,
  spinner: `<path d="M21 12a9 9 0 1 1-6.219-8.56"/>`,
  plus: `<path d="M5 12h14"/><path d="M12 5v14"/>`,
  shortcut: `<path d="m15 14 5-5-5-5"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/>`,
  ban: `<circle cx="12" cy="12" r="10"/><path d="M4.929 4.929 19.07 19.071"/>`,
  move: `<path d="M12 2v20"/><path d="m15 19-3 3-3-3"/><path d="m19 9 3 3-3 3"/><path d="M2 12h20"/><path d="m5 9-3 3 3 3"/><path d="m9 5 3-3 3 3"/>`,
  hand: `<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>`,
  handGrab: `<path d="M18 11.5V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v1.4"/><path d="M14 10V8a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 9.9V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v5"/><path d="M6 14a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-4a8 8 0 0 1-8-8 2 2 0 1 1 4 0"/>`,
  moveH: `<path d="m18 8 4 4-4 4"/><path d="M2 12h20"/><path d="m6 8-4 4 4 4"/>`,
  moveV: `<path d="M12 2v20"/><path d="m8 18 4 4 4-4"/><path d="m8 6 4-4 4 4"/>`,
  diag: `<path d="M5 5 19 19"/><path d="M5 10 5 5 10 5"/><path d="M19 14 19 19 14 19"/>`,   // ↖↘ (nwse): TL–BR line, arrowheads pointing NW + SE
  diag2: `<path d="M19 5 5 19"/><path d="M14 5 19 5 19 10"/><path d="M10 19 5 19 5 14"/>`,   // ↗↙ (nesw): TR–BL line, arrowheads pointing NE + SW
  zoomIn: `<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="11" x2="11" y1="8" y2="14"/><line x1="8" x2="14" y1="11" y2="11"/>`,
  zoomOut: `<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="8" x2="14" y1="11" y2="11"/>`,
  crosshair: `<line x1="22" x2="2" y1="12" y2="12"/><line x1="12" x2="12" y1="22" y2="2"/>`,
  cell: `<rect x="4" y="4" width="16" height="16" rx="1"/><line x1="12" x2="12" y1="2" y2="22"/><line x1="2" x2="22" y1="12" y2="12"/>`,
  // Hand-drawn "?" (lucide circle-help was unavailable on main); used as a badge.
  question: `<path d="M9 9a3 3 0 1 1 4.2 2.75c-.9.5-1.2 1-1.2 1.75"/><path d="M12 17h.01"/>`,
};

/**
 * Compose the macOS-style arrow with a small badge tucked at its lower-right —
 * the shape real OS cursors use for copy (+), alias (shortcut), no-drop (∅),
 * context-menu (☰), and progress (spinner). The badge sits in a white rounded
 * chip for contrast against the arrow and the page.
 */
function arrowBadge(badgeBody: string): string {
  // Badge: a 10×10 white chip at (12.5, 12.5)–(23.5, 23.5) with the icon scaled
  // into it. The icon is drawn in its own 24-box then mapped into the chip.
  return `${L.arrow}<g transform="translate(12.5 12.5)"><rect x="0" y="0" width="11" height="11" rx="2.5" fill="#fff" stroke="#1a1a1a" stroke-width="1"/><g transform="translate(1.4 1.4) scale(0.342)" fill="none" stroke="#1a1a1a" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">${badgeBody}</g></g>`;
}

const ARROW: CursorGlyph = { body: L.arrow, fill: true, hotspot: [4.5, 4.5] };
const ARROW_TIP: [number, number] = [4.5, 4.5];

/**
 * Every CSS `cursor` keyword → its glyph. `auto`, `default`, `inherit`,
 * `initial`, and an unresolved `url(...)` fallback all resolve to the arrow
 * here; the overlay resolves `auto` to `text` / `default` per Chrome BEFORE
 * looking up this table (DM-1106 phase 2). `none` is an empty glyph.
 */
export const CURSOR_GLYPHS: Record<string, CursorGlyph> = {
  // General
  default: ARROW,
  auto: ARROW,
  none: { body: "", hotspot: [12, 12] },
  // Links & status
  "context-menu": { body: arrowBadge(L.menu), fill: true, hotspot: ARROW_TIP },
  help: { body: arrowBadge(L.question), fill: true, hotspot: ARROW_TIP },
  pointer: { body: L.pointer, hotspot: [8, 2] },
  progress: { body: arrowBadge(L.spinner), fill: true, hotspot: ARROW_TIP },
  wait: { body: L.spinner, hotspot: [12, 12] },
  // Selection
  cell: { body: L.cell, hotspot: [12, 12] },
  crosshair: { body: L.crosshair, hotspot: [12, 12] },
  text: { body: L.ibeam, hotspot: [12, 12] },
  "vertical-text": { body: L.ibeam, hotspot: [12, 12], rotate: 90 },
  // Drag & drop
  alias: { body: arrowBadge(L.shortcut), fill: true, hotspot: ARROW_TIP },
  copy: { body: arrowBadge(L.plus), fill: true, hotspot: ARROW_TIP },
  move: { body: L.move, hotspot: [12, 12] },
  "no-drop": { body: arrowBadge(L.ban), fill: true, hotspot: ARROW_TIP },
  "not-allowed": { body: L.ban, hotspot: [12, 12] },
  grab: { body: L.hand, hotspot: [12, 12] },
  grabbing: { body: L.handGrab, hotspot: [12, 12] },
  // Resizing & scrolling
  "all-scroll": { body: `${L.move}<circle cx="12" cy="12" r="1.6" fill="#1a1a1a" stroke="none"/>`, hotspot: [12, 12] },
  "col-resize": { body: `${L.moveH}<line x1="12" y1="4" x2="12" y2="20"/>`, hotspot: [12, 12] },
  "row-resize": { body: `${L.moveV}<line x1="4" y1="12" x2="20" y2="12"/>`, hotspot: [12, 12] },
  "e-resize": { body: L.moveH, hotspot: [12, 12] },
  "w-resize": { body: L.moveH, hotspot: [12, 12] },
  "ew-resize": { body: L.moveH, hotspot: [12, 12] },
  "n-resize": { body: L.moveV, hotspot: [12, 12] },
  "s-resize": { body: L.moveV, hotspot: [12, 12] },
  "ns-resize": { body: L.moveV, hotspot: [12, 12] },
  "ne-resize": { body: L.diag2, hotspot: [12, 12] },
  "sw-resize": { body: L.diag2, hotspot: [12, 12] },
  "nesw-resize": { body: L.diag2, hotspot: [12, 12] },
  "nw-resize": { body: L.diag, hotspot: [12, 12] },
  "se-resize": { body: L.diag, hotspot: [12, 12] },
  "nwse-resize": { body: L.diag, hotspot: [12, 12] },
  // Zoom
  "zoom-in": { body: L.zoomIn, hotspot: [11, 11] },
  "zoom-out": { body: L.zoomOut, hotspot: [11, 11] },
};

/** Canonical display order, grouped by the MDN cursor categories. */
export const CURSOR_CATEGORIES: { title: string; values: string[] }[] = [
  { title: "General", values: ["auto", "default", "none"] },
  { title: "Links & status", values: ["context-menu", "help", "pointer", "progress", "wait"] },
  { title: "Selection", values: ["cell", "crosshair", "text", "vertical-text"] },
  { title: "Drag & drop", values: ["alias", "copy", "move", "no-drop", "not-allowed", "grab", "grabbing"] },
  { title: "Resizing & scrolling", values: ["all-scroll", "col-resize", "row-resize", "n-resize", "e-resize", "s-resize", "w-resize", "ew-resize", "ns-resize", "ne-resize", "nw-resize", "se-resize", "sw-resize", "nesw-resize", "nwse-resize"] },
  { title: "Zooming", values: ["zoom-in", "zoom-out"] },
];

/**
 * Render a cursor glyph as an SVG `<g>`, positioned so its hotspot sits at
 * `(x, y)` and the 24-box is scaled to `size` px. Paints a white halo under the
 * dark glyph (filled glyphs use a white fill + dark outline). Returns "" for an
 * empty glyph (`none`).
 */
export function cursorGlyphSvg(value: string, x: number, y: number, size = 22, color = "#1a1a1a"): string {
  const g = CURSOR_GLYPHS[value] ?? CURSOR_GLYPHS.default;
  if (g.body === "") return "";
  const s = size / 24;
  const tx = x - g.hotspot[0] * s;
  const ty = y - g.hotspot[1] * s;
  const rot = g.rotate ? ` rotate(${g.rotate} 12 12)` : "";
  const inner = g.fill
    // Filled silhouette: white fill + dark outline (classic arrow look).
    ? `<g fill="#fff" stroke="${color}" stroke-width="1.4" stroke-linejoin="round">${g.body}</g>`
    // Line-art: white halo stroke under the dark stroke.
    : `<g fill="none" stroke-linecap="round" stroke-linejoin="round"><g stroke="#fff" stroke-width="3.4">${g.body}</g><g stroke="${color}" stroke-width="1.7">${g.body}</g></g>`;
  return `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${s.toFixed(4)})"><g transform="${rot.trim() || "translate(0 0)"}">${inner}</g></g>`;
}

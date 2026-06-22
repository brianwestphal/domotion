// @ts-nocheck
//
// Tiny CSS-value utilities shared between the capture script's helper
// modules. Kept in their own file so pseudo-rules / placeholder-shown /
// font-metrics can each `import { isUnsetCssValue } from "./utils.js"`
// without circular-import risk. Pure functions / constants — no DOM access.

// CSS keywords that mean "no author-set value" in a getComputedStyle longhand.
// The 'inherit' / 'initial' / 'unset' / 'revert' set is per CSS Cascade L4.
export const isUnsetCssValue = (v) =>
  v === '' || v === 'initial' || v === 'inherit' || v === 'unset' || v === 'revert';

// True when a computed-style value is present and meaningful — not null/undefined,
// not the empty string, not the `none` keyword. Collapses the recurring
// `v && v !== 'none' && v !== ''` / `v != null && v !== '' && v !== 'none'` triple
// (equivalent for CSS string values, which are never falsy other than ''). NOT the
// inverse of `isUnsetCssValue` — that tests the cascade keywords; this tests none/empty.
export const hasCssValue = (v) => v != null && v !== '' && v !== 'none';

// Read a computed-style box's four physical-side longhands into
// `{ top, right, bottom, left }` numbers, defaulting each to 0 — collapses the
// `parseFloat(cs.borderTopWidth) || 0` × 4 idiom. `prop` is the property base
// ('border' / 'padding' / 'margin'), `suffix` the trailing word ('Width' for
// border, '' for padding / margin). e.g. sideWidths(cs, 'border', 'Width') reads
// border{Top,Right,Bottom,Left}Width; sideWidths(cs, 'padding', '') reads
// padding{Top,Right,Bottom,Left}.
export const sideWidths = (cs, prop, suffix) => ({
  top: parseFloat(cs[prop + 'Top' + suffix]) || 0,
  right: parseFloat(cs[prop + 'Right' + suffix]) || 0,
  bottom: parseFloat(cs[prop + 'Bottom' + suffix]) || 0,
  left: parseFloat(cs[prop + 'Left' + suffix]) || 0,
});

// First-color extractor for a CSS background-shorthand: picks the *color* layer
// out of a shorthand that may also carry a gradient or url() image. Catches
// hex / rgba() / hsla() / currentColor / transparent and the full CSS Color 4
// `<named-color>` set. DM-1236: the named list was previously just 9 popular
// names, so a shorthand using any other spec-valid name (e.g. `rebeccapurple`,
// `cornflowerblue`) dropped its color layer. Mirrors render-side `NAMED_COLORS`
// in `src/render/colors.ts` (DM-1231) — regenerate both from
// `node tools/scratch/probe-named-colors.mjs` if the CSS color list grows.
// `\b`-anchored + listed longest-first so a longer name (`darkgray`) is never
// mis-matched as a shorter one (`gray`).
const NAMED_COLOR_ALTERNATION =
  "lightgoldenrodyellow|mediumspringgreen|mediumaquamarine|mediumslateblue|mediumturquoise|mediumvioletred|blanchedalmond|cornflowerblue|darkolivegreen|lightslategray|lightslategrey|lightsteelblue|mediumseagreen|darkgoldenrod|darkslateblue|darkslategray|darkslategrey|darkturquoise|lavenderblush|lightseagreen|palegoldenrod|paleturquoise|palevioletred|rebeccapurple|antiquewhite|darkseagreen|lemonchiffon|lightskyblue|mediumorchid|mediumpurple|midnightblue|darkmagenta|deepskyblue|floralwhite|forestgreen|greenyellow|lightsalmon|lightyellow|navajowhite|saddlebrown|springgreen|yellowgreen|aquamarine|blueviolet|chartreuse|darkorange|darkorchid|darksalmon|darkviolet|dodgerblue|ghostwhite|lightcoral|lightgreen|mediumblue|papayawhip|powderblue|sandybrown|whitesmoke|aliceblue|burlywood|cadetblue|chocolate|darkgreen|darkkhaki|firebrick|gainsboro|goldenrod|indianred|lawngreen|lightblue|lightcyan|lightgray|lightgrey|lightpink|limegreen|mintcream|mistyrose|olivedrab|orangered|palegreen|peachpuff|rosybrown|royalblue|slateblue|slategray|slategrey|steelblue|turquoise|cornsilk|darkblue|darkcyan|darkgray|darkgrey|deeppink|honeydew|lavender|moccasin|seagreen|seashell|crimson|darkred|dimgray|dimgrey|fuchsia|hotpink|magenta|oldlace|skyblue|thistle|bisque|indigo|maroon|orange|orchid|purple|salmon|sienna|silver|tomato|violet|yellow|azure|beige|black|brown|coral|green|ivory|khaki|linen|olive|wheat|white|aqua|blue|cyan|gold|gray|grey|lime|navy|peru|pink|plum|snow|teal|red|tan|transparent|currentColor";
export const firstColorRe = new RegExp(
  `(#[0-9a-fA-F]{3,8}|rgba?\\([^)]*\\)|hsla?\\([^)]*\\)|\\b(?:${NAMED_COLOR_ALTERNATION})\\b)`,
);

// Text-presenting <input> types: the ones Chrome's UA stylesheet gives a `text`
// (I-beam) cursor and where `auto` would resolve to I-beam. Excludes button-like
// (button/submit/reset/checkbox/radio/range/color/file/image) which get `default`.
const _TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);

/**
 * DM-1106: resolve an element's EFFECTIVE cursor — the concrete keyword Chrome
 * paints — from its computed `cursor`. `cursor` inherits, so `cs.cursor` already
 * carries the effective specified value; this collapses the two cases
 * getComputedStyle does NOT pre-resolve:
 *   - `url(...) , <kw>` custom cursors → the mandatory keyword fallback (we can't
 *     embed the bitmap, and it's the value Chrome falls back to anyway).
 *   - `auto` → Blink's `SelectAutoCursor` / `ShouldShowIBeamForNode`
 *     (event_handler.cc): an I-beam (vertical-text in a vertical writing mode)
 *     over editable or selectable text, otherwise the default arrow. Links and
 *     text inputs already compute to `pointer` / `text` via the UA sheet, so
 *     they never reach the `auto` branch.
 * Returns a single CSS cursor keyword.
 */
export const resolveElementCursor = (el, cs) => {
  let c = (cs.cursor || 'auto').trim();
  if (c.indexOf('url(') !== -1) {
    // Keep only the comma-separated keyword fallback (last token).
    const parts = c.split(',');
    c = parts[parts.length - 1].trim();
  }
  if (c !== 'auto') return c;
  // `auto` resolution (Blink SelectAutoCursor).
  const tag = el.tagName;
  const editable = el.isContentEditable === true
    || tag === 'TEXTAREA'
    || (tag === 'INPUT' && _TEXT_INPUT_TYPES.has((el.getAttribute('type') || 'text').toLowerCase()));
  let selectableText = false;
  if (!editable) {
    const us = cs.userSelect || cs.webkitUserSelect || '';
    if (us !== 'none') {
      // Selectable only if this element directly bears non-whitespace text.
      for (let i = 0; i < el.childNodes.length; i++) {
        const n = el.childNodes[i];
        if (n.nodeType === 3 && n.textContent && n.textContent.trim() !== '') { selectableText = true; break; }
      }
    }
  }
  if (editable || selectableText) {
    return (cs.writingMode || '').indexOf('vertical') === 0 ? 'vertical-text' : 'text';
  }
  return 'default';
};

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

// First-color extractor for a CSS background-shorthand. Catches hex / rgba /
// hsla / common named colors / currentColor. Intentionally narrow — designed
// for picking the *color* layer out of a shorthand that may also carry a
// gradient or url() image. Author CSS that hides a non-named color inside a
// var() round-trips elsewhere via the host-probe path.
export const firstColorRe = /(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|\b(?:white|black|red|green|blue|yellow|purple|orange|gray|grey|currentColor)\b)/;

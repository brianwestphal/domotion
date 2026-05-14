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

// First-color extractor for a CSS background-shorthand. Catches hex / rgba /
// hsla / common named colors / currentColor. Intentionally narrow — designed
// for picking the *color* layer out of a shorthand that may also carry a
// gradient or url() image. Author CSS that hides a non-named color inside a
// var() round-trips elsewhere via the host-probe path.
export const firstColorRe = /(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|\b(?:white|black|red|green|blue|yellow|purple|orange|gray|grey|currentColor)\b)/;

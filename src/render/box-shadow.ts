/**
 * Parse CSS `box-shadow` declarations into a list of shadow layers the
 * renderer can emit as `<filter>` / `<feDropShadow>` blocks. The color stays
 * as the raw CSS string — downstream `parseColor` resolves it at emit time so
 * `currentcolor` substitution can run with the element's own color in scope.
 * Returns [] when the input is "none" or unparseable. See SK-1111.
 */

import { splitTopLevelCommas } from "./css-tokens.js";

export interface BoxShadow {
  inset: boolean;
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: string;
}

export function parseBoxShadow(value: string): BoxShadow[] {
  if (value == null || value === "" || value === "none") return [];
  const out: BoxShadow[] = [];
  for (const raw of splitTopLevelCommas(value)) {
    const s = raw.trim();
    if (s === "") continue;
    // Pull the color out first (rgb/rgba/hsl/color/oklab/etc + bracket-wrapped).
    // The color block may sit anywhere in the value but typically comes at the
    // start in computed form. Match `<funcname>(...)` greedy.
    let color = "";
    let rest = s;
    const colorMatch = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\([^)]*\)/i.exec(s);
    if (colorMatch != null) {
      color = colorMatch[0];
      rest = s.slice(colorMatch[0].length).trim();
    }
    const tokens = rest.split(/\s+/).filter((t) => t !== "");
    let inset = false;
    const lengths: number[] = [];
    for (const t of tokens) {
      if (t === "inset") { inset = true; continue; }
      const n = parseFloat(t);
      if (!isNaN(n)) lengths.push(n);
    }
    // CSS allows the color anywhere; if it wasn't at the start, scan tokens.
    if (color === "" && tokens.length > 0) {
      // Last token that doesn't parse as length and isn't "inset" is the color.
      for (let i = tokens.length - 1; i >= 0; i--) {
        const t = tokens[i];
        if (t === "inset" || !isNaN(parseFloat(t))) continue;
        color = t;
        break;
      }
    }
    if (color === "") color = "currentcolor";
    out.push({
      inset,
      x: lengths[0] ?? 0,
      y: lengths[1] ?? 0,
      blur: lengths[2] ?? 0,
      spread: lengths[3] ?? 0,
      color,
    });
  }
  return out;
}

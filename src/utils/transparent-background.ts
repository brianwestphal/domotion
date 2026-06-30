/**
 * Whether a CSS background string carries no opaque color, so the output should
 * be transparent (no backdrop rect painted).
 *
 * This is the canonical transparent-background predicate, shared by the CLI bins
 * (`svg-to-image` / `svg-to-video`, via `cli/common.ts`) AND the multi-frame
 * composers — the animator (`generateAnimatedSvg`), the scroll composer
 * (`composeScrollSvg`), and the composite builder (`buildCompositeSvg`).
 *
 * It recognizes every transparent CSS form a caller can supply: the `transparent`
 * / `none` keywords and the empty string, any hex color with a zero alpha nibble
 * (`#rgba`) or byte (`#rrggbbaa`), and `rgba()` / `hsla()` with a zero `0` / `0%`
 * / `0.0…` alpha component (comma- or slash-separated, whitespace-insensitive).
 *
 * DM-1457: previously the three composer sites each hand-rolled a weaker inline
 * check (e.g. `bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)"`) that treated
 * `"none"`, `"#0000"`, `"#00000000"`, and unspaced `"rgba(0,0,0,0)"` as opaque
 * and painted a backdrop rect — the exact regression the DM-893/894 "transparent
 * stays transparent" guards exist to prevent. Routing all sites through this one
 * predicate closes that gap.
 */
export function isTransparentBackground(bg: string): boolean {
  const v = bg.trim().toLowerCase();
  if (v === "" || v === "transparent" || v === "none") return true;
  // #rgba / #rrggbbaa hex with a zero alpha nibble / byte.
  if (/^#[0-9a-f]{4}$/.test(v) && v[4] === "0") return true;
  if (/^#[0-9a-f]{8}$/.test(v) && v.slice(7) === "00") return true;
  // rgba()/hsla() with a zero (or 0%) alpha component.
  const fn = v.match(/^(?:rgba|hsla)\(([^)]*)\)$/);
  if (fn != null) {
    const parts = fn[1].split(/[,/]/).map((p) => p.trim()).filter((p) => p !== "");
    const a = parts[parts.length - 1];
    if (parts.length >= 4 && (a === "0%" || /^0(?:\.0+)?$/.test(a))) return true;
  }
  return false;
}

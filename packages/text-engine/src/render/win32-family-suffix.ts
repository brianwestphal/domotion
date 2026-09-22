/**
 * Blink's Windows-only family-name suffix adjustment, transcribed.
 *
 * On Windows a CSS family like "Segoe UI Light" or "Arial Narrow" is not a
 * DirectWrite family — the system collection groups those faces under
 * "Segoe UI" / "Arial". Blink resolves them in
 * `FontCache::CreateFontPlatformData` (`platform/fonts/win/font_cache_skia_win.cc`,
 * rev 7d859f27; the tag-147 build Playwright pins carries the same tables):
 * when `CreateTypeface` returns nothing for the family (or a face whose family
 * names do not match the request), it tries, in this order:
 *
 *   1. `TypefacesHasWeightSuffix` (`:335-372`) — strip a known weight suffix
 *      and retry with the suffix's weight REPLACING the description's weight.
 *      So "Segoe UI Light" resolves the Light cut at every CSS weight — the
 *      name pins the weight; the run's `font-weight` no longer participates.
 *   2. `TypefacesHasStretchSuffix` (`:374-407`) — same for stretch suffixes
 *      (" narrow" is deliberately a synonym for " condensed").
 *
 * Only one suffix is stripped — Blink does not recurse — and the retry must
 * itself match a real family or the resolution fails (the caller walks on).
 *
 * Kept dependency-free so the Windows conformance oracle
 * (`tools/family-match-conformance-win32.ts`) can exercise the SAME shipped
 * table + order it measures the render path against, rather than a
 * restatement.
 */

export interface Win32SuffixAdjustment {
  /** The family with the suffix stripped ("Segoe UI Light" → "Segoe UI"). */
  family: string;
  /** The weight the suffix pins, replacing the CSS weight (weight suffixes). */
  weight?: number;
  /** The stretch percent the suffix pins, replacing the CSS stretch. */
  stretch?: number;
}

/** `TypefacesHasWeightSuffix`'s table (`font_cache_skia_win.cc:346-359`).
 *  Intentionally incomplete upstream — GDI backward compatibility — so it must
 *  not be "completed" here. */
const WEIGHT_SUFFIXES: ReadonlyArray<[string, number]> = [
  [" thin", 100],
  [" extralight", 200],
  [" ultralight", 200],
  [" light", 300],
  [" regular", 400],
  [" medium", 500],
  [" demibold", 600],
  [" semibold", 600],
  [" extrabold", 800],
  [" ultrabold", 800],
  [" black", 900],
  [" heavy", 900],
];

/** `TypefacesHasStretchSuffix`'s table (`font_cache_skia_win.cc:385-397`);
 *  values are the CSS stretch keyword percentages (`font_selection_types.h`). */
const STRETCH_SUFFIXES: ReadonlyArray<[string, number]> = [
  [" ultracondensed", 50],
  [" extracondensed", 62.5],
  [" condensed", 75],
  [" narrow", 75],
  [" semicondensed", 87.5],
  [" semiexpanded", 112.5],
  [" expanded", 125],
  [" extraexpanded", 150],
  [" ultraexpanded", 200],
];

/**
 * The adjusted (family, pinned style) for a suffixed Windows family name, or
 * null when the name carries no recognized suffix. Weight suffixes are tried
 * before stretch suffixes, matching Blink's `else if` order.
 */
export function win32FamilySuffixAdjustment(family: string): Win32SuffixAdjustment | null {
  const lower = family.toLowerCase();
  for (const [suffix, weight] of WEIGHT_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return { family: family.slice(0, family.length - suffix.length), weight };
    }
  }
  for (const [suffix, stretch] of STRETCH_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return { family: family.slice(0, family.length - suffix.length), stretch };
    }
  }
  return null;
}

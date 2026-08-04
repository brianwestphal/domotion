/**
 * Shared projections of the renderer's OpenType feature list.
 *
 * A feature-list entry is a HarfBuzz feature string (the `hb_feature_from_string`
 * grammar): `liga` enables a feature at value 1, `-liga` disables it (value 0),
 * and `aalt=2` requests an explicit value. Chrome hands HarfBuzz every author
 * setting with its value intact — `FontFeatureRange::FromFontDescription`
 * appends each `font-feature-settings` entry verbatim
 * (`external/chromium/third_party/blink/renderer/platform/fonts/shaping/font_features.cc:203-225`,
 * rev 7d859f27) — and HarfBuzz expresses a zero by leaving the feature's lookup
 * mask unset (`hb-ot-map.cc`) or, on an AAT face, by selecting the feature's
 * OFF selector (`hb-aat-map.cc:79`, rev 4de187d).
 *
 * fontkit's `font.layout(text, features)` takes an enable-only tag list and can
 * express neither a disable nor a value, so the two shaping consumers need
 * different projections of the same list:
 *
 *  - `fontkitFeatureList` — the enable-only projection for fontkit / the
 *    platform glyph helpers (which ignore the list entirely).
 *  - `featureListNeedsHbShaping` — the routing predicate: a list carrying a
 *    disable or an explicit value can only be honored by HarfBuzz, so the run
 *    is wrapped in a HarfBuzz shaping proxy (see
 *    `fontFeatureValueShapingOverride` in `font-resolution.ts`), which receives
 *    the UNPROJECTED list.
 */

/** True when any entry carries state fontkit cannot express — a disable
 *  (`-liga`) or an explicit value (`aalt=2`). Such a list requires HarfBuzz
 *  shaping to match Chrome. */
export function featureListNeedsHbShaping(features: string[] | undefined): boolean {
  if (features == null) return false;
  for (const f of features) {
    if (f.startsWith("-") || f.includes("=")) return true;
  }
  return false;
}

/**
 * The enable-only projection fontkit's `layout(text, features)` accepts:
 * disables are dropped (fontkit cannot switch a default-on feature off), and a
 * valued entry keeps its tag (fontkit can apply the feature, just not select an
 * alternate by index). Returns the SAME array instance when no projection is
 * needed, so run-grouping identity comparisons upstream stay stable.
 */
export function fontkitFeatureList(features: string[] | undefined): string[] | undefined {
  if (features == null || !featureListNeedsHbShaping(features)) return features;
  const out: string[] = [];
  for (const f of features) {
    if (f.startsWith("-")) continue;
    const eq = f.indexOf("=");
    out.push(eq >= 0 ? f.slice(0, eq) : f);
  }
  return out.length > 0 ? out : undefined;
}

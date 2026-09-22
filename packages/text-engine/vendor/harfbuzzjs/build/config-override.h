/* HarfBuzz build configuration, matched to the one Chromium ships.
 *
 * Transcribed from external/chromium/third_party/harfbuzz/BUILD.gn:462-518
 * (Chromium rev 7d859f27, 2026-06-27), which pins HarfBuzz 14.2.1 — the same
 * release harfbuzzjs 1.4.0 vendors.
 *
 * Section 1 re-enables the API surface the JS bindings export (harfbuzzjs's
 * own list, kept verbatim minus HB_NO_VAR_COMPOSITES). Section 2 is Chrome's
 * define list. Section 3 records the Chrome defines that cannot apply here.
 */

/* --- 1. API surface the JS bindings export (harfbuzzjs upstream) --------- */
#undef HB_NO_CFF
#undef HB_NO_OT_FONT_CFF
#undef HB_NO_DRAW
#undef HB_NO_BUFFER_MESSAGE
#undef HB_NO_BUFFER_SERIALIZE
#undef HB_NO_VAR
#undef HB_NO_OT_FONT_GLYPH_NAMES
#undef HB_NO_FACE_COLLECT_UNICODES
#undef HB_NO_AVAR2
#undef HB_NO_CUBIC_GLYF
#undef HB_NO_NAME
#undef HB_NO_METRICS
#undef HB_NO_LAYOUT_FEATURE_PARAMS
#undef HB_NO_LAYOUT_RARELY_USED
#undef HB_NO_LAYOUT_UNUSED
#define HB_BUFFER_MESSAGE_MORE 1

/* --- 2. Chrome's defines (BUILD.gn:462-518) ------------------------------ */
#define HB_NO_MMAP
#define HB_NO_RESOURCE_FORK

/* "Fallback shaper not required, we only use the HarfBuzz internal OT
 * shaper." Leaves the shaper list as {ot} alone, which is also what Blink
 * pins explicitly: hb_shape_full(..., ot_shaper_list) with
 * ot_shaper_list = {"ot"} (harfbuzz_shaper.cc:74-79, :350).
 * Note this is NOT HB_NO_OT_SHAPE_FALLBACK — Chrome keeps the OT shaper's
 * own fallback paths (Arabic/Hebrew/Thai fallback, vowel constraints). */
#define HB_NO_FALLBACK_SHAPE

/* ".fon file support, not needed for Chrome" */
#define HB_NO_WIN1256

/* "Buffer verification not used in production build." */
#define HB_NO_BUFFER_VERIFY

/* "Don't ship experimental extensions." (No longer referenced anywhere in
 * HarfBuzz 14.x — the gate is now HB_EXPERIMENTAL_API, which Chrome does not
 * define and which this build no longer defines either.) */
#define HB_NO_BORING_EXPANSION

/* "Don't ship VARC yet." */
#define HB_NO_VAR_COMPOSITES

/* HarfBuzz's pragma-enabled warnings block compiler upgrades; Chrome turns
 * the pragmas off. Also what makes this build clean under emsdk's clang. */
#define HB_NO_PRAGMA_GCC_DIAGNOSTIC_ERROR
#define HB_NO_PRAGMA_GCC_DIAGNOSTIC_WARNING

/* --- 3. Chrome defines NOT taken, and why -------------------------------- */
/* HAVE_ICU, HAVE_ICU_BUILTIN, HB_NO_UCD, U_DISABLE_VERSION_SUFFIX=0
 *   Chrome sources Unicode character properties (script, general category,
 *   combining class, mirroring, compose/decompose) from ICU instead of
 *   HarfBuzz's built-in UCD tables. There is no ICU in this wasm build, so
 *   hb-ucd answers instead. Residual divergence: the Unicode version behind
 *   those properties. Both are generated from Unicode data, so they agree
 *   except where the two versions differ — newly assigned codepoints.
 *
 * HAVE_FONTATIONS, HAVE_HARFRUST
 *   The Rust shaping backend. Not a divergence for shipping Chrome: Blink
 *   selects it only when the HarfRustShaping runtime flag is on, and that
 *   flag carries no status entry in runtime_enabled_features.json5:3386-3388,
 *   so it is off by default. Blink's default is the {"ot"} list above.
 *
 * HB_NO_DRAW, HB_NO_PAINT=
 *   Chrome can drop HarfBuzz's outline and extents machinery because Blink
 *   installs Skia-backed font funcs instead (SkTypeface supplies extents and
 *   paths). Nothing supplies them here, so HarfBuzz's own must stay — the
 *   closest analogue, not a behavioral difference in shaping.
 *   Note HB_NO_DRAW also chains to HB_NO_OT_FONT_CFF (hb-config.hh:140-144).
 *
 * HB_NO_SUBSET_LAYOUT, HB_NO_SUBSET_CFF
 *   Subsetting lives in a separate wasm module here (harfbuzz-subset.wasm),
 *   built from harfbuzz-subset.cc with its own config override.
 *
 * HAVE_PTHREAD
 *   Chrome sets it on non-mac/non-win only. Single-threaded wasm.
 */

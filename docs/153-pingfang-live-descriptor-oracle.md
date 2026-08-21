# PingFang live CoreText descriptor oracle

The diagnostic workflow `.github/workflows/pingfang-live-descriptor.yml` captures fallback state that cannot be reconstructed after a hosted macOS runner image expires. It is observational and does not change font routing.

The native arm asks `CTFontCreateForString` from `STHeitiSC-Light` for U+270F0 and U+270F4 plus adjacent uncovered controls. Three fresh Swift processes and three repeated queries in one warm process record the complete returned CTFont descriptor, URL and TTC identity, matrix, units-per-em, variation axes/current values, glyph id, bounds, and advance. Each answer is reopened by canonical PostScript name, display name, and a descriptor carrying explicit CoreText weight 0 (CSS weight 400) so provenance and weight materialization can be separated.

The same JSON artifact records Chromium Range widths and `CSS.getPlatformFontsForNode` rows for each scalar. Environment identity includes `sw_vers`, Darwin release, architecture, Playwright Chromium version, source commit, and a SHA-256 digest of `system_profiler SPFontsDataType -json`. `tools/pingfang-live-descriptor-schema.mjs` fails the job if an arm or identity field is absent; the workflow uploads the JSON as diagnostic evidence, not a baseline or release gate.

Run locally on macOS with `PINGFANG_DESCRIPTOR_OUTPUT=pingfang-live-descriptor.json node tools/pingfang-live-descriptor-oracle.mjs`.

Selection authority is Chromium's pinned `third_party/blink/renderer/platform/fonts/mac/font_cache_mac.mm`: system fallback passes the run's current CTFont to `CTFontCreateForString`. CoreText owns the returned descriptor and physical face; CDP is parallel browser evidence, not a substitute for the descriptor.

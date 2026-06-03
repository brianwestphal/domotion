/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

/**
 * HTML Test Suite Runner
 *
 * Runs domotion against every HTML file under `external/html-test/`.
 * For each file:
 *   1. Render HTML in Playwright (Chromium) -> PNG ("expected")
 *   2. Capture element tree -> SVG -> render SVG -> PNG ("actual")
 *   3. Diff and record result
 *
 * The fixture tree is the `brianwestphal/html-test` GitHub repo; it lives at
 * `external/html-test/` which is gitignored. Bootstrap with:
 *
 *   git clone https://github.com/brianwestphal/html-test.git external/html-test
 *
 * `HTML_TEST_DIR` can be overridden via the `HTML_TEST_DIR` env var if you
 * want to run against a different checkout / branch.
 *
 * Outputs:
 *   - tests/output/html-test/<name>-{expected,actual,diff}.png
 *   - tests/output/html-test/results.json  (for ticket generation)
 *   - tests/output/html-test/index.html    (visual overview)
 *
 * Usage: npx tsx tests/html-test-suite.tsx [--only 07-svg-shapes]
 */

import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync, readdirSync, statSync, existsSync, readFileSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureElementTreeWithWarnings, elementTreeToSvgInner, embedRemoteImages } from "../src/render/element-tree-to-svg.js";
import { discoverAndRegisterWebfonts } from "../src/capture/index.js";
import { rasterizeConicGradients } from "../src/render/conic-raster.js";
import { profReset, profSnapshot } from "../src/render/render-profile.js";
import { raw } from "kerfjs";
import { comparePngs, MIN_REGION_AREA, REGION_DILATE_PX, SIGNIFICANT_PIXEL_DIST, TILE_PX, type DiffVerdict } from "../src/review/compare-pngs.js";
import { waitForSettled } from "../src/utils/wait-events.js";
import { lowerProcessPriority, resolveWorkerCount, runJobsInPool } from "./worker-pool.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "..");
const HTML_TEST_DIR = process.env.HTML_TEST_DIR != null && process.env.HTML_TEST_DIR !== ""
  ? resolve(process.env.HTML_TEST_DIR)
  : resolve(PACKAGE_ROOT, "external/html-test");
// Anchor output under this package's tests/ regardless of cwd so runs from
// inside  don't create a stray
// subtree (the reason SK-991 was filed). Override via `HTML_TEST_OUTPUT_DIR`
// so a secondary suite (e.g. the unicode-block sweep — see
// `demos:test:unicode` in package.json) can point its expected/actual/diff
// triplets at a separate folder without clobbering the canonical
// html-test results.
const OUTPUT_DIR = process.env.HTML_TEST_OUTPUT_DIR != null && process.env.HTML_TEST_OUTPUT_DIR !== ""
  ? resolve(process.env.HTML_TEST_OUTPUT_DIR)
  : resolve(__dirname, "output/html-test");
const WIDTH = 1024;
const HEIGHT = 768;
// DM-1004: when set (`RENDER_SKIPPED=0` or `--no-render-skipped` on CLI),
// fixtures listed in SKIP_TESTS bypass the goto + screenshot + SVG render
// pipeline entirely and emit a placeholder result. Default keeps rendering
// so the review UI can inspect skipped artifacts; CI / batch sweeps that
// don't read the review UI can save the per-fixture cost.
const RENDER_SKIPPED = process.env.RENDER_SKIPPED !== "0"
  && !process.argv.includes("--no-render-skipped");

// DM-1002: expected.png cache. The expected screenshot is deterministic
// per (source HTML, viewport, Chromium version). When the cache hits we
// skip the per-fixture page.screenshot + bodyBg evaluate, copying the
// cached PNG into expectedPath and reading bodyBg from a sibling JSON
// meta file. The cache lives under OUTPUT_DIR/.expected-cache/ and is
// gitignored via the existing `tests/output/` rule.
//
// Cache key = sha256(htmlBytes + "|" + WIDTH + "x" + fixtureHeight + "|"
// + Playwright version). Playwright pins a specific Chromium revision
// per release, so the package version is a sufficient proxy for "the
// Chromium that would produce this screenshot."
const EXPECTED_CACHE_DIR = resolve(OUTPUT_DIR, ".expected-cache");
const _require = createRequire(import.meta.url);
const PLAYWRIGHT_VERSION: string = (() => {
  try { return _require("@playwright/test/package.json").version as string; }
  catch { return "unknown"; }
})();
// DM-1013: fold the CAPTURE_SCRIPT bundle hash into the cache key so a
// bundle rebuild (`npm run build:capture-script`) invalidates every
// cached tree. Read once at module init.
function _hashFileOrEmpty(path: string): string {
  try { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
  catch { return "missing"; }
}
const CAPTURE_SCRIPT_HASH = _hashFileOrEmpty(resolve(PACKAGE_ROOT, "src/capture/script.generated.ts"));
function expectedCacheKey(htmlBytes: Buffer, fixtureHeight: number): string {
  return createHash("sha256")
    .update(htmlBytes)
    .update(`|${WIDTH}x${fixtureHeight}|${PLAYWRIGHT_VERSION}|${CAPTURE_SCRIPT_HASH}`)
    .digest("hex");
}
function expectedCachePngPath(key: string): string { return resolve(EXPECTED_CACHE_DIR, `${key}.png`); }
function expectedCacheMetaPath(key: string): string { return resolve(EXPECTED_CACHE_DIR, `${key}.json`); }
// DM-1013: cache the raw captured tree + warnings alongside expected.png
// + bodyBg. On full cache hit, runOneHtmlTest skips the source goto,
// screenshot, bodyBg evaluate, webfont discovery, AND captureElementTree
// — the per-fixture bottleneck. The tree is captured BEFORE
// embedRemoteImages and rasterizeConicGradients (those passes add
// Buffer data in place; cache cleanly without it and re-run them on
// cache load).
interface ExpectedCacheMeta {
  bodyBg: string;
  tree?: unknown; // raw element tree from captureElementTreeWithWarnings
  warnings?: Array<{ selector: string; feature: string; detail: string }>;
}
// Cache-hit / cache-miss counters (DM-1002 verification — reported at the
// end of the run alongside the pass/fail summary so we can confirm the
// cache is actually firing as expected).
let _expectedCacheHits = 0;
let _expectedCacheMisses = 0;

// DM-1029: per-step timing instrumentation for a single demo-test run. Opt-in
// via `DEMO_TIMING=1` so it's zero-overhead in normal CI runs (the `mark()`
// calls below are no-ops when the flag is off). When on, each fixture pushes a
// record of its serial pipeline (step → ms) into `_timingRecords`, and the main
// runner writes `<OUTPUT_DIR>/timing.json` (the per-step durations + the run's
// worker count + total wall time) after the pool drains. Kept in permanently:
// this pipeline is the thing we re-measure as we optimize it (DM-1029), so the
// instrumentation has to stay so the numbers stay reproducible. See
// `tools/render-timing-diagram.mjs` for the SVG flamechart this feeds.
const DEMO_TIMING = process.env.DEMO_TIMING === "1";
interface FixtureTiming {
  name: string;
  worker: number;
  cacheHit: boolean;
  startMs: number; // wall-clock ms since run start (set by the runner)
  totalMs: number;
  steps: Array<{ step: string; ms: number }>;
  // DM-1029: sub-breakdown of the `render-svg` step (ms + call count per
  // stage) from the render-profiler — e.g. `helper-spawnSync`, `text-render`.
  renderProfile?: Record<string, { ms: number; count: number }>;
}
const _timingRecords: FixtureTiming[] = [];
let _timingRunStartMs = 0;
let _timingWorkerCount = 1;
/** Per-fixture step stopwatch. `mark(label)` records the elapsed time since the
 *  previous mark (or since `start()`), so steps are timed by bracketing each
 *  awaited stage with a trailing `mark()`. No-op unless DEMO_TIMING. */
function makeStepTimer() {
  const steps: Array<{ step: string; ms: number }> = [];
  let last = DEMO_TIMING ? performance.now() : 0;
  return {
    steps,
    mark(step: string): void {
      if (!DEMO_TIMING) return;
      const now = performance.now();
      steps.push({ step, ms: now - last });
      last = now;
    },
  };
}

/**
 * Per-fixture capture-height overrides for html-test files whose content
 * exceeds the 1024 × 768 default viewport (DM-781). The 768 px default
 * truncated the bottom of fixtures whose content stack was longer than the
 * viewport (e.g. `19-deep-color-mix` at 856 px, `niche-text-box-trim` at
 * 1680 px, `32-real-world-blog-post` at 4216 px); the captured PNG missed
 * sections that the test was actually checking. Generated by a one-time
 * Playwright probe (DM-781) over every `external/html-test/**.html`
 * fixture; the value is `ceil((max element-bottom + 8) / 8) * 8` — i.e.
 * the lowest visible element's bottom edge rounded up to the next 8 px
 * with an 8 px safety buffer.
 *
 * Width is fixed at 1024 px; only height needs overriding. Add a new entry
 * here whenever a fixture grows past the existing height — re-run the
 * probe (see `tools/probe-html-test-heights.mjs`) and copy the row in.
 */
const FIXTURE_HEIGHT_OVERRIDES: Record<string, number> = {
  "02-deep-bidi-isolate": 1272,
  "02-deep-line-breaking": 1064,
  "02-text-entities": 824,
  "02-text-symbols": 1752,
  "03-lists-style-image-position": 896,
  "03-lists-style-types": 1152,
  "03-lists-ul-ol": 1240,
  "04-deep-anonymous-boxes": 1056,
  "04-deep-border-conflict": 1024,
  "05-links-anchors": 1792,
  "06-deep-color-scheme-forms": 1448,
  "06-deep-field-sizing": 1248,
  "06-deep-input-baseline": 1072,
  "06-forms-input-types": 832,
  "06-forms-style-buttons": 1160,
  "06-forms-style-fieldset": 1632,
  "06-forms-style-focus": 1184,
  "06-forms-style-input-groups": 1144,
  "06-forms-style-layouts": 2056,
  "06-forms-style-progress-meter": 1128,
  "06-forms-style-range": 880,
  "06-forms-style-select": 1104,
  "06-forms-style-text-inputs": 1296,
  "06-forms-style-textarea": 2240,
  "07-deep-image-rendering": 2568,
  "07-deep-svg-markers-strokes": 2256,
  "07-deep-svg-presentation-attrs": 1792,
  "07-deep-svg-textpath-filters": 1712,
  "07-deep-svg-use-href": 824,
  "08-deep-details-accordion": 2304,
  "08-deep-popover-backdrop": 1240,
  "09-sectioning-landmarks": 784,
  "10-deep-attr-quoting": 1256,
  "10-deep-form-state-pseudos": 2432,
  "10-deep-has-complex": 1848,
  "10-deep-nth-of-type": 1960,
  "10-sel-combinators": 880,
  "10-sel-pseudo-logical": 896,
  "10-sel-pseudo-structural": 832,
  "10-sel-pseudo-ui-state": 912,
  "11-box-units": 960,
  "11-deep-box-sizing-mix": 1312,
  "11-deep-content-visibility": 3136,
  "11-deep-env-safe-area": 1104,
  "11-deep-intrinsic-sizing": 1568,
  "11-deep-margin-collapse-edges": 2336,
  "11-deep-math-functions": 2744,
  "11-deep-percent-resolution": 1248,
  "11-deep-viewport-units": 4112,
  "12-deep-display-contents": 920,
  "12-deep-display-syntax": 984,
  "13-deep-anchor-positioning": 1304,
  "13-deep-containing-block": 2648,
  "13-deep-cross-sc-z-index": 1456,
  "13-deep-fixed-in-transform": 2416,
  "13-deep-stacking-context-creators": 952,
  "13-deep-sticky-condensing-header": 1896,
  "13-deep-sticky-edges": 1376,
  "13-deep-z-index-flex-grid": 1032,
  "13-deep-z-index-negative": 1040,
  "13-pos-fixed": 1576,
  "13-pos-sticky": 1568,
  "14-deep-float-bfc": 1320,
  "14-deep-float-interactions": 1600,
  "15-deep-flex-aspect-ratio": 1336,
  "15-deep-flex-baseline": 1136,
  "15-deep-flex-min-auto": 952,
  "15-deep-flex-order-vs-z": 920,
  "15-flex-alignment": 2400,
  "15-flex-container": 1400,
  "15-flex-items": 864,
  "16-deep-grid-baseline": 1160,
  "16-deep-grid-implicit": 1880,
  "16-deep-grid-min-max-content": 1216,
  "16-deep-subgrid-lines": 960,
  "16-grid-alignment": 2088,
  "16-grid-auto-flow": 816,
  "16-grid-template": 824,
  "17-bg-color-image": 1904,
  "17-deep-bg-attachment-fixed": 1832,
  "17-deep-bg-clip-text": 1104,
  "17-deep-image-set": 1992,
  "17-deep-sprite-icons": 840,
  "18-deep-borders-mixed-sides": 1360,
  "18-deep-decoration-clone": 1648,
  "18-deep-radius-overflow": 1448,
  "18-deep-shadow-stacking": 1440,
  "19-deep-color-mix": 864,
  "19-deep-color-spaces": 1344,
  "19-deep-relative-color": 1032,
  "20-deep-decoration-detail": 1040,
  "20-deep-first-letter-line": 3680,
  "20-deep-font-feature-values": 2664,
  "20-deep-font-features": 1392,
  "20-deep-font-palette": 1888,
  "20-deep-hanging-punctuation": 2752,
  "20-deep-line-box-baselines": 1144,
  "20-deep-selection-highlight": 2032,
  "20-deep-tab-size": 2184,
  "20-deep-text-emphasis": 1576,
  "20-deep-text-stroke": 2976,
  "20-deep-text-underline-position": 2240,
  "20-deep-vertical-align": 1264,
  "20-deep-wavy-underline-descenders": 1400,
  "20-deep-writing-mode-mixed": 2096,
  "20-text-line-spacing": 1016,
  "20-text-wrapping": 1608,
  "20-writing-mode": 960,
  "21-deep-anisotropic-scale": 1248,
  "21-deep-transform-3d-preserve": 1224,
  "21-deep-transform-box": 1336,
  "21-deep-transform-origin": 1064,
  "21-transform-2d": 1096,
  "22-backdrop-filter": 840,
  "22-blend-modes": 1984,
  "22-deep-blend-groups": 2224,
  "22-deep-filter-paint-bounds": 2048,
  "22-deep-filter-stacking": 1512,
  "22-deep-isolation": 1392,
  "23-deep-clip-path-shapes": 1520,
  "23-deep-mask-composite": 1440,
  "23-deep-mask-fade-edges": 1752,
  "24-counters": 1128,
  "24-deep-counter-scope": 1360,
  "24-deep-counter-style": 3200,
  "24-deep-initial-letter": 1496,
  "24-deep-pseudo-shapes": 872,
  "25-deep-line-clamp": 1424,
  "25-deep-overflow-auto-positioned": 1352,
  "25-deep-overflow-clip": 1416,
  "25-deep-scrollbar-style": 1568,
  "25-overscroll": 2424,
  "25-scroll-snap": 1376,
  "26-deep-forced-colors": 1768,
  "27-deep-page-margin-boxes": 1520,
  "27-page": 1328,
  "28-deep-container-types": 1184,
  "28-deep-layer-import": 984,
  "28-deep-nesting-complex": 1344,
  "28-deep-scope": 1552,
  "29-deep-layer-priority": 1296,
  "29-deep-property-registration": 1184,
  "29-deep-where-is-specificity": 1040,
  "30-deep-resize-overflow": 1304,
  "30-resize": 792,
  "31-deep-inert-hidden": 1760,
  "31-global-attrs": 784,
  "32-real-world-blog-post": 4216,
  "32-real-world-mobile-app-frame": 984,
  "32-real-world-news-card": 1952,
  "32-real-world-pricing-table": 1392,
  "33-columns-basic": 1800,
  "33-deep-columns-break": 2024,
  "34-mathml-basic": 1784,
  "34-mathml-layout": 1632,
  "niche-align-content-block": 1992,
  "niche-anchor-position-try": 2480,
  "niche-command-invokers": 1296,
  "niche-cross-fade-images": 2472,
  "niche-css-function-rule": 1384,
  "niche-if-function": 1144,
  "niche-logical-clear-caption": 2304,
  "niche-mask-border": 1792,
  "niche-reading-flow": 1360,
  "niche-scroll-markers": 1760,
  "niche-scroll-state-queries": 1584,
  "niche-select-customizable": 808,
  "niche-shadow-dom-declarative": 1256,
  "niche-style-queries": 1808,
  "niche-svg-view-switch": 1944,
  "niche-text-box-trim": 1680,
  "niche-webkit-box-reflect": 1480,
  "niche-zoom-text-rendering": 2112,

  // Per-Unicode-block sweep fixtures (`../html-test/unicode/*.html`,
  // surfaced via `npm run demos:test:unicode`). Names start with the
  // hex codepoint range so they do not collide with the html-test
  // entries above. Pre-chunked fixtures use a `.N` suffix on disk to
  // keep each rendered page under ~1700 px (the user maintains the
  // unicode checkout separately and splits giant codepoint grids by
  // hand into N sequential pages). Regenerate this block via
  // `node tools/probe-html-test-heights.mjs ../html-test/unicode`.
  "0100-017F-latin-extended-a": 920,
  "0180-024F-latin-extended-b": 1392,
  "0300-036F-combining-diacritical-marks": 840,
  "0370-03FF-greek-and-coptic": 1000,
  "0400-04FF-cyrillic": 1704,
  "0600-06FF-arabic": 1704,
  "0900-097F-devanagari": 920,
  "0D00-0D7F-malayalam": 920,
  "0F00-0FFF-tibetan": 1464,
  "1000-109F-myanmar": 1152,
  "10080-100FF-linear-b-ideograms": 920,
  "10600-1077F-linear-a.0": 1704,
  "10C80-10CFF-old-hungarian": 840,
  "1100-11FF-hangul-jamo": 1704,
  "11000-1107F-brahmi": 840,
  "1200-137F-ethiopic.0": 1704,
  "12000-123FF-cuneiform.0": 1704,
  "12000-123FF-cuneiform.1": 1704,
  "12000-123FF-cuneiform.2": 1704,
  "12000-123FF-cuneiform.3": 1000,
  "12400-1247F-cuneiform-numbers-and-punctuation": 840,
  "12480-1254F-early-dynastic-cuneiform": 1392,
  "13000-1342F-egyptian-hieroglyphs.0": 1704,
  "13000-1342F-egyptian-hieroglyphs.1": 1704,
  "13000-1342F-egyptian-hieroglyphs.2": 1704,
  "13000-1342F-egyptian-hieroglyphs.3": 1704,
  "13460-143FF-egyptian-hieroglyphs-extended-a.0": 1704,
  "13460-143FF-egyptian-hieroglyphs-extended-a.1": 1704,
  "13460-143FF-egyptian-hieroglyphs-extended-a.10": 1704,
  "13460-143FF-egyptian-hieroglyphs-extended-a.11": 1704,
  "13460-143FF-egyptian-hieroglyphs-extended-a.12": 1704,
  "13460-143FF-egyptian-hieroglyphs-extended-a.13": 1704,
  "13460-143FF-egyptian-hieroglyphs-extended-a.14": 1704,
  "13460-143FF-egyptian-hieroglyphs-extended-a.2": 1704,
  "13460-143FF-egyptian-hieroglyphs-extended-a.3": 1704,
  "13460-143FF-egyptian-hieroglyphs-extended-a.4": 1704,
  "13460-143FF-egyptian-hieroglyphs-extended-a.5": 1704,
  "13460-143FF-egyptian-hieroglyphs-extended-a.6": 1704,
  "13460-143FF-egyptian-hieroglyphs-extended-a.7": 1704,
  "13460-143FF-egyptian-hieroglyphs-extended-a.8": 1704,
  "13460-143FF-egyptian-hieroglyphs-extended-a.9": 1704,
  "1400-167F-unified-canadian-aboriginal-syllabics.0": 1704,
  "1400-167F-unified-canadian-aboriginal-syllabics.1": 1704,
  "1400-167F-unified-canadian-aboriginal-syllabics.2": 920,
  "14400-1467F-anatolian-hieroglyphs.0": 1704,
  "14400-1467F-anatolian-hieroglyphs.1": 1704,
  "16800-16A3F-bamum-supplement.0": 1704,
  "16800-16A3F-bamum-supplement.1": 1704,
  "16B00-16B8F-pahawh-hmong": 920,
  "16F00-16F9F-miao": 1080,
  "17000-187FF-tangut.0": 1704,
  "17000-187FF-tangut.1": 1704,
  "17000-187FF-tangut.10": 1704,
  "17000-187FF-tangut.11": 1704,
  "17000-187FF-tangut.12": 1704,
  "17000-187FF-tangut.13": 1704,
  "17000-187FF-tangut.14": 1704,
  "17000-187FF-tangut.15": 1704,
  "17000-187FF-tangut.16": 1704,
  "17000-187FF-tangut.17": 1704,
  "17000-187FF-tangut.18": 1704,
  "17000-187FF-tangut.19": 1704,
  "17000-187FF-tangut.2": 1704,
  "17000-187FF-tangut.20": 1704,
  "17000-187FF-tangut.21": 1704,
  "17000-187FF-tangut.22": 1704,
  "17000-187FF-tangut.23": 1080,
  "17000-187FF-tangut.3": 1704,
  "17000-187FF-tangut.4": 1704,
  "17000-187FF-tangut.5": 1704,
  "17000-187FF-tangut.6": 1704,
  "17000-187FF-tangut.7": 1704,
  "17000-187FF-tangut.8": 1704,
  "17000-187FF-tangut.9": 1704,
  "1780-17FF-khmer": 840,
  "1800-18AF-mongolian": 1152,
  "18800-18AFF-tangut-components.0": 1704,
  "18800-18AFF-tangut-components.1": 1704,
  "18800-18AFF-tangut-components.2": 1704,
  "18B00-18CFF-khitan-small-script.0": 1704,
  "18B00-18CFF-khitan-small-script.1": 1464,
  "1A20-1AAF-tai-tham": 920,
  "1B00-1B7F-balinese": 920,
  "1B000-1B0FF-kana-supplement": 1704,
  "1B170-1B2FF-nushu.0": 1704,
  "1B170-1B2FF-nushu.1": 1000,
  "1BC00-1BC9F-duployan": 1000,
  "1CC00-1CEBF-symbols-for-legacy-computing-supplement.0": 1704,
  "1CC00-1CEBF-symbols-for-legacy-computing-supplement.1": 1704,
  "1CC00-1CEBF-symbols-for-legacy-computing-supplement.2": 1152,
  "1CF00-1CFCF-znamenny-musical-notation": 1312,
  "1D00-1D7F-phonetic-extensions": 920,
  "1D000-1D0FF-byzantine-musical-symbols": 1624,
  "1D100-1D1FF-musical-symbols": 1544,
  "1D400-1D7FF-mathematical-alphanumeric-symbols.0": 1704,
  "1D400-1D7FF-mathematical-alphanumeric-symbols.1": 1704,
  "1D400-1D7FF-mathematical-alphanumeric-symbols.2": 1704,
  "1D400-1D7FF-mathematical-alphanumeric-symbols.3": 1464,
  "1D800-1DAAF-sutton-signwriting.0": 1704,
  "1D800-1DAAF-sutton-signwriting.1": 1704,
  "1D800-1DAAF-sutton-signwriting.2": 1080,
  "1E00-1EFF-latin-extended-additional": 1704,
  "1E800-1E8DF-mende-kikakui": 1464,
  "1EE00-1EEFF-arabic-mathematical-alphabetic-symbols": 1000,
  "1F00-1FFF-greek-extended": 1544,
  "1F100-1F1FF-enclosed-alphanumeric-supplement": 1392,
  "1F300-1F5FF-miscellaneous-symbols-and-pictographs.0": 1704,
  "1F300-1F5FF-miscellaneous-symbols-and-pictographs.1": 1704,
  "1F300-1F5FF-miscellaneous-symbols-and-pictographs.2": 1704,
  "1F680-1F6FF-transport-and-map-symbols": 920,
  "1F700-1F77F-alchemical-symbols": 920,
  "1F800-1F8FF-supplemental-arrows-c": 1152,
  "1F900-1F9FF-supplemental-symbols-and-pictographs": 1704,
  "1FA70-1FAFF-symbols-and-pictographs-extended-a": 840,
  "1FB00-1FBFF-symbols-for-legacy-computing": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.0": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.1": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.10": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.100": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.101": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.102": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.103": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.104": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.105": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.106": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.107": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.108": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.109": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.11": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.110": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.111": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.112": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.113": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.114": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.115": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.116": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.117": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.118": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.119": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.12": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.120": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.121": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.122": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.123": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.124": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.125": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.126": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.127": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.128": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.129": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.13": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.130": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.131": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.132": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.133": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.134": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.135": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.136": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.137": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.138": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.139": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.14": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.140": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.141": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.142": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.143": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.144": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.145": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.146": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.147": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.148": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.149": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.15": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.150": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.151": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.152": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.153": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.154": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.155": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.156": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.157": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.158": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.159": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.16": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.160": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.161": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.162": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.163": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.17": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.18": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.19": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.2": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.20": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.21": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.22": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.23": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.24": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.25": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.26": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.27": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.28": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.29": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.3": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.30": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.31": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.32": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.33": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.34": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.35": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.36": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.37": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.38": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.39": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.4": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.40": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.41": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.42": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.43": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.44": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.45": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.46": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.47": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.48": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.49": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.5": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.50": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.51": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.52": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.53": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.54": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.55": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.56": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.57": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.58": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.59": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.6": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.60": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.61": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.62": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.63": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.64": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.65": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.66": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.67": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.68": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.69": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.7": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.70": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.71": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.72": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.73": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.74": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.75": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.76": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.77": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.78": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.79": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.8": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.80": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.81": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.82": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.83": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.84": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.85": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.86": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.87": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.88": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.89": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.9": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.90": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.91": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.92": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.93": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.94": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.95": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.96": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.97": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.98": 1704,
  "20000-2A6DF-cjk-unified-ideographs-extension-b.99": 1704,
  "2190-21FF-arrows": 840,
  "2200-22FF-mathematical-operators": 1704,
  "2300-23FF-miscellaneous-technical": 1704,
  "2460-24FF-enclosed-alphanumerics": 1152,
  "2500-257F-box-drawing": 920,
  "2600-26FF-miscellaneous-symbols": 1704,
  "2700-27BF-dingbats": 1312,
  "2800-28FF-braille-patterns": 1704,
  "2900-297F-supplemental-arrows-b": 920,
  "2980-29FF-miscellaneous-mathematical-symbols-b": 920,
  "2A00-2AFF-supplemental-mathematical-operators": 1704,
  "2A700-2B73F-cjk-unified-ideographs-extension-c.0": 1704,
  "2A700-2B73F-cjk-unified-ideographs-extension-c.1": 1704,
  "2A700-2B73F-cjk-unified-ideographs-extension-c.10": 1704,
  "2A700-2B73F-cjk-unified-ideographs-extension-c.11": 1704,
  "2A700-2B73F-cjk-unified-ideographs-extension-c.12": 1704,
  "2A700-2B73F-cjk-unified-ideographs-extension-c.13": 1704,
  "2A700-2B73F-cjk-unified-ideographs-extension-c.14": 1704,
  "2A700-2B73F-cjk-unified-ideographs-extension-c.15": 1704,
  "2A700-2B73F-cjk-unified-ideographs-extension-c.2": 1704,
  "2A700-2B73F-cjk-unified-ideographs-extension-c.3": 1704,
  "2A700-2B73F-cjk-unified-ideographs-extension-c.4": 1704,
  "2A700-2B73F-cjk-unified-ideographs-extension-c.5": 1704,
  "2A700-2B73F-cjk-unified-ideographs-extension-c.6": 1704,
  "2A700-2B73F-cjk-unified-ideographs-extension-c.7": 1704,
  "2A700-2B73F-cjk-unified-ideographs-extension-c.8": 1704,
  "2A700-2B73F-cjk-unified-ideographs-extension-c.9": 1704,
  "2B00-2BFF-miscellaneous-symbols-and-arrows": 1720,
  "2B740-2B81F-cjk-unified-ideographs-extension-d": 1544,
  "2B820-2CEAF-cjk-unified-ideographs-extension-e.0": 1704,
  "2B820-2CEAF-cjk-unified-ideographs-extension-e.1": 1704,
  "2B820-2CEAF-cjk-unified-ideographs-extension-e.10": 1704,
  "2B820-2CEAF-cjk-unified-ideographs-extension-e.11": 1704,
  "2B820-2CEAF-cjk-unified-ideographs-extension-e.12": 1704,
  "2B820-2CEAF-cjk-unified-ideographs-extension-e.13": 1704,
  "2B820-2CEAF-cjk-unified-ideographs-extension-e.14": 1704,
  "2B820-2CEAF-cjk-unified-ideographs-extension-e.15": 1704,
  "2B820-2CEAF-cjk-unified-ideographs-extension-e.16": 1704,
  "2B820-2CEAF-cjk-unified-ideographs-extension-e.17": 1704,
  "2B820-2CEAF-cjk-unified-ideographs-extension-e.18": 1704,
  "2B820-2CEAF-cjk-unified-ideographs-extension-e.19": 1704,
  "2B820-2CEAF-cjk-unified-ideographs-extension-e.2": 1704,
  "2B820-2CEAF-cjk-unified-ideographs-extension-e.20": 1704,
  "2B820-2CEAF-cjk-unified-ideographs-extension-e.21": 1704,
  "2B820-2CEAF-cjk-unified-ideographs-extension-e.3": 1704,
  "2B820-2CEAF-cjk-unified-ideographs-extension-e.4": 1704,
  "2B820-2CEAF-cjk-unified-ideographs-extension-e.5": 1704,
  "2B820-2CEAF-cjk-unified-ideographs-extension-e.6": 1704,
  "2B820-2CEAF-cjk-unified-ideographs-extension-e.7": 1704,
  "2B820-2CEAF-cjk-unified-ideographs-extension-e.8": 1704,
  "2B820-2CEAF-cjk-unified-ideographs-extension-e.9": 1704,
  "2C80-2CFF-coptic": 920,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.0": 1704,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.1": 1704,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.10": 1704,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.11": 1704,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.12": 1704,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.13": 1704,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.14": 1704,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.15": 1704,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.16": 1704,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.17": 1704,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.18": 1704,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.19": 1704,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.2": 1704,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.20": 1704,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.21": 1704,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.22": 1704,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.23": 1704,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.24": 1704,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.25": 1704,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.26": 1704,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.27": 1704,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.28": 1312,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.3": 1704,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.4": 1704,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.5": 1704,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.6": 1704,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.7": 1704,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.8": 1704,
  "2CEB0-2EBEF-cjk-unified-ideographs-extension-f.9": 1704,
  "2E80-2EFF-cjk-radicals-supplement": 840,
  "2EBF0-2EE5F-cjk-unified-ideographs-extension-i.0": 1704,
  "2EBF0-2EE5F-cjk-unified-ideographs-extension-i.1": 1704,
  "2F00-2FDF-kangxi-radicals": 1464,
  "2F800-2FA1F-cjk-compatibility-ideographs-supplement.0": 1704,
  "2F800-2FA1F-cjk-compatibility-ideographs-supplement.1": 1704,
  "30000-3134F-cjk-unified-ideographs-extension-g.0": 1704,
  "30000-3134F-cjk-unified-ideographs-extension-g.1": 1704,
  "30000-3134F-cjk-unified-ideographs-extension-g.10": 1704,
  "30000-3134F-cjk-unified-ideographs-extension-g.11": 1704,
  "30000-3134F-cjk-unified-ideographs-extension-g.12": 1704,
  "30000-3134F-cjk-unified-ideographs-extension-g.13": 1704,
  "30000-3134F-cjk-unified-ideographs-extension-g.14": 1704,
  "30000-3134F-cjk-unified-ideographs-extension-g.15": 1704,
  "30000-3134F-cjk-unified-ideographs-extension-g.16": 1704,
  "30000-3134F-cjk-unified-ideographs-extension-g.17": 1704,
  "30000-3134F-cjk-unified-ideographs-extension-g.18": 1704,
  "30000-3134F-cjk-unified-ideographs-extension-g.2": 1704,
  "30000-3134F-cjk-unified-ideographs-extension-g.3": 1704,
  "30000-3134F-cjk-unified-ideographs-extension-g.4": 1704,
  "30000-3134F-cjk-unified-ideographs-extension-g.5": 1704,
  "30000-3134F-cjk-unified-ideographs-extension-g.6": 1704,
  "30000-3134F-cjk-unified-ideographs-extension-g.7": 1704,
  "30000-3134F-cjk-unified-ideographs-extension-g.8": 1704,
  "30000-3134F-cjk-unified-ideographs-extension-g.9": 1704,
  "31350-323AF-cjk-unified-ideographs-extension-h.0": 1704,
  "31350-323AF-cjk-unified-ideographs-extension-h.1": 1704,
  "31350-323AF-cjk-unified-ideographs-extension-h.10": 1704,
  "31350-323AF-cjk-unified-ideographs-extension-h.11": 1704,
  "31350-323AF-cjk-unified-ideographs-extension-h.12": 1704,
  "31350-323AF-cjk-unified-ideographs-extension-h.13": 1704,
  "31350-323AF-cjk-unified-ideographs-extension-h.14": 1704,
  "31350-323AF-cjk-unified-ideographs-extension-h.15": 1704,
  "31350-323AF-cjk-unified-ideographs-extension-h.2": 1704,
  "31350-323AF-cjk-unified-ideographs-extension-h.3": 1704,
  "31350-323AF-cjk-unified-ideographs-extension-h.4": 1704,
  "31350-323AF-cjk-unified-ideographs-extension-h.5": 1704,
  "31350-323AF-cjk-unified-ideographs-extension-h.6": 1704,
  "31350-323AF-cjk-unified-ideographs-extension-h.7": 1704,
  "31350-323AF-cjk-unified-ideographs-extension-h.8": 1704,
  "31350-323AF-cjk-unified-ideographs-extension-h.9": 1704,
  "3200-32FF-enclosed-cjk-letters-and-months": 1720,
  "3300-33FF-cjk-compatibility": 1704,
  "3400-4DBF-cjk-unified-ideographs-extension-a.0": 1704,
  "3400-4DBF-cjk-unified-ideographs-extension-a.1": 1704,
  "3400-4DBF-cjk-unified-ideographs-extension-a.10": 1704,
  "3400-4DBF-cjk-unified-ideographs-extension-a.11": 1704,
  "3400-4DBF-cjk-unified-ideographs-extension-a.12": 1704,
  "3400-4DBF-cjk-unified-ideographs-extension-a.13": 1704,
  "3400-4DBF-cjk-unified-ideographs-extension-a.14": 1704,
  "3400-4DBF-cjk-unified-ideographs-extension-a.15": 1704,
  "3400-4DBF-cjk-unified-ideographs-extension-a.16": 1704,
  "3400-4DBF-cjk-unified-ideographs-extension-a.17": 1704,
  "3400-4DBF-cjk-unified-ideographs-extension-a.18": 1704,
  "3400-4DBF-cjk-unified-ideographs-extension-a.19": 1704,
  "3400-4DBF-cjk-unified-ideographs-extension-a.2": 1704,
  "3400-4DBF-cjk-unified-ideographs-extension-a.20": 1704,
  "3400-4DBF-cjk-unified-ideographs-extension-a.21": 1704,
  "3400-4DBF-cjk-unified-ideographs-extension-a.22": 1704,
  "3400-4DBF-cjk-unified-ideographs-extension-a.23": 1704,
  "3400-4DBF-cjk-unified-ideographs-extension-a.24": 1704,
  "3400-4DBF-cjk-unified-ideographs-extension-a.3": 1704,
  "3400-4DBF-cjk-unified-ideographs-extension-a.4": 1704,
  "3400-4DBF-cjk-unified-ideographs-extension-a.5": 1704,
  "3400-4DBF-cjk-unified-ideographs-extension-a.6": 1704,
  "3400-4DBF-cjk-unified-ideographs-extension-a.7": 1704,
  "3400-4DBF-cjk-unified-ideographs-extension-a.8": 1704,
  "3400-4DBF-cjk-unified-ideographs-extension-a.9": 1704,
  "4E00-9FFF-cjk-unified-ideographs.0": 1704,
  "4E00-9FFF-cjk-unified-ideographs.1": 1704,
  "4E00-9FFF-cjk-unified-ideographs.10": 1704,
  "4E00-9FFF-cjk-unified-ideographs.11": 1704,
  "4E00-9FFF-cjk-unified-ideographs.12": 1704,
  "4E00-9FFF-cjk-unified-ideographs.13": 1704,
  "4E00-9FFF-cjk-unified-ideographs.14": 1704,
  "4E00-9FFF-cjk-unified-ideographs.15": 1704,
  "4E00-9FFF-cjk-unified-ideographs.16": 1704,
  "4E00-9FFF-cjk-unified-ideographs.17": 1704,
  "4E00-9FFF-cjk-unified-ideographs.18": 1704,
  "4E00-9FFF-cjk-unified-ideographs.19": 1704,
  "4E00-9FFF-cjk-unified-ideographs.2": 1704,
  "4E00-9FFF-cjk-unified-ideographs.20": 1704,
  "4E00-9FFF-cjk-unified-ideographs.21": 1704,
  "4E00-9FFF-cjk-unified-ideographs.22": 1704,
  "4E00-9FFF-cjk-unified-ideographs.23": 1704,
  "4E00-9FFF-cjk-unified-ideographs.24": 1704,
  "4E00-9FFF-cjk-unified-ideographs.25": 1704,
  "4E00-9FFF-cjk-unified-ideographs.26": 1704,
  "4E00-9FFF-cjk-unified-ideographs.27": 1704,
  "4E00-9FFF-cjk-unified-ideographs.28": 1704,
  "4E00-9FFF-cjk-unified-ideographs.29": 1704,
  "4E00-9FFF-cjk-unified-ideographs.3": 1704,
  "4E00-9FFF-cjk-unified-ideographs.30": 1704,
  "4E00-9FFF-cjk-unified-ideographs.31": 1704,
  "4E00-9FFF-cjk-unified-ideographs.32": 1704,
  "4E00-9FFF-cjk-unified-ideographs.33": 1704,
  "4E00-9FFF-cjk-unified-ideographs.34": 1704,
  "4E00-9FFF-cjk-unified-ideographs.35": 1704,
  "4E00-9FFF-cjk-unified-ideographs.36": 1704,
  "4E00-9FFF-cjk-unified-ideographs.37": 1704,
  "4E00-9FFF-cjk-unified-ideographs.38": 1704,
  "4E00-9FFF-cjk-unified-ideographs.39": 1704,
  "4E00-9FFF-cjk-unified-ideographs.4": 1704,
  "4E00-9FFF-cjk-unified-ideographs.40": 1704,
  "4E00-9FFF-cjk-unified-ideographs.41": 1704,
  "4E00-9FFF-cjk-unified-ideographs.42": 1704,
  "4E00-9FFF-cjk-unified-ideographs.43": 1704,
  "4E00-9FFF-cjk-unified-ideographs.44": 1704,
  "4E00-9FFF-cjk-unified-ideographs.45": 1704,
  "4E00-9FFF-cjk-unified-ideographs.46": 1704,
  "4E00-9FFF-cjk-unified-ideographs.47": 1704,
  "4E00-9FFF-cjk-unified-ideographs.48": 1704,
  "4E00-9FFF-cjk-unified-ideographs.49": 1704,
  "4E00-9FFF-cjk-unified-ideographs.5": 1704,
  "4E00-9FFF-cjk-unified-ideographs.50": 1704,
  "4E00-9FFF-cjk-unified-ideographs.51": 1704,
  "4E00-9FFF-cjk-unified-ideographs.52": 1704,
  "4E00-9FFF-cjk-unified-ideographs.53": 1704,
  "4E00-9FFF-cjk-unified-ideographs.54": 1704,
  "4E00-9FFF-cjk-unified-ideographs.55": 1704,
  "4E00-9FFF-cjk-unified-ideographs.56": 1704,
  "4E00-9FFF-cjk-unified-ideographs.57": 1704,
  "4E00-9FFF-cjk-unified-ideographs.58": 1704,
  "4E00-9FFF-cjk-unified-ideographs.59": 1704,
  "4E00-9FFF-cjk-unified-ideographs.6": 1704,
  "4E00-9FFF-cjk-unified-ideographs.60": 1704,
  "4E00-9FFF-cjk-unified-ideographs.61": 1704,
  "4E00-9FFF-cjk-unified-ideographs.62": 1704,
  "4E00-9FFF-cjk-unified-ideographs.63": 1704,
  "4E00-9FFF-cjk-unified-ideographs.64": 1704,
  "4E00-9FFF-cjk-unified-ideographs.65": 1704,
  "4E00-9FFF-cjk-unified-ideographs.66": 1704,
  "4E00-9FFF-cjk-unified-ideographs.67": 1704,
  "4E00-9FFF-cjk-unified-ideographs.68": 1704,
  "4E00-9FFF-cjk-unified-ideographs.69": 1704,
  "4E00-9FFF-cjk-unified-ideographs.7": 1704,
  "4E00-9FFF-cjk-unified-ideographs.70": 1704,
  "4E00-9FFF-cjk-unified-ideographs.71": 1704,
  "4E00-9FFF-cjk-unified-ideographs.72": 1704,
  "4E00-9FFF-cjk-unified-ideographs.73": 1704,
  "4E00-9FFF-cjk-unified-ideographs.74": 1704,
  "4E00-9FFF-cjk-unified-ideographs.75": 1704,
  "4E00-9FFF-cjk-unified-ideographs.76": 1704,
  "4E00-9FFF-cjk-unified-ideographs.77": 1704,
  "4E00-9FFF-cjk-unified-ideographs.78": 1704,
  "4E00-9FFF-cjk-unified-ideographs.79": 1704,
  "4E00-9FFF-cjk-unified-ideographs.8": 1704,
  "4E00-9FFF-cjk-unified-ideographs.80": 1312,
  "4E00-9FFF-cjk-unified-ideographs.9": 1704,
  "A000-A48F-yi-syllables.0": 1704,
  "A000-A48F-yi-syllables.1": 1704,
  "A000-A48F-yi-syllables.2": 1704,
  "A000-A48F-yi-syllables.3": 1704,
  "A000-A48F-yi-syllables.4": 920,
  "A500-A63F-vai.0": 1704,
  "A720-A7FF-latin-extended-d": 1392,
  "AC00-D7AF-hangul-syllables.0": 1704,
  "AC00-D7AF-hangul-syllables.1": 1704,
  "AC00-D7AF-hangul-syllables.10": 1704,
  "AC00-D7AF-hangul-syllables.11": 1704,
  "AC00-D7AF-hangul-syllables.12": 1704,
  "AC00-D7AF-hangul-syllables.13": 1704,
  "AC00-D7AF-hangul-syllables.14": 1704,
  "AC00-D7AF-hangul-syllables.15": 1704,
  "AC00-D7AF-hangul-syllables.16": 1704,
  "AC00-D7AF-hangul-syllables.17": 1704,
  "AC00-D7AF-hangul-syllables.18": 1704,
  "AC00-D7AF-hangul-syllables.19": 1704,
  "AC00-D7AF-hangul-syllables.2": 1704,
  "AC00-D7AF-hangul-syllables.20": 1704,
  "AC00-D7AF-hangul-syllables.21": 1704,
  "AC00-D7AF-hangul-syllables.22": 1704,
  "AC00-D7AF-hangul-syllables.23": 1704,
  "AC00-D7AF-hangul-syllables.24": 1704,
  "AC00-D7AF-hangul-syllables.25": 1704,
  "AC00-D7AF-hangul-syllables.26": 1704,
  "AC00-D7AF-hangul-syllables.27": 1704,
  "AC00-D7AF-hangul-syllables.28": 1704,
  "AC00-D7AF-hangul-syllables.29": 1704,
  "AC00-D7AF-hangul-syllables.3": 1704,
  "AC00-D7AF-hangul-syllables.30": 1704,
  "AC00-D7AF-hangul-syllables.31": 1704,
  "AC00-D7AF-hangul-syllables.32": 1704,
  "AC00-D7AF-hangul-syllables.33": 1704,
  "AC00-D7AF-hangul-syllables.34": 1704,
  "AC00-D7AF-hangul-syllables.35": 1704,
  "AC00-D7AF-hangul-syllables.36": 1704,
  "AC00-D7AF-hangul-syllables.37": 1704,
  "AC00-D7AF-hangul-syllables.38": 1704,
  "AC00-D7AF-hangul-syllables.39": 1704,
  "AC00-D7AF-hangul-syllables.4": 1704,
  "AC00-D7AF-hangul-syllables.40": 1704,
  "AC00-D7AF-hangul-syllables.41": 1704,
  "AC00-D7AF-hangul-syllables.42": 1704,
  "AC00-D7AF-hangul-syllables.5": 1704,
  "AC00-D7AF-hangul-syllables.6": 1704,
  "AC00-D7AF-hangul-syllables.7": 1704,
  "AC00-D7AF-hangul-syllables.8": 1704,
  "AC00-D7AF-hangul-syllables.9": 1704,
  "E0100-E01EF-variation-selectors-supplement": 1624,
  "F900-FAFF-cjk-compatibility-ideographs.0": 1704,
  "F900-FAFF-cjk-compatibility-ideographs.1": 1464,
  "FB50-FDFF-arabic-presentation-forms-a.0": 1704,
  "FB50-FDFF-arabic-presentation-forms-a.1": 1704,
  "FB50-FDFF-arabic-presentation-forms-a.2": 840,
  "FE70-FEFF-arabic-presentation-forms-b": 1000,
  "FF00-FFEF-halfwidth-and-fullwidth-forms": 1544,
};

/** Effective capture height for a fixture: the override when one exists,
 *  otherwise the 768 px default. */
function captureHeightFor(name: string): number {
  return FIXTURE_HEIGHT_OVERRIDES[name] ?? HEIGHT;
}

/** Human-friendly compact wall-clock duration (e.g. `12s`, `4m32s`,
 *  `1h12m`). Used in the per-result progress indicator so the elapsed /
 *  ETA pair stays narrow next to the fixture name. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}m${seconds.toString().padStart(2, "0")}s`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${totalHours}h${minutes.toString().padStart(2, "0")}m`;
}
// Pass criterion, AA detector, and tile metrics are shared with the simpler
// runner via tests/compare-pngs.ts (DM-383). PASS_THRESHOLD_NON_AA_PIXELS,
// TILE_PX, and SIGNIFICANT_PIXEL_DIST are imported above.

/**
 * Tests intentionally deferred because the feature has no SVG equivalent or
 * requires a future refactor tracked by a dedicated ticket. Skipped tests
 * still render (so the artifacts exist for manual inspection) but don't count
 * against the pass/fail tally.
 */
const SKIP_TESTS: Record<string, string> = {
  "22-backdrop-filter": "SVG has no backdrop-filter equivalent in img-rendered SVG",
  "17-gradient-conic": "SVG 2 conic-gradient is not shipped in browsers",
  "17-gradient-repeating": "edge cases in repeating gradient stop spacing — low priority",
  "21-transform-3d": "CSS transforms deferred in SK-435 (layout-coord refactor needed)",
  "21-deep-transform-3d-preserve": "preserve-3d cube composition deferred in SK-435 (same territory as 21-transform-3d)",
  "27-page": "@page rules are print-media only, not relevant to static screen capture",
  // DM-725: `-webkit-box-reflect` paints a mirrored copy of the element box
  // below / above / left / right of itself. SVG has no direct equivalent —
  // would need a `<filter>` chain with feGaussianBlur + feImage or a
  // duplicated subtree with transform-flip + opacity gradient. Author note
  // says "skip for now".
  "niche-webkit-box-reflect": "DM-725: -webkit-box-reflect has no direct SVG equivalent; user-flagged for skip until we ship a duplicated-subtree + gradient-mask approach",
};

/**
 * Tests whose remaining diff vs Chrome is below the bar for a real fidelity
 * bug — typically text-antialiasing scatter, sub-pixel layout shifts, or
 * minor glyph-shape differences that the diff harness still picks up as
 * regions but a human reviewer has signed off as "looks correct". Entries
 * here count as PASS in the suite summary; the diff regions are still
 * recorded so a regression that breaks something NEW shows up in the
 * runner's region count. The value is a one-line justification — usually
 * the ticket id where the rendering was reviewed.
 */
const ACCEPTED_DIFFS: Record<string, string> = {
  // DM-1019: Supplemental Arrows-C (U+1F800–1F8FF) — the arrows render via the
  // primary-`.notdef` / fallback chain; residual diff is glyph-shape /
  // antialiasing scatter on arrow forms the macOS fallback fonts draw slightly
  // differently from Chrome's painted output. Reviewed visually; accepted as a
  // stable baseline per maintainer.
  "1F800-1F8FF-supplemental-arrows-c": "DM-1019: arrows render; residual diff is fallback arrow-glyph shape / antialiasing scatter — accepted baseline",
  // DM-1027: lone combining diacritical marks (U+0300–036F) now capture +
  // render (the zero-advance-width cells were being dropped by the capture's
  // zero-sized-element filter; fixed so a zero-WIDTH element with inked text +
  // non-zero height is kept). Expected vs actual are visually identical; the
  // residual ~0.04% is antialiasing scatter on the thin 1–2px mark strokes.
  "0300-036F-combining-diacritical-marks": "DM-1027: marks now render at Chrome's positions; residual is sub-pixel antialiasing scatter on the thin marks — accepted baseline",
  // DM-1039: writing-mode + mixed-scripts + tate-chu-yoko. All seven vertical
  // blocks render structurally correct after DM-1024 (per-glyph baseline/ascent
  // drift) and DM-1032 (tate-chu-yoko `text-combine-upright` digit cells, now
  // zero-diff). The remaining ~0.13% / ~21 regions is text-rasterization scatter
  // on the dense upright CJK ideographs: a per-cell ink-bbox probe (本/文/縦/書)
  // showed expected and actual ink land at the SAME position (e.g. 本/縦 both
  // trim to +3+2), so there is no baseline/centering offset to fix — the diff is
  // uniform faint glyph-edge ghosting (Chrome's Skia raster vs our glyph
  // outlines), the same antialiasing class the rest of the suite carries, just
  // multiplied by the many stroke-edges of CJK so the region COUNT (not the area)
  // trips the verdict. Reviewed visually + quantitatively; accepted baseline.
  "20-deep-writing-mode-mixed": "DM-1039: vertical writing-mode + tate-chu-yoko render correct (DM-1024 + DM-1032); ink positions match Chrome per-glyph, residual is CJK-glyph antialiasing scatter — accepted baseline",
  // DM-1025: Misc Symbols (U+2600-26FF) — the dominant diff (zodiac signs + ☔
  // etc. wrongly painted as color emoji) is fixed: the capture now probes
  // Chrome's actual presentation per font (the fixture lists "Apple Symbols"
  // first, so Chrome paints the monochrome text glyph, not the color emoji).
  // Residual ~0.10% is minor per-symbol glyph-shape on a handful of cells
  // (e.g. ☂ U+2602, the dice faces) where the macOS fallback font draws a
  // slightly different monochrome glyph than Chrome — a per-codepoint routing
  // nuance, not the emoji-presentation bug. Accepted as a stable baseline.
  "2600-26FF-miscellaneous-symbols": "DM-1025: emoji-vs-text presentation fixed (1.32% -> 0.10%); residual is minor monochrome glyph-shape on a few symbols — accepted baseline",
  // DM-774: paint-order test renders the seven nested layers in the correct
  // back-to-front order with correct colors / geometry; the residual diff is
  // text antialiasing + arrow-glyph substitution in the header / caption
  // paragraphs only. Reviewed visually; accepted as a stable baseline.
  "13-deep-stacking-paint-order": "DM-774: text antialiasing + arrow-glyph substitution only; geometry / paint order are correct",
  // DM-771: <select> single-choice / optgroup / size=N listbox / multiple
  // listbox all render with correct UA chrome (chevrons, item rows,
  // selected-row highlight). Residual diff is text-baseline antialiasing
  // scatter on the option rows + the closed-dropdown's chevron column.
  // Reviewed visually; accepted.
  "06-forms-select": "DM-771: <select> UA chrome correct; residual diff is text-baseline antialiasing scatter on option rows",
  // DM-772: overflow visible / hidden / scroll / auto / clip / x/y test —
  // all six boxes paint their content with the correct clip behavior.
  // Residual diff is text-baseline antialiasing scatter inside each box.
  // Reviewed visually; accepted.
  "25-overflow-values": "DM-772: clip behavior correct on all six boxes; residual diff is text-baseline antialiasing scatter",
  // DM-760: the original "text covered" issue (a gray rectangle obscuring
  // the middle of the Pass-criteria paragraph) is fixed by the DM-721
  // inline `box-decoration-break` work + DM-781 height override — the
  // paragraph + inline `<code>` chips now wrap and paint correctly.
  // Residual diff is text-baseline antialiasing on the paragraph + a
  // sub-pixel padding shift on the wrapping `<code>:user-invalid</code>`
  // span. Reviewed visually; accepted.
  "10-deep-form-state-pseudos": "DM-760: paragraph text + inline code chips render correctly; residual diff is antialiasing + sub-pixel wrap padding",
  // DM-757: SVG markers + curve with directional marker + stroke
  // dasharray / dashoffset / linecap / linejoin / miterlimit + paint-order
  // + vector-effect: non-scaling-stroke + nested <svg> viewBox all render
  // correctly to the eye. Residual diff is text-baseline antialiasing on
  // the Pass-criteria paragraph and inline `<code>` annotations only.
  // Reviewed visually; accepted.
  "07-deep-svg-markers-strokes": "DM-757: SVG marker / stroke / paint-order rendering correct; residual diff is text antialiasing on the caption paragraph",
  // DM-763: @container scroll-state(snapped / stuck) styling test —
  // sticky headers, snap-target highlights, and section colorations all
  // render correctly. Residual diff is text antialiasing on labels.
  "niche-scroll-state-queries": "DM-763: scroll-state container queries render correctly; residual diff is text antialiasing",
  // DM-748: Basic <table> with <caption> / <thead> / <tbody> / <tfoot> /
  // <th scope=…>. All grid lines, header bolding, and column-scoped header
  // emphasis paint correctly. Residual diff is text antialiasing inside
  // the table cells.
  "04-table-basic": "DM-748: <table> grid + caption + scope cells render correctly; residual diff is text antialiasing",
  // DM-744: `font-stretch` keyword + percentage scale. SF Pro's stretch
  // axis is driven correctly by the captured font-variation-settings; the
  // Hamburgefontsiv samples render at the requested stretches. Residual
  // diff is text antialiasing on the wide-axis variants.
  "20-font-stretch": "DM-744: font-stretch keyword / percentage map correctly; residual diff is text antialiasing on the variant samples",
  // DM-743: <meta> tags page — purely informational; no visible boxes /
  // shapes / images. Residual diff is text antialiasing on the descriptor
  // labels and their values.
  "01-structure-meta": "DM-743: meta-tag fixture renders correctly; residual diff is text antialiasing on the descriptor labels",
  // DM-742: `scrollbar-gutter: stable / both-edges` reserve-the-scrollbar
  // pattern. The reserved-gutter padding shows on the static layout
  // correctly (boxes with no overflow still reserve the scrollbar gutter,
  // boxes with overflow paint content inside the gutter). Residual diff
  // is text antialiasing inside the labeled boxes.
  "25-scrollbar-gutter": "DM-742: scrollbar-gutter reserve behavior correct; residual diff is text antialiasing inside the demo boxes",
  // DM-735: font-family generics test — serif / sans-serif / monospace /
  // cursive / fantasy / system-ui / ui-* / math / emoji / fangsong samples
  // resolve to the right system font on macOS. Fallback stack chain ("DoesNotExist",
  // Georgia, "Times New Roman", serif) demonstrates the chain falls through
  // to Georgia / serif as expected. Residual diff is text antialiasing.
  "20-font-family": "DM-735: font-family generics + fallback chain resolve correctly; residual diff is text antialiasing",
  // DM-734: line-height / letter-spacing / word-spacing keyword + length +
  // percentage + unitless. Sample paragraphs render with correct spacing
  // and the inline labels show the active value. Residual diff is text
  // antialiasing on the labels and demonstrators.
  "20-text-line-spacing": "DM-734: line-height / letter-spacing / word-spacing values render correctly; residual diff is text antialiasing",
  // DM-733: text-align (left / right / center / justify / start / end with
  // RTL + last-line keywords) aligns correctly to spec; minor sub-pixel
  // shifting on the justify variant + RTL start-as-right diff is below the
  // bar for a fidelity bug. User-signed-off as a baseline.
  "20-text-align": "DM-733: text-align variants align correctly; residual diff is sub-pixel shifting on justify + RTL labels",
};

interface TestResult {
  name: string;
  category: string;
  /** Count of pixels that differ between expected and actual AND are not
   *  classified as glyph anti-aliasing by the Yee detector. Diagnostic only;
   *  pass/fail uses `regionCount` (DM-715). */
  nonAaPixels: number;
  /** Same count expressed as a fraction of total image pixels (diagnostic). */
  nonAaPixelPct: number;
  diffPct: number;
  /** Image-wide fraction of pixels with >SIGNIFICANT_PIXEL_DIST distance. */
  sigPixelPct: number;
  /** Worst tile's average color distance as a %. */
  worstTilePct: number;
  /** Worst tile's fraction of pixels with >SIGNIFICANT_PIXEL_DIST distance. */
  worstTileSignificantPct: number;
  /** Rect of the worst tile (x, y, w, h) in the image. */
  worstTileRect?: { x: number; y: number; w: number; h: number };
  /** DM-715: connected-components region count on the dilated non-AA-diff
   *  mask. Pass requires 0. */
  regionCount: number;
  /** Total ORIGINAL non-AA-diff pixel area within surviving regions. */
  totalChangedArea: number;
  /** Max per-pixel normalized color distance % inside any surviving region. */
  maxRegionSeverity: number;
  /** Non-AA-diff pixels that fell into culled (sub-`MIN_REGION_AREA`)
   *  components; treated as scatter and ignored by pass/fail. */
  scatteredPixels: number;
  /** Pixels absorbed by the neighborhood-tolerant shift filter. */
  shiftedPixels: number;
  /** Connected components that passed the area floor but were culled for
   *  low high-severity fraction (typical of font-substitution / glyph-
   *  shape differences). They aren't real structural change. */
  shiftyRegionCount: number;
  shiftyRegionArea: number;
  /** Surviving area as a percentage of the image (more intuitive than the
   *  raw pixel count). */
  coveragePct: number;
  /** Qualitative tier — `clean`/`trivial`/`minor`/`moderate`/`major`. */
  verdict: DiffVerdict;
  /** Per-region breakdown (top 32 by area). */
  regions: Array<{ area: number; maxSeverity: number; highSevFraction: number; x: number; y: number; w: number; h: number }>;
  pass: boolean;
  skipped?: boolean;
  skipReason?: string;
  /** When set, the test is in `ACCEPTED_DIFFS` and counts as PASS despite
   *  non-zero `regionCount`. Carries the user's justification so the suite
   *  summary can surface it. */
  acceptedReason?: string;
  bodyBg: string;
  error?: string;
  warnings?: Array<{ selector: string; feature: string; detail: string }>;
}


function categoryOf(name: string): string {
  // Subdir-prefixed names (e.g. `niche-foo`) take their subdir as the
  // category. DM-714: added 19 fixtures under `external/html-test/niche/`
  // for experimental/Chrome-only CSS coverage; bucketed separately so the
  // category breakdown shows their pass rate next to the spec-bucket tests.
  // Subdirectory names must start with a letter so they don't collide with
  // the digit-prefixed spec buckets (`14-float-*` etc). Match only the
  // FIRST hyphen-bounded segment so `niche-text-box-trim` lands in the
  // `niche` bucket rather than `niche-text-box`.
  const sub = /^([a-z][a-z0-9]*)-/.exec(name);
  if (sub != null) return sub[1];
  const m = /^(\d+)-([a-z]+)/.exec(name);
  if (m != null) return `${m[1]}-${m[2]}`;
  return "other";
}

/** DM-714: walk HTML_TEST_DIR recursively. Returns relative paths with `/`
 *  separator (e.g. `niche/foo.html`). Subdirs whose name starts with `.` or
 *  `_` are skipped; everything else under the root is walked. */
function walkHtmlFiles(rootDir: string): string[] {
  const out: string[] = [];
  function visit(dir: string, prefix: string): void {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name.startsWith(".") || name.startsWith("_")) continue;
      const fullPath = resolve(dir, name);
      const relPath = prefix === "" ? name : `${prefix}/${name}`;
      let isDir = false;
      try { isDir = statSync(fullPath).isDirectory(); } catch { continue; }
      if (isDir) {
        visit(fullPath, relPath);
      } else if (name.endsWith(".html") && relPath !== "index.html") {
        out.push(relPath);
      }
    }
  }
  visit(rootDir, "");
  return out.sort();
}

interface HtmlTestWorker {
  context: BrowserContext;
  page: Page;
}

// DM-1006: one comparePage shared across all workers. The N-workers-each-
// owning-their-own-comparePage approach burned ~80 MB of Chromium memory
// per worker for a resource that's idle most of the time (each comparePngs
// call takes ~100 ms; with 2 workers, the page sits unused 99% of the
// time). Serialise the compare calls with a simple chain-promise mutex —
// throughput stays within 10% of the prior parallel-compare setup since
// the per-worker render work (the actual bottleneck) keeps running while
// one worker holds the compare lock.
let sharedComparePage: Page | null = null;
let compareMutex: Promise<void> = Promise.resolve();
async function withCompareLock<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  if (sharedComparePage == null) {
    throw new Error("withCompareLock called before sharedComparePage was initialised");
  }
  const prev = compareMutex;
  let release: () => void = () => {};
  compareMutex = new Promise<void>((resolve) => { release = resolve; });
  await prev;
  try {
    return await fn(sharedComparePage);
  } finally {
    release();
  }
}

async function runOneHtmlTest(file: string, w: HtmlTestWorker): Promise<TestResult> {
  // DM-714: `file` is a relative path under HTML_TEST_DIR (e.g. `01-foo.html`
  // or `niche/foo.html`). Flatten subdir separators to `-` so the output
  // PNGs and the visible "name" in results live at the top of OUTPUT_DIR;
  // `srcPath` still resolves correctly through the un-flattened path.
  const name = file.replace(/\.html$/, "").replace(/\//g, "-");
  const srcPath = resolve(HTML_TEST_DIR, file);
  const expectedPath = resolve(OUTPUT_DIR, `${name}-expected.png`);
  const actualPath = resolve(OUTPUT_DIR, `${name}-actual.png`);
  const diffPath = resolve(OUTPUT_DIR, `${name}-diff.png`);
  const svgPath = resolve(OUTPUT_DIR, `${name}.svg`);

  let nonAaPixels = Number.MAX_SAFE_INTEGER;
  let nonAaPixelPct = 100;
  let diffPct = 100;
  let sigPixelPct = 100;
  let worstTilePct = 100;
  let worstTileSignificantPct = 100;
  let worstTileRect: { x: number; y: number; w: number; h: number } | undefined;
  let regionCount = Number.MAX_SAFE_INTEGER;
  let totalChangedArea = 0;
  let maxRegionSeverity = 0;
  let scatteredPixels = 0;
  let shiftedPixels = 0;
  let shiftyRegionCount = 0;
  let shiftyRegionArea = 0;
  let coveragePct = 100;
  let verdict: DiffVerdict = "major";
  let regions: Array<{ area: number; maxSeverity: number; highSevFraction: number; x: number; y: number; w: number; h: number }> = [];
  let bodyBg = "#ffffff";
  let err: string | undefined;
  let capWarnings: Array<{ selector: string; feature: string; detail: string }> = [];

  // DM-1004: when RENDER_SKIPPED=0 and the fixture is in SKIP_TESTS, bail
  // before any rendering work. Saves ~3–5 s per skipped fixture on batch
  // sweeps where the review UI's artifacts aren't being inspected. The
  // result is shaped like the slow-path "skipped" output (`pass: true,
  // skipped: true, ...zero-metric defaults`) so downstream counts /
  // categorisation behave identically.
  if (!RENDER_SKIPPED && SKIP_TESTS[name] != null) {
    return {
      name,
      category: categoryOf(name),
      nonAaPixels: 0,
      nonAaPixelPct: 0,
      diffPct: 0,
      sigPixelPct: 0,
      worstTilePct: 0,
      worstTileSignificantPct: 0,
      worstTileRect: undefined,
      regionCount: 0,
      totalChangedArea: 0,
      maxRegionSeverity: 0,
      scatteredPixels: 0,
      shiftedPixels: 0,
      shiftyRegionCount: 0,
      shiftyRegionArea: 0,
      coveragePct: 0,
      verdict: "clean",
      regions: [],
      pass: true,
      skipped: true,
      skipReason: SKIP_TESTS[name],
      acceptedReason: undefined,
      bodyBg: "#ffffff",
      error: undefined,
      warnings: undefined,
    };
  }
  // DM-781: per-fixture capture height. Fixtures whose content extends past
  // the 768 px default get the override; everything else uses the default.
  // Resize the viewport BEFORE the navigation so the initial layout (and
  // anything keyed off media queries / vh units / IntersectionObserver) sees
  // the height the test was designed for.
  const fixtureHeight = captureHeightFor(name);

  // DM-1029: per-step timer (no-op unless DEMO_TIMING). `startMs` clocks where
  // in the overall run this fixture began so the diagram can show worker
  // overlap.
  const timer = makeStepTimer();
  const fixtureStartMs = DEMO_TIMING ? performance.now() - _timingRunStartMs : 0;
  try {
    if (fixtureHeight !== HEIGHT) {
      await w.page.setViewportSize({ width: WIDTH, height: fixtureHeight });
    } else {
      // Reset back to default in case the previous fixture in this worker
      // bumped the viewport — keeps screenshot dimensions consistent across
      // jobs run on the same page.
      const vp = w.page.viewportSize();
      if (vp != null && vp.height !== HEIGHT) {
        await w.page.setViewportSize({ width: WIDTH, height: HEIGHT });
      }
    }
    timer.mark("viewport");
    // DM-1002 / DM-1013: check the cache. Hash key folds in source HTML
    // bytes + viewport + Playwright version + CAPTURE_SCRIPT bundle
    // hash, so any of those changing invalidates the entry. Full cache
    // hit (PNG + meta with `tree` field) lets us skip the source goto +
    // screenshot + bodyBg evaluate + webfont discovery + captureTree
    // entirely — the per-fixture bottleneck. The tree is restored from
    // JSON; embedRemoteImages and rasterizeConicGradients run as
    // normal against it. The actual-render half still needs the SVG
    // navigation (no way around that — it's how we render the SVG).
    const srcBytes = readFileSync(srcPath);
    const cacheKey = expectedCacheKey(srcBytes, fixtureHeight);
    const cachedPng = expectedCachePngPath(cacheKey);
    const cachedMeta = expectedCacheMetaPath(cacheKey);
    let cap: { tree: unknown[]; warnings: Array<{ selector: string; feature: string; detail: string }> } | null = null;
    if (existsSync(cachedPng) && existsSync(cachedMeta)) {
      try {
        const meta = JSON.parse(readFileSync(cachedMeta, "utf-8")) as ExpectedCacheMeta;
        if (meta.tree != null) {
          copyFileSync(cachedPng, expectedPath);
          bodyBg = meta.bodyBg;
          cap = { tree: meta.tree as unknown[], warnings: meta.warnings ?? [] };
          capWarnings = cap.warnings;
          _expectedCacheHits++;
        } else {
          // Old DM-1002 cache entry without tree — treat as miss so we
          // re-capture and overwrite with the tree-bearing version.
          _expectedCacheMisses++;
        }
      } catch {
        _expectedCacheMisses++;
      }
    } else {
      _expectedCacheMisses++;
    }

    timer.mark("cache-check");
    if (cap == null) {
      // Cache miss — do the full source-side work.
      await w.page.goto(`file://${srcPath}`);
      timer.mark("goto-source");
      // DM-1009: replaced waitForTimeout(150) — the 150 ms was a buffer for
      // `@font-face` loads to finish (per DM-303 comment below). waitForSettled
      // resolves on the actual `document.fonts.ready` + images-complete +
      // next-paint events, so fast fixtures stop paying for the slow ones.
      await waitForSettled(w.page);
      timer.mark("settle-source");

      bodyBg = await w.page.evaluate(() => {
        const cs = getComputedStyle(document.body);
        const bg = cs.backgroundColor;
        if (bg === "rgba(0, 0, 0, 0)" || bg === "transparent") return "#ffffff";
        return bg;
      });
      timer.mark("read-bodyBg");

      await w.page.screenshot({ path: expectedPath, clip: { x: 0, y: 0, width: WIDTH, height: fixtureHeight } });
      timer.mark("screenshot-expected");

      // Pick up any @font-face rules — covers both url(...) downloads and
      // local(...) aliases (DM-303). Without this, fixtures using
      // `font-family: "MyFamily"` declared via @font-face render in the
      // chain-fallback face (`serif` → Times) instead of the local() target.
      try { await discoverAndRegisterWebfonts(w.page); } catch { /* best-effort */ }
      timer.mark("discover-webfonts");

      // captureElementTreeWithWarnings returns warnings inline so concurrent
      // workers don't race on the lastCaptureWarnings module global (DM-456).
      cap = await captureElementTreeWithWarnings(w.page, "body", { x: 0, y: 0, width: WIDTH, height: fixtureHeight });
      capWarnings = cap.warnings;
      timer.mark("capture-tree");

      // Populate the cache for next time (DM-1002 + DM-1013). Best-effort
      // — a cache write failure doesn't fail the test, the next run just
      // re-renders. Write happens BEFORE embedRemoteImages /
      // rasterizeConicGradients so the serialised tree stays small (those
      // passes mutate cap.tree in place with Buffer / dataURI data).
      try {
        mkdirSync(EXPECTED_CACHE_DIR, { recursive: true });
        copyFileSync(expectedPath, cachedPng);
        writeFileSync(cachedMeta, JSON.stringify({ bodyBg, tree: cap.tree, warnings: cap.warnings }));
      } catch { /* ignore */ }
      timer.mark("cache-write");
    }
    // DM-512: demos always emit self-contained SVGs.
    // DM-527: thread the per-suite warnings array so concurrent workers
    // don't race on the lastCaptureWarnings module global.
    await embedRemoteImages(cap.tree, { warnings: capWarnings });
    timer.mark("embed-remote-images");
    // DM-549: rasterize conic-gradient layers (no-op when tree has none).
    await rasterizeConicGradients(cap.tree);
    timer.mark("rasterize-conic");
    // DM-1029: bracket the synchronous render with the render-profiler so we
    // can split render-svg into [helper subprocess] / [text in-process] /
    // [box + markup]. Safe because elementTreeToSvgInner never awaits — no
    // other worker interleaves between reset and snapshot.
    if (DEMO_TIMING) profReset();
    const svgContent = elementTreeToSvgInner(cap.tree, WIDTH, fixtureHeight);
    const renderProf = DEMO_TIMING ? profSnapshot() : {};
    const xlinkAttr = svgContent.includes("xlink:") ? ` xmlns:xlink="http://www.w3.org/1999/xlink"` : "";
    const svgDoc = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg"${xlinkAttr} viewBox="0 0 ${WIDTH} ${fixtureHeight}" width="${WIDTH}" height="${fixtureHeight}"><rect width="${WIDTH}" height="${fixtureHeight}" fill="${bodyBg}" />${svgContent}</svg>`;
    writeFileSync(svgPath, svgDoc);
    timer.mark("render-svg");

    // Load the SVG directly as the top-level document. Wrapping it in <img>
    // blocks external resource loads inside the SVG for security, which
    // masked rendering fidelity for any test using background:url() or <img>.
    // Loading the SVG as a document lets those external file:// refs resolve.
    await w.page.goto(`file://${svgPath}`);
    timer.mark("goto-svg");
    // DM-1009: replaced waitForTimeout(200) — the 200 ms was a buffer for
    // SVG `<image href>` external file:// refs to finish loading.
    // waitForSettled awaits each image's load/error event directly.
    await waitForSettled(w.page);
    timer.mark("settle-svg");
    await w.page.screenshot({ path: actualPath, clip: { x: 0, y: 0, width: WIDTH, height: fixtureHeight } });
    timer.mark("screenshot-actual");

    const cmp = await withCompareLock((cp) => comparePngs(cp, expectedPath, actualPath, diffPath, TILE_PX, SIGNIFICANT_PIXEL_DIST));
    timer.mark("compare-pngs");
    if (DEMO_TIMING) {
      _timingRecords.push({
        name,
        worker: 0, // overlap is shown via startMs; exact worker id isn't needed
        cacheHit: !timer.steps.some((s) => s.step === "goto-source"),
        startMs: fixtureStartMs,
        totalMs: timer.steps.reduce((sum, s) => sum + s.ms, 0),
        steps: timer.steps,
        renderProfile: renderProf,
      });
    }
    nonAaPixels = cmp.nonAaPixels;
    nonAaPixelPct = cmp.nonAaPixelPct;
    diffPct = cmp.diffPct;
    sigPixelPct = cmp.sigPixelPct;
    worstTilePct = cmp.worstTilePct;
    worstTileSignificantPct = cmp.worstTileSignificantPct;
    worstTileRect = cmp.worstTileRect;
    regionCount = cmp.regionCount;
    totalChangedArea = cmp.totalChangedArea;
    maxRegionSeverity = cmp.maxRegionSeverity;
    scatteredPixels = cmp.scatteredPixels;
    shiftedPixels = cmp.shiftedPixels;
    shiftyRegionCount = cmp.shiftyRegionCount;
    shiftyRegionArea = cmp.shiftyRegionArea;
    coveragePct = cmp.coveragePct;
    verdict = cmp.verdict;
    regions = cmp.regions;
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }

  const skipReason = SKIP_TESTS[name];
  const skipped = skipReason != null;
  const acceptedReason = ACCEPTED_DIFFS[name];
  const accepted = !skipped && err == null && acceptedReason != null;
  const pass = !skipped && err == null && (regionCount === 0 || accepted);
  return {
    name,
    category: categoryOf(name),
    nonAaPixels,
    nonAaPixelPct,
    diffPct,
    sigPixelPct,
    worstTilePct,
    worstTileSignificantPct,
    worstTileRect,
    regionCount,
    totalChangedArea,
    maxRegionSeverity,
    scatteredPixels,
    shiftedPixels,
    shiftyRegionCount,
    shiftyRegionArea,
    coveragePct,
    verdict,
    regions,
    pass,
    skipped,
    skipReason,
    acceptedReason: accepted ? acceptedReason : undefined,
    bodyBg,
    error: err,
    warnings: capWarnings.length > 0 ? capWarnings : undefined,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const onlyArg = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

  mkdirSync(OUTPUT_DIR, { recursive: true });

  if (!existsSync(HTML_TEST_DIR)) {
    console.error(`html-test fixtures missing at ${HTML_TEST_DIR}`);
    console.error(`Clone the fixture repo with:`);
    console.error(`  git clone https://github.com/brianwestphal/html-test.git external/html-test`);
    console.error(`(or set HTML_TEST_DIR to point at an existing checkout)`);
    process.exitCode = 1;
    return;
  }
  // DM-714: walk recursively so subdir-grouped fixtures (`niche/*.html`,
  // future additions) are picked up automatically.
  const files = walkHtmlFiles(HTML_TEST_DIR);

  // --only is matched against the flattened name (with `/` → `-`) so callers
  // can pass either form: `--only niche-foo` and `--only niche/foo` both work.
  const onlyNorm = onlyArg != null ? onlyArg.replace(/\//g, "-") : null;
  const testFiles = onlyNorm != null
    ? files.filter((f) => f.replace(/\//g, "-").startsWith(onlyNorm))
    : files;
  if (testFiles.length === 0) {
    console.log(`No test files matched (onlyArg=${onlyArg ?? "(none)"}).`);
    return;
  }

  // DM-459: yield CPU to interactive work — Chromium subprocesses inherit.
  lowerProcessPriority();
  const workerCount = resolveWorkerCount();
  const overrideCount = testFiles.filter((f) => {
    const name = f.replace(/\.html$/, "").replace(/\//g, "-");
    return FIXTURE_HEIGHT_OVERRIDES[name] != null;
  }).length;
  const overrideNote = overrideCount > 0
    ? ` (${overrideCount} fixture${overrideCount === 1 ? "" : "s"} use a taller capture height per DM-781)`
    : "";
  console.log(`Running ${testFiles.length} html-test files (viewport ${WIDTH}x${HEIGHT}${overrideNote}) with ${workerCount} workers...\n`);

  // Progress-indicator state — updated inside `onResult` below as each
  // fixture completes. `runStartMs` clocks total wall time so the
  // elapsed / ETA pair shown on each line uses the run's true start, not
  // the per-worker setup time.
  const runStartMs = Date.now();
  let completedJobs = 0;

  // DM-1029: anchor the per-fixture timing offsets to the same instant the
  // browser launches, and record the worker count so the diagram can show how
  // many serial pipelines run concurrently.
  _timingRunStartMs = performance.now();
  _timingWorkerCount = workerCount;
  const browser = await chromium.launch();

  // DM-1006: one shared comparePage for all workers (was per-worker before).
  // Set up once here, torn down after the pool finishes; the per-call mutex
  // (`withCompareLock`) serialises access so workers don't race on it.
  const sharedCompareContext = await browser.newContext({ viewport: { width: WIDTH * 2, height: HEIGHT } });
  sharedComparePage = await sharedCompareContext.newPage();
  sharedComparePage.setDefaultTimeout(90_000);
  sharedComparePage.setDefaultNavigationTimeout(90_000);
  await sharedComparePage.goto("about:blank");

  const results = await runJobsInPool<string, HtmlTestWorker, TestResult>({
    jobs: testFiles,
    workers: workerCount,
    setup: async () => {
      const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
      const page = await context.newPage();
      // DM-479: 90 s instead of Playwright's 30 s default.
      page.setDefaultTimeout(90_000);
      page.setDefaultNavigationTimeout(90_000);
      return { context, page };
    },
    teardown: async (w) => {
      await w.context.close();
    },
    runJob: async (file, w) => runOneHtmlTest(file, w),
    onResult: (result) => {
      const { name, pass, skipped, acceptedReason, error: err, warnings, verdict, regionCount, coveragePct } = result;
      const status = skipped
        ? "- SKIP"
        : acceptedReason != null
        ? "~ ACCEPT"
        : pass ? "✓ PASS" : "✗ FAIL";
      const warnBadge = warnings != null ? ` (${warnings.length}w)` : "";
      // Headline: verdict tier + region count + coverage %. Three things,
      // each immediately interpretable: "minor" tells you it's small,
      // "3 regions" tells you how many spots to look at, "0.28% of image"
      // tells you how much area is wrong.
      const headline = (skipped ?? false)
        ? ""
        : ` ${verdict} · ${regionCount} region${regionCount === 1 ? "" : "s"} · ${coveragePct.toFixed(2)}% of image`;
      // Progress indicator: completed / total ([pct%]), elapsed, ETA. Lets
      // long runs (the 818-fixture unicode sweep is ~30 min on a laptop)
      // show how much is left at a glance. ETA uses the rolling average
      // throughput across all completed jobs so it stabilises after the
      // first ~10 results past worker warmup.
      completedJobs++;
      const elapsedMs = Date.now() - runStartMs;
      const pct = (completedJobs / testFiles.length) * 100;
      const avgMsPerJob = elapsedMs / completedJobs;
      const remainingMs = Math.max(0, (testFiles.length - completedJobs) * avgMsPerJob);
      const progress = `[${completedJobs.toString().padStart(String(testFiles.length).length)}/${testFiles.length} ${pct.toFixed(1).padStart(5)}%  elapsed ${formatDuration(elapsedMs)}  ETA ${formatDuration(remainingMs)}]`;
      console.log(`  ${progress}  ${status}  ${name.padEnd(40)}${headline}${warnBadge}${err != null ? `  ERR: ${err}` : ""}`);
    },
  });

  // DM-1006: tear down the shared compare context before closing the
  // browser so its resources are released cleanly.
  await sharedCompareContext.close();
  sharedComparePage = null;
  await browser.close();

  writeFileSync(resolve(OUTPUT_DIR, "results.json"), JSON.stringify(results, null, 2));

  // DM-1029: dump the per-step timing trace so `tools/render-timing-diagram.mjs`
  // can build the annotated pipeline SVG and we can re-measure after each
  // optimization. Only written when DEMO_TIMING=1.
  if (DEMO_TIMING) {
    const totalWallMs = performance.now() - _timingRunStartMs;
    writeFileSync(
      resolve(OUTPUT_DIR, "timing.json"),
      JSON.stringify({ workerCount: _timingWorkerCount, totalWallMs, fixtures: _timingRecords }, null, 2),
    );
    console.log(`DEMO_TIMING: wrote ${resolve(OUTPUT_DIR, "timing.json")} (${_timingRecords.length} fixtures, ${(totalWallMs / 1000).toFixed(1)}s wall)`);
  }

  const indexHtml = buildIndexHtml(results);
  writeFileSync(resolve(OUTPUT_DIR, "index.html"), indexHtml);

  const passed = results.filter((r) => r.pass).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.length - passed - skipped;
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped out of ${results.length}`);
  // DM-1002 verification — expected.png cache hit/miss tally so we can
  // confirm the cache is actually firing across the run.
  const totalCacheChecks = _expectedCacheHits + _expectedCacheMisses;
  if (totalCacheChecks > 0) {
    const hitPct = (_expectedCacheHits / totalCacheChecks * 100).toFixed(1);
    console.log(`Expected.png cache: ${_expectedCacheHits} hits / ${_expectedCacheMisses} misses (${hitPct}% hit rate)`);
  }
  console.log(`\nArtifacts: ${OUTPUT_DIR}`);
  console.log(`Visual index: file://${resolve(OUTPUT_DIR, "index.html")}`);

  const byCategory = new Map<string, { total: number; failed: number; avgDiff: number }>();
  for (const r of results) {
    const entry = byCategory.get(r.category) ?? { total: 0, failed: 0, avgDiff: 0 };
    entry.total++;
    entry.avgDiff += r.diffPct;
    if (!r.pass) entry.failed++;
    byCategory.set(r.category, entry);
  }

  console.log(`\nBy category (category: fails/total avg%):`);
  const catKeys = Array.from(byCategory.keys()).sort();
  for (const key of catKeys) {
    const v = byCategory.get(key)!;
    console.log(`  ${key.padEnd(24)} ${v.failed}/${v.total}  avg ${(v.avgDiff / v.total).toFixed(1)}%`);
  }

  if (failed > 0) process.exitCode = 1;
}

const INDEX_CSS = `
body{font:13px -apple-system,sans-serif;margin:16px;background:#f6f8fa}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e1e4e8;vertical-align:top}
tr.pass{background:#f0fff4}
tr.fail{background:#fff5f5}
tr.skip{background:#f6f8fa;opacity:0.7}
.name{font-family:monospace;font-size:12px}
.status{font-weight:600}
.tile{color:#6e7681;font-size:11px}
.imgs img{width:180px;height:135px;object-fit:contain;background:#fff;border:1px solid #d0d7de;margin-right:4px}
h1{margin:0 0 12px}
.err{color:#cf222e;font-family:monospace;font-size:11px}
.skip-note{color:#8b949e;font-size:11px;font-style:italic;margin-top:4px}
.warn-list{font-size:11px;color:#6e7681;margin:4px 0 0 14px;padding:0}
.warn-list li{margin:1px 0}
.legend{font-size:12px;color:#6e7681;margin-bottom:8px}
`;

function ResultRow({ r }: { r: TestResult }) {
  const status = r.skipped ? "SKIP" : r.pass ? "PASS" : "FAIL";
  const cls = r.skipped ? "skip" : r.pass ? "pass" : "fail";
  return (
    <tr className={cls}>
      <td className="name">{r.name}</td>
      <td className="status">{status}</td>
      <td className="diff">
        <div><b>{`${r.verdict} · ${r.regionCount} region${r.regionCount === 1 ? "" : "s"}`}</b></div>
        <div className="tile">{`${r.coveragePct.toFixed(2)}% of image`}</div>
        <div className="tile">{`shifty ${r.shiftyRegionCount} · shifted ${r.shiftedPixels} · scatter ${r.scatteredPixels}`}</div>
        <div className="tile">{`raw avg ${r.diffPct.toFixed(2)}% · non-AA ${r.nonAaPixels} px`}</div>
      </td>
      <td className="imgs">
        <a href={`${r.name}-expected.png`}><img src={`${r.name}-expected.png`} /></a>
        <a href={`${r.name}-actual.png`}><img src={`${r.name}-actual.png`} /></a>
        <a href={`${r.name}-diff.png`}><img src={`${r.name}-diff.png`} /></a>
      </td>
      <td className="err-cell">
        {r.error != null ? <div className="err">{r.error}</div> : null}
        {r.skipReason != null ? <div className="skip-note">{`skipped: ${r.skipReason}`}</div> : null}
        {(r.warnings ?? []).length > 0 ? (
          <ul className="warn-list">
            {(r.warnings ?? []).map((w) => (
              <li><b>{w.feature}</b>{` · ${w.selector} — ${w.detail}`}</li>
            ))}
          </ul>
        ) : null}
      </td>
    </tr>
  );
}

function MetricsLegend() {
  return (
    <p className="legend">
      {`Verdicts: clean (no regions) · trivial (≤2 regions, <0.05% coverage) · minor (≤5 regions, <0.5%) · moderate (≤15 regions, <2%) · major (everything past that). Pipeline (DM-715): neighborhood-tolerant shift filter → Yee AA filter → 3-px dilation + flood-fill → area + high-severity gates. "shifty" = font-substitution regions culled by the high-sev gate; "scatter" = sub-area components; "shifted" = pixels absorbed by neighborhood matching. Big shifty/shifted with low region count means the filters did real work. Magenta outlines on diff.png mark surviving regions; yellow box marks the worst tile.`}
    </p>
  );
}

function IndexLayout({ results }: { results: TestResult[] }) {
  const passCount = results.filter((r) => r.pass).length;
  const failCount = results.filter((r) => !r.pass && !r.skipped).length;
  const skipCount = results.filter((r) => r.skipped).length;
  return (
    <html>
      <head>
        <meta charset="utf-8" />
        <title>domotion html-test results</title>
        {/* eslint-disable-next-line kerfjs/no-raw-with-dynamic-arg -- static CSS string constant */}
        <style>{raw(INDEX_CSS)}</style>
      </head>
      <body>
        <h1>{`domotion vs html-test (${results.length} files; ${passCount} pass · ${failCount} fail · ${skipCount} skip)`}</h1>
        <MetricsLegend />
        <table>
          <thead><tr><th>File</th><th>Status</th><th>Diff</th><th>Expected · Actual · Diff</th><th>Notes</th></tr></thead>
          <tbody>
            {results.map((r) => <ResultRow r={r} />)}
          </tbody>
        </table>
      </body>
    </html>
  );
}

function buildIndexHtml(results: TestResult[]): string {
  return `<!DOCTYPE html>${(<IndexLayout results={results} />).toString()}`;
}

void main();

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

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, type Page } from "@playwright/test";
import {
  isGlyphHelperAvailable,
  profReset,
  profSnapshot,
  getEmbeddedFontBuildDiagnostics,
  resetGeneration,
} from "@domotion/text-engine/testing";
import { createExpectedCache } from "./html-test/cache.js";
import { createCompareLock } from "./html-test/compare-lock.js";
import { parseTextEvidenceSelection, renderWithTextEvidence } from "./html-test/evidence.js";
import { launchHarnessBrowsers, harnessBrowserNote } from "./harness-browsers.js";
import {
  captureElementTreeWithWarnings,
  elementTreeToSvgInner,
  embedRemoteImages,
} from "../src/render/element-tree-to-svg.js";
import { discoverAndRegisterWebfonts } from "../src/capture/index.js";
import { rasterizeConicGradients } from "../src/render/conic-raster.js";
import { type EmbeddedFontBuildDiagnostic } from "../src/render/font-resolution.js";
import { type FixtureTextRunProvenance } from "../src/render/text-run-provenance.js";
import {
  comparePngs,
  MIN_REGION_AREA,
  REGION_DILATE_PX,
  SIGNIFICANT_PIXEL_DIST,
  TILE_PX,
  type DiffVerdict,
} from "../src/review/compare-pngs.js";
import { waitForSettled } from "../src/utils/wait-events.js";
import { newHarnessPage } from "./harness-constants.js";
import { lowerProcessPriority, resolveWorkerCount, runJobsInPool } from "./worker-pool.js";
import { buildIndexHtml } from "./html-test/index-html.js";
import { FIXTURE_HEIGHT_OVERRIDES, SKIP_TESTS, ACCEPTED_DIFFS, captureHeightFor } from "./html-test/tables.js";
import { resetWorkerPages } from "./html-test/worker-pages.js";
import { parseShardSpec, selectShard } from "./shard.js";
import { walkHtmlFiles } from "./walk-html-files.js";
// Untyped .mjs (same pattern as tests importing scripts/run-env.mjs); tsx
// resolves it at runtime, and tests are outside the tsc include set.

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "..");
const HTML_TEST_DIR =
  process.env.HTML_TEST_DIR != null && process.env.HTML_TEST_DIR !== ""
    ? resolve(process.env.HTML_TEST_DIR)
    : resolve(PACKAGE_ROOT, "external/html-test");
// Anchor output under this package's tests/ regardless of cwd so runs from
// inside  don't create a stray
// subtree (the reason SK-991 was filed). Override via `HTML_TEST_OUTPUT_DIR`
// so a secondary suite (e.g. the unicode-block sweep — see
// `demos:test:unicode` in package.json) can point its expected/actual/diff
// triplets at a separate folder without clobbering the canonical
// html-test results.
// DM-1802: `DOMOTION_OUTPUT_DIR` is the broader override — it relocates the
// whole `tests/output` tree so a container run can't overwrite the host's
// artifacts (see the note in tests/runner.tsx). The suite-specific
// `HTML_TEST_OUTPUT_DIR` still wins where both are set, since it names this
// suite's folder exactly.
const OUTPUT_DIR =
  process.env.HTML_TEST_OUTPUT_DIR != null && process.env.HTML_TEST_OUTPUT_DIR !== ""
    ? resolve(process.env.HTML_TEST_OUTPUT_DIR)
    : process.env.DOMOTION_OUTPUT_DIR != null && process.env.DOMOTION_OUTPUT_DIR !== ""
      ? resolve(process.env.DOMOTION_OUTPUT_DIR, "html-test")
      : resolve(__dirname, "output/html-test");
const WIDTH = 1024;
const HEIGHT = 768;
// Diagnostic capture DPR (default 1). `CAPTURE_DPR=2` renders BOTH the expected
// Chromium screenshot and the actual Domotion-SVG raster at 2× device pixels —
// used to lift glyph ink into the DM-1686 comparator's calibrated ≥32px regime
// so tools/glyph-sheet-audit.ts can tell a real optical-size / font swap from
// the 1× native-hinting floor. Clip rects stay in CSS px; Playwright emits the
// DPR-scaled pixels automatically.
const CAPTURE_DPR = Math.max(1, Math.floor(Number(process.env.CAPTURE_DPR) || 1));
// DM-1004: when set (`RENDER_SKIPPED=0` or `--no-render-skipped` on CLI),
// fixtures listed in SKIP_TESTS bypass the goto + screenshot + SVG render
// pipeline entirely and emit a placeholder result. Default keeps rendering
// so the review UI can inspect skipped artifacts; CI / batch sweeps that
// don't read the review UI can save the per-fixture cost.
const RENDER_SKIPPED = process.env.RENDER_SKIPPED !== "0" && !process.argv.includes("--no-render-skipped");
const TEXT_EVIDENCE_SELECTION = parseTextEvidenceSelection(process.env.HTML_TEST_TEXT_EVIDENCE);

const expectedCache = createExpectedCache({
  outputDir: OUTPUT_DIR,
  packageRoot: PACKAGE_ROOT,
  width: WIDTH,
  dpr: CAPTURE_DPR,
});

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

export interface TestResult {
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
  /** DM-1874: per-side perceptual fingerprints, so a baseline diff can attribute
   *  a movement to the ORACLE or the RENDERER instead of only reporting that the
   *  distance between them changed. */
  expectedDigest?: string;
  actualDigest?: string;
  /** DM-1937: exact byte hashes of the two PNGs. The perceptual digests above
   *  are deliberately lossy and have been observed IDENTICAL for two outputs
   *  whose PNGs differ by 2,900 bytes — so digest equality must never be read
   *  as output equality. These are the other bound: sha equality IS proof of
   *  "same bytes" (the strongest possible "unchanged"), while sha inequality
   *  alone proves nothing perceptual (CI raster is not bit-stable; AA jitter
   *  flips it). Attribution logic combining both lives in
   *  `src/review/side-digest.ts` (`compareSideEvidence` / `attributeMovement`). */
  expectedSha256?: string;
  actualSha256?: string;
  /** DM-1937: true when expected.png + the captured tree were served from the
   *  expected-cache. A cache hit means Chrome never rendered this fixture in
   *  THIS run — so `chromeFaces` is absent and `expectedSha256` equality with a
   *  previous run is a statement about the cache, not about Chrome's
   *  determinism. Any repeatability claim must check this flag first. */
  expectedFromCache?: boolean;
  /** DM-1937: which pool worker ran this fixture, and its 0-based position in
   *  that worker's job sequence. Sorting a run's results by (worker, workerSeq)
   *  reconstructs the exact per-worker fixture order — recorded because
   *  process-global cache state (Blink's font fallback per renderer, fontkit's
   *  Glyph memoization) makes some outcomes order-sensitive, and two runs can
   *  only be checked for order-sensitivity if the order each actually executed
   *  in is in the artifact. */
  worker?: number;
  workerSeq?: number;
  /** The faces CHROME actually painted this fixture with, `PostScriptName:glyphCount`,
   *  sorted. Recorded because a pixel digest can only say the reference moved, never
   *  WHY — and the why here is almost always "Chrome picked a different face". Two
   *  runs of one commit have been seen to disagree on three fixtures while every
   *  recorded environment field was byte-identical, and answering that needed a
   *  fresh CI run purely to learn which face was involved. This makes the answer
   *  fall out of the artifact instead. Absent on records written before this
   *  existed, and on cache hits (no page was rendered to ask).
   *
   *  Granularity matters and bit once already: this began as ONE
   *  `CSS.getPlatformFontsForNode` call on `<body>`, which measured on a
   *  unicode grid fixture returned only the heading + intro-paragraph faces
   *  (~131 glyphs — none of the ~340 Menlo cell labels, none of the grid
   *  glyphs), so it read IDENTICAL across a run pair whose grid cells visibly
   *  flipped face. Now probed per text-bearing leaf element and merged as a
   *  per-face glyph-count sum, so a single cell's face flip changes this set. */
  chromeFaces?: string[];
  /** True when the fixture had more text-bearing leaves than the per-fixture
   *  probe cap — `chromeFaces` then covers a document-order prefix, not the
   *  whole page. */
  chromeFacesTruncated?: boolean;
  /** Per-entry builder provenance for the embedded fonts in this exact SVG. */
  embeddedFontBuilds?: EmbeddedFontBuildDiagnostic[];
  /** Fixture-scoped production face → glyph → outline evidence for the pinned
   * Linux Unicode raster-floor corpus and structural Vedic row. */
  textRunEvidence?: FixtureTextRunProvenance;
  /** Bounded source-browser and emitted-target facts for Unicode cells whose
   * descriptor identity cannot be reconstructed after a hosted runner expires. */
  unicodeDiagnosticEvidence?: {
    sourceCells: Array<{
      probe: number;
      text: string;
      computedFont: string;
      computedFontSize: string;
      ranges: Array<{
        codepoint: number;
        utf16: [number, number];
        x: number;
        y: number;
        width: number;
        height: number;
      }>;
      platformFonts: Array<{ familyName: string; postScriptName?: string; isCustomFont: boolean; glyphCount: number }>;
    }>;
    emittedSvg: { sha256: string; byteLength: number; textTargets: string[]; pathTransforms: string[] };
  };
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
  regions: Array<{
    area: number;
    maxSeverity: number;
    highSevFraction: number;
    x: number;
    y: number;
    w: number;
    h: number;
  }>;
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

// DM-714 / DM-1230: `walkHtmlFiles` lives in ./walk-html-files.ts so it can be
// unit tested without importing this harness (which runs the suite on import).

interface HtmlTestWorker {
  context: BrowserContext;
  page: Page;
  /**
   * DM-1790: the page the candidate SVG is rasterized on. Normally the SAME
   * page as `page`; under the asymmetric mode it lives in a SEPARATE browser
   * launched without the capture's flags — the consumer's condition. See
   * `tests/harness-browsers.ts`.
   */
  rasterPage: Page;
  rasterContext: BrowserContext | null;
  /** DM-1937: stable worker index + a mutable per-worker job counter, so each
   *  result can record where in this worker's sequence it ran (see the
   *  `worker`/`workerSeq` result fields). */
  id: number;
  seq: number;
}

// DM-1006: one comparePage shared across all workers. The N-workers-each-
// owning-their-own-comparePage approach burned ~80 MB of Chromium memory
// per worker for a resource that's idle most of the time (each comparePngs
// call takes ~100 ms; with 2 workers, the page sits unused 99% of the
// time). Serialize the compare calls with a simple chain-promise mutex —
// throughput stays within 10% of the prior parallel-compare setup since
// the per-worker render work (the actual bottleneck) keeps running while
// one worker holds the compare lock.
const compareLock = createCompareLock<Page>();
const withCompareLock = compareLock.withCompareLock;

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
  let expectedDigest: string | undefined;
  let actualDigest: string | undefined;
  let expectedSha256: string | undefined;
  let actualSha256: string | undefined;
  let expectedFromCache = false;
  let chromeFaces: string[] | undefined;
  let chromeFacesTruncated: boolean | undefined;
  let embeddedFontBuilds: EmbeddedFontBuildDiagnostic[] | undefined;
  let textRunEvidence: FixtureTextRunProvenance | undefined;
  let sourceDiagnosticCells: NonNullable<TestResult["unicodeDiagnosticEvidence"]>["sourceCells"] | undefined;
  let unicodeDiagnosticEvidence: TestResult["unicodeDiagnosticEvidence"] | undefined;
  // Claim the worker-sequence slot up front so even error/skip results record
  // where in the worker's order they ran.
  const workerSeq = w.seq++;
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
  let regions: Array<{
    area: number;
    maxSeverity: number;
    highSevFraction: number;
    x: number;
    y: number;
    w: number;
    h: number;
  }> = [];
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
      worker: w.id,
      workerSeq,
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
    const cacheKey = expectedCache.key(srcBytes, fixtureHeight);
    let cap: { tree: unknown[]; warnings: Array<{ selector: string; feature: string; detail: string }> } | null = null;
    // Targeted descriptor evidence must come from this run's live browser.
    const requiresLiveUnicodeEvidence = TEXT_EVIDENCE_SELECTION?.fixture === name;
    const meta = requiresLiveUnicodeEvidence ? null : expectedCache.read(cacheKey, expectedPath);
    if (requiresLiveUnicodeEvidence) expectedCache.stats.misses++;
    if (meta?.tree != null) {
      bodyBg = meta.bodyBg;
      cap = { tree: meta.tree as unknown[], warnings: meta.warnings ?? [] };
      capWarnings = cap.warnings;
      expectedFromCache = true;
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

      // Ask Chrome which faces it just painted with. Per text-bearing LEAF
      // element, merged as a per-face glyph-count sum — NOT one call on
      // <body>: that shallow form was measured returning only the heading +
      // intro-paragraph faces on a unicode grid fixture (~131 glyphs, none of
      // the grid cells or their Menlo labels), so it was blind to the exact
      // cells whose face flips this field exists to catch. (Blink's
      // aggregation rule for the body-level call lives in
      // core/inspector/inspector_css_agent.cc, absent from the local sparse
      // checkout — the shallowness is measured, not transcribed.)
      // Best-effort: this is diagnostic, and must never fail a sweep. Runs
      // after the screenshot; the probe attributes are removed before the
      // tree capture below.
      try {
        const leafCount: number = await w.page.evaluate(() => {
          let i = 0;
          for (const el of document.querySelectorAll("body, body *")) {
            for (const child of el.childNodes) {
              if (child.nodeType === Node.TEXT_NODE && /\S/.test(child.textContent ?? "")) {
                el.setAttribute("data-dm-faces-probe", String(i++));
                break;
              }
            }
          }
          return i;
        });
        // Cap the per-fixture CDP cost on dense real-world documents; the
        // unicode grids sit far below this (≈90 leaves).
        const PROBE_CAP = 400;
        const session = await w.page.context().newCDPSession(w.page);
        await session.send("DOM.enable");
        await session.send("CSS.enable");
        const { root } = await session.send("DOM.getDocument", { depth: 1 });
        const merged = new Map<string, number>();
        const collectCellEvidence = TEXT_EVIDENCE_SELECTION?.fixture === name;
        if (collectCellEvidence) sourceDiagnosticCells = [];
        for (let i = 0; i < Math.min(leafCount, PROBE_CAP); i++) {
          const { nodeId } = await session.send("DOM.querySelector", {
            nodeId: root.nodeId,
            selector: `[data-dm-faces-probe="${i}"]`,
          });
          if (nodeId === 0) continue;
          const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
          if (collectCellEvidence) {
            const cell = await w.page.locator(`[data-dm-faces-probe="${i}"]`).evaluate((element) => {
              const textNode = [...element.childNodes].find(
                (child) => child.nodeType === Node.TEXT_NODE && /\S/.test(child.textContent ?? ""),
              );
              const text = textNode?.textContent ?? "";
              const ranges: Array<{
                codepoint: number;
                utf16: [number, number];
                x: number;
                y: number;
                width: number;
                height: number;
              }> = [];
              let offset = 0;
              for (const character of text) {
                const end = offset + character.length;
                const range = document.createRange();
                range.setStart(textNode!, offset);
                range.setEnd(textNode!, end);
                const rect = range.getBoundingClientRect();
                ranges.push({
                  codepoint: character.codePointAt(0)!,
                  utf16: [offset, end],
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                });
                offset = end;
              }
              const style = getComputedStyle(element);
              return { text, computedFont: style.font, computedFontSize: style.fontSize, ranges };
            });
            if (cell.ranges.some((range) => range.codepoint >= 0x270ef && range.codepoint <= 0x270f4)) {
              sourceDiagnosticCells!.push({ probe: i, ...cell, platformFonts: fonts });
            }
          }
          for (const f of fonts) {
            const key = f.postScriptName ?? f.familyName;
            merged.set(key, (merged.get(key) ?? 0) + f.glyphCount);
          }
        }
        chromeFaces = [...merged.entries()]
          .map(([face, count]) => `${face}:${count}`)
          .sort((a, b) => a.localeCompare(b));
        if (leafCount > PROBE_CAP) chromeFacesTruncated = true;
        await session.detach().catch(() => {});
        await w.page.evaluate(() => {
          for (const el of document.querySelectorAll("[data-dm-faces-probe]"))
            el.removeAttribute("data-dm-faces-probe");
        });
      } catch {
        /* diagnostic only */
      }
      timer.mark("chrome-faces");

      // Pick up any @font-face rules — covers both url(...) downloads and
      // local(...) aliases (DM-303). Without this, fixtures using
      // `font-family: "MyFamily"` declared via @font-face render in the
      // chain-fallback face (`serif` → Times) instead of the local() target.
      try {
        await discoverAndRegisterWebfonts(w.page);
      } catch {
        /* best-effort */
      }
      timer.mark("discover-webfonts");

      // captureElementTreeWithWarnings returns warnings inline so concurrent
      // workers don't race on the lastCaptureWarnings module global (DM-456).
      cap = await captureElementTreeWithWarnings(w.page, "body", { x: 0, y: 0, width: WIDTH, height: fixtureHeight });
      capWarnings = cap.warnings;
      timer.mark("capture-tree");

      // Cache before later mutating passes so the serialized tree stays small.
      expectedCache.write(cacheKey, expectedPath, { bodyBg, tree: cap.tree, warnings: cap.warnings });
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
    // Every fixture owns one generation. Without this reset the builder report
    // is worker-cumulative and a workerSeq subtraction is required to guess
    // which subset belonged to this row.
    resetGeneration();
    const textRender = renderWithTextEvidence(
      name,
      () => elementTreeToSvgInner(cap.tree, WIDTH, fixtureHeight),
      TEXT_EVIDENCE_SELECTION,
    );
    const svgContent = textRender.result;
    textRunEvidence = textRender.evidence;
    embeddedFontBuilds = getEmbeddedFontBuildDiagnostics();
    const renderProf = DEMO_TIMING ? profSnapshot() : {};
    const xlinkAttr = svgContent.includes("xlink:") ? ` xmlns:xlink="http://www.w3.org/1999/xlink"` : "";
    const svgDoc = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg"${xlinkAttr} viewBox="0 0 ${WIDTH} ${fixtureHeight}" width="${WIDTH}" height="${fixtureHeight}"><rect width="${WIDTH}" height="${fixtureHeight}" fill="${bodyBg}" />${svgContent}</svg>`;
    writeFileSync(svgPath, svgDoc);
    if (sourceDiagnosticCells != null) {
      unicodeDiagnosticEvidence = {
        sourceCells: sourceDiagnosticCells,
        emittedSvg: {
          sha256: createHash("sha256").update(svgDoc).digest("hex"),
          byteLength: Buffer.byteLength(svgDoc),
          textTargets: [...svgContent.matchAll(/<text\b[^>]*>/g)].map((match) => match[0]),
          pathTransforms: [...svgContent.matchAll(/<g transform="([^"]+)"[^>]* role="img"/g)].map((match) => match[1]),
        },
      };
    }
    timer.mark("render-svg");

    // Load the SVG directly as the top-level document. Wrapping it in <img>
    // blocks external resource loads inside the SVG for security, which
    // masked rendering fidelity for any test using background:url() or <img>.
    // Loading the SVG as a document lets those external file:// refs resolve.
    //
    // DM-1790: `w.rasterPage` IS `w.page` by default (so this is unchanged);
    // under the asymmetric mode it is a page in a separately-flagged browser,
    // so a capture-side Chromium flag can't silently move the candidate side.
    if (w.rasterPage !== w.page) {
      await w.rasterPage.setViewportSize({ width: WIDTH, height: fixtureHeight });
    }
    await w.rasterPage.goto(`file://${svgPath}`);
    timer.mark("goto-svg");
    // DM-1009: replaced waitForTimeout(200) — the 200 ms was a buffer for
    // SVG `<image href>` external file:// refs to finish loading.
    // waitForSettled awaits each image's load/error event directly.
    await waitForSettled(w.rasterPage);
    timer.mark("settle-svg");
    await w.rasterPage.screenshot({ path: actualPath, clip: { x: 0, y: 0, width: WIDTH, height: fixtureHeight } });
    timer.mark("screenshot-actual");

    // DM-1937: byte hashes of both sides. The perceptual digests below are
    // lossy by design; these are the exact-identity bound (see the field docs).
    expectedSha256 = createHash("sha256").update(readFileSync(expectedPath)).digest("hex");
    actualSha256 = createHash("sha256").update(readFileSync(actualPath)).digest("hex");
    timer.mark("hash-sides");

    const cmp = await withCompareLock((cp) =>
      comparePngs(cp, expectedPath, actualPath, diffPath, TILE_PX, SIGNIFICANT_PIXEL_DIST),
    );
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
    expectedDigest = cmp.expectedDigest;
    actualDigest = cmp.actualDigest;
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
    expectedDigest,
    actualDigest,
    expectedSha256,
    actualSha256,
    expectedFromCache,
    chromeFaces,
    chromeFacesTruncated,
    embeddedFontBuilds,
    textRunEvidence,
    unicodeDiagnosticEvidence,
    worker: w.id,
    workerSeq,
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
  //
  // A COMMA-SEPARATED list selects the union, which is what bisecting a handful
  // of fixtures needs. It used to be a single prefix, and a comma list then
  // matched nothing — silently: every shard "succeeded" with no work, and only
  // the CI aggregate step noticed, six minutes later, with
  // `no results.json found under shard-artifacts`. Selecting nothing is now a
  // hard error below rather than an empty success.
  const onlyPrefixes =
    onlyArg != null
      ? onlyArg
          .split(",")
          .map((s) => s.trim().replace(/\//g, "-"))
          .filter((s) => s !== "")
      : null;
  const filteredFiles =
    onlyPrefixes != null && onlyPrefixes.length > 0
      ? files.filter((f) => {
          const n = f.replace(/\//g, "-");
          return onlyPrefixes.some((p) => n.startsWith(p));
        })
      : files;
  // DM-1216: shard-by-index so independent GitHub Actions jobs can each run a
  // slice of the suite. `--shard i/N` (or HTML_TEST_SHARD=i/N) keeps a STRIDE of
  // the sorted list (walkHtmlFiles already `.sort()`s, so every shard sees the
  // same ordering). No spec / "1/1" → the whole list. See tests/shard.ts.
  const shardSpec = args.includes("--shard") ? args[args.indexOf("--shard") + 1] : process.env.HTML_TEST_SHARD;
  const testFiles = selectShard(filteredFiles, shardSpec);
  if (testFiles.length === 0) {
    // An `--only` that matches nothing is a caller mistake, not an empty run.
    // Exiting 0 here is what let a mistyped filter look like a passing CI shard;
    // a shard whose STRIDE is legitimately empty is different and stays benign.
    const msg = `No test files matched (onlyArg=${onlyArg ?? "(none)"}, shard=${shardSpec ?? "(none)"}).`;
    if (onlyPrefixes != null && filteredFiles.length === 0) {
      console.error(`${msg}\n  --only takes one or more name PREFIXES, comma-separated, e.g. --only 2070,2C60`);
      process.exitCode = 2;
      return;
    }
    console.log(msg);
    return;
  }
  const shardNote =
    parseShardSpec(shardSpec) != null ? ` [shard ${shardSpec} → ${testFiles.length} of ${filteredFiles.length}]` : "";

  // DM-459: yield CPU to interactive work — Chromium subprocesses inherit.
  lowerProcessPriority();
  const workerCount = resolveWorkerCount();
  const overrideCount = testFiles.filter((f) => {
    const name = f.replace(/\.html$/, "").replace(/\//g, "-");
    return FIXTURE_HEIGHT_OVERRIDES[name] != null;
  }).length;
  const overrideNote =
    overrideCount > 0
      ? ` (${overrideCount} fixture${overrideCount === 1 ? "" : "s"} use a taller capture height per DM-781)`
      : "";
  console.log(
    `Running ${testFiles.length} html-test files (viewport ${WIDTH}x${HEIGHT}${overrideNote})${shardNote} with ${workerCount} workers...\n`,
  );

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
  // DM-1790: one browser by default; two when the capture and raster sides are
  // flagged differently (`DOMOTION_CAPTURE_FLAGS` / `DOMOTION_RASTER_FLAGS`).
  const browsers = await launchHarnessBrowsers();
  const browser = browsers.capture;
  const browserNote = harnessBrowserNote(browsers);
  if (browserNote != null) console.log(`  ${browserNote}\n`);

  // Announce a missing native glyph helper. On macOS and Windows the
  // per-codepoint fallback resolver asks the OS (CoreText / DirectWrite)
  // through this binary; without it, resolution silently drops to the STATIC
  // fallback chain and picks different faces than the browser does. That is
  // not a small drift — it is a different renderer, and it produced a whole
  // sweep of "wrong font" failures that were unreproducible locally because
  // the developer's tree HAS the binary (it is gitignored) and CI's did not.
  // Silence here is what made that cost days, so say it loudly.
  const helperAvailable = isGlyphHelperAvailable();
  if (!helperAvailable && (process.platform === "darwin" || process.platform === "win32")) {
    console.log(
      `  ⚠  NATIVE GLYPH HELPER MISSING — the live ${process.platform === "darwin" ? "CoreText" : "DirectWrite"} fallback\n` +
        `     resolver is OFF, so font selection falls back to the static chain and will NOT\n` +
        `     match the browser. These results are not comparable to a normal run.\n` +
        `     Build it: tools/${process.platform === "darwin" ? "macos" : "win32"}-glyph-extractor/build.sh\n`,
    );
  }

  // DM-1006: one shared comparePage for all workers (was per-worker before).
  // Set up once here, torn down after the pool finishes; the per-call mutex
  // (`withCompareLock`) serializes access so workers don't race on it.
  const sharedCompareContext = await browser.newContext({ viewport: { width: WIDTH * 2, height: HEIGHT } });
  const sharedComparePage = await sharedCompareContext.newPage();
  newHarnessPage(sharedComparePage);
  await sharedComparePage.goto("about:blank");
  compareLock.setPage(sharedComparePage);

  // DM-1937: monotonically assigned worker ids so results can record execution
  // order per worker (`worker` / `workerSeq`).
  let nextWorkerId = 0;
  const results = await runJobsInPool<string, HtmlTestWorker, TestResult>({
    jobs: testFiles,
    workers: workerCount,
    setup: async () => {
      const context = await browser.newContext({
        viewport: { width: WIDTH, height: HEIGHT },
        deviceScaleFactor: CAPTURE_DPR,
      });
      const page = await context.newPage();
      // DM-479: 90 s instead of Playwright's 30 s default.
      newHarnessPage(page);
      // DM-1790: under the asymmetric mode the candidate SVG gets its own page
      // in the unflagged browser; otherwise it shares the capture page exactly
      // as before, so the default path allocates no extra context.
      let rasterContext: BrowserContext | null = null;
      let rasterPage = page;
      if (browsers.asymmetric) {
        rasterContext = await browsers.raster.newContext({
          viewport: { width: WIDTH, height: HEIGHT },
          deviceScaleFactor: CAPTURE_DPR,
        });
        rasterPage = await rasterContext.newPage();
        newHarnessPage(rasterPage);
      }
      return { context, page, rasterPage, rasterContext, id: nextWorkerId++, seq: 0 };
    },
    teardown: async (w) => {
      await w.context.close();
      if (w.rasterContext != null) await w.rasterContext.close();
    },
    runJob: async (file, w) => {
      // A Chromium target that has navigated across ordinary documents and
      // then into an opaque srcdoc child can retain an unresolved Runtime call
      // from the old document. A fresh Page per fixture is the isolation
      // boundary Playwright itself guarantees; contexts remain pooled so font,
      // cache, and browser setup costs stay amortized.
      await resetWorkerPages(w);
      return runOneHtmlTest(file, w);
    },
    onResult: (result) => {
      const { name, pass, skipped, acceptedReason, error: err, warnings, verdict, regionCount, coveragePct } = result;
      const status = skipped ? "- SKIP" : acceptedReason != null ? "~ ACCEPT" : pass ? "✓ PASS" : "✗ FAIL";
      const warnBadge = warnings != null ? ` (${warnings.length}w)` : "";
      // Headline: verdict tier + region count + coverage %. Three things,
      // each immediately interpretable: "minor" tells you it's small,
      // "3 regions" tells you how many spots to look at, "0.28% of image"
      // tells you how much area is wrong.
      const headline =
        (skipped ?? false)
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
      console.log(
        `  ${progress}  ${status}  ${name.padEnd(40)}${headline}${warnBadge}${err != null ? `  ERR: ${err}` : ""}`,
      );
    },
  });

  // DM-1006: tear down the shared compare context before closing the
  // browser so its resources are released cleanly.
  await sharedCompareContext.close();
  compareLock.setPage(null);
  await browsers.close();

  writeFileSync(resolve(OUTPUT_DIR, "results.json"), JSON.stringify(results, null, 2));
  // DM-1790: `results.json` is a bare array (the CI shard merger concatenates
  // them), so the browser condition goes in a sidecar rather than changing that
  // shape. Written only when the run was NOT the default single-browser
  // condition — its whole purpose is to stop a flagged measurement from being
  // mistaken later for a plain one.
  // DM-1802: always written now (it was browser-condition-only), because the
  // PLATFORM that produced these artifacts is the thing a reviewer most needs
  // and most easily mistakes — see the note in tests/runner.tsx.
  {
    writeFileSync(
      resolve(OUTPUT_DIR, "run-conditions.json"),
      // `glyphHelper` records whether the live OS fallback resolver was on.
      // A run without it selects fonts by the static chain and is a different
      // renderer — comparing its numbers to a normal run's is meaningless, so
      // the artifact has to carry the fact rather than leaving a reviewer to
      // infer it from the fixture names that happened to fail.
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          platform: process.platform,
          glyphHelper: helperAvailable,
          browsers: browserNote,
          captureFlags: browsers.captureFlags,
          rasterFlags: browsers.rasterFlags,
        },
        null,
        2,
      ),
    );
  }

  // DM-1029: dump the per-step timing trace so `tools/render-timing-diagram.mjs`
  // can build the annotated pipeline SVG and we can re-measure after each
  // optimization. Only written when DEMO_TIMING=1.
  if (DEMO_TIMING) {
    const totalWallMs = performance.now() - _timingRunStartMs;
    writeFileSync(
      resolve(OUTPUT_DIR, "timing.json"),
      JSON.stringify({ workerCount: _timingWorkerCount, totalWallMs, fixtures: _timingRecords }, null, 2),
    );
    console.log(
      `DEMO_TIMING: wrote ${resolve(OUTPUT_DIR, "timing.json")} (${_timingRecords.length} fixtures, ${(totalWallMs / 1000).toFixed(1)}s wall)`,
    );
  }

  const indexHtml = buildIndexHtml(results);
  writeFileSync(resolve(OUTPUT_DIR, "index.html"), indexHtml);

  const passed = results.filter((r) => r.pass).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.length - passed - skipped;
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped out of ${results.length}`);
  // DM-1002 verification — expected.png cache hit/miss tally so we can
  // confirm the cache is actually firing across the run.
  const totalCacheChecks = expectedCache.stats.hits + expectedCache.stats.misses;
  if (totalCacheChecks > 0) {
    const hitPct = ((expectedCache.stats.hits / totalCacheChecks) * 100).toFixed(1);
    console.log(
      `Expected.png cache: ${expectedCache.stats.hits} hits / ${expectedCache.stats.misses} misses (${hitPct}% hit rate)`,
    );
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

void main();

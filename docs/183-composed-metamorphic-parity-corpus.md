# 183 — Composed real-world and metamorphic parity corpus

Status: **shipped**.

Focused oracles prove one decision at a time. They do not prove that independently correct decisions remain correct when a real page composes them. This corpus adds that complementary integration layer without treating a screenshot score as upstream source proof.

## Corpus

`tests/composed-parity-fixtures.ts` owns seven repository visual rows:

1. platform font fallback and bidi isolation inside flex/grid messaging UI;
2. native controls inside responsive multicol fragmentation;
3. gradients, masks, and clips crossing explicit stacking order;
4. inline SVG filter, clip, and marker effects under translation;
5. effective zoom plus nested rotation and normalized scale;
6. same-origin iframe recursion containing its own fallback, bidi, gradient, mask, and clip decisions; and
7. transformed canvas pixels frozen at capture while an explicitly stacked overlay remains vector.

Each family also names a three-decision crossing selected from capture/render
dependencies rather than a CSS Cartesian product. The manifest carries those
triples, the unit gate rejects missing or foreign members, and a destructive
control proves that retiring a family witness makes the aggregate incomplete.

The independent pinned html-test page is `tests/fixtures/html-test/36-composed-metamorphic-parity.html`. `tools/html-test-parity-corpus.json` records its SHA-256 beside the earlier blind-spot page. The sharded html-test workflow injects both pages into every macOS, Linux, and Windows clone and records the combined `parity-corpus-v2` identity before rendering.

## Metamorphic relations

The corpus names six relations rather than hiding them inside visually similar markup:

- a `display: contents` neutral wrapper;
- equivalent grid shorthand and longhand syntax;
- a text-node split at already-independent fallback/bidi boundaries;
- translation covariance;
- scale-normalized geometry; and
- reversed DOM order with unchanged explicit stacking levels.

`tests/composed-parity-corpus.e2e.test.ts` asks live Chromium to prove that each relation is active. It compares relative geometry and computed styles, requires translation and scale to move by their declared amount, and requires the DOM-order control to reverse while its z-index ownership stays fixed. This is deliberately separate from the source-versus-SVG screenshot rows: a fixture that accidentally makes both variants identical cannot earn a green metamorphic result merely because both renderers agree.

The same browser test captures the composed page while both canvases paint `FRAME A`, mutates the live canvases to `FRAME B`, and requires the serialized SVG to retain only the original Chromium snapshot. It also requires the same-origin iframe to recurse into native children instead of crossing the raster boundary.

## Process isolation and state coverage

`scripts/run-composed-parity.mjs` launches each repository fixture in a fresh process. This is a correctness boundary, not a speed optimization: font, image, gradient, iframe, and replaced-surface caches must not make fixture order an undocumented axis. A shared-session calibration run rendered the first five rows exactly and then stopped making progress entering the iframe row; the isolated iframe passed in two seconds. The intentional state transitions remain covered by the live E2E leg, while visual rows stay order-independent.

The runner writes one aggregate `tests/output/composed-parity-results.json` with platform, architecture, process-isolation mode, corpus manifest, browser condition, and all seven diff records. On the primary macOS calibration all seven rows are exact: zero regions and zero changed-image coverage.

## CI contract

`.github/workflows/composed-parity-corpus.yml` is a hard pull-request/main gate with native macOS, Linux, and Windows producers. Each leg:

1. installs Chromium and builds the platform resolver helper;
2. validates manifest identities, family/axis completeness, and workflow structure;
3. runs the live relation, iframe-recursion, and capture-freeze E2E gate;
4. runs all seven isolated source-versus-SVG visual rows; and
5. uploads the environment fingerprint plus source, SVG, raster, and diff artifacts even on failure.

The platform legs judge Chromium against Domotion on that same native producer. They do not compare screenshots across operating systems or normalize away platform font/control paint.

## Boundary

This is a composed regression and discovery corpus, not a replacement for the stage oracles in [the Chromium parity verification program](129-chromium-parity-verification-program.md). A visual failure must still be reduced to the earliest divergent selection, geometry, or paint stage before it can justify a production change. The seven dependency-driven triples and six relations are deliberate high-value crossings, not an exhaustive Cartesian product of CSS.

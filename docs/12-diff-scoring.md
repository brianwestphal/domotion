# Domotion: visual-diff scoring

Requirements for the `tests/html-test-suite.tsx` PNG-comparison metric. Origin: DM-281 (the original baseline metric was raw per-pixel RGB distance with no anti-aliasing awareness, so glyph-rendering drift dominated the signal and structurally-broken renders could pass under generous thresholds). Updated DM-383 (the bucketed avg / sig / tile thresholds were still tolerating visible structural mismatches that fell below the average-distance budget — a missing thin border or a misaligned shadow flips ~50 pixels, well under 5% of a 1024×768 image).

## Pass criterion (DM-383)

A fixture passes iff **every** differing pixel between expected and actual is classified as glyph anti-aliasing by the Yee detector. Concretely: `nonAaPixels === 0`, where `nonAaPixels` counts pixels whose `(R,G,B)` tuple differs between the two images AND that the detector did NOT classify as sub-pixel coverage along an edge.

The previous bucketed thresholds (`avg < 2%`, `sig < 5%`, `tile avg < 20%`, `tile-sig < 50%`) are now diagnostic only — they're still computed and printed so reviewers can gauge the *severity* of a failure, but they no longer gate pass/fail.

The user-facing rationale: "anti-aliasing differences aren't super important, but basically every other difference is important. For now, subtract the anti-aliasing differences and then mark everything with > 0% difference as a failure." Specific tolerances will be re-introduced per fixture once the user reviews which fixtures fail under the strict gate.

## What the AA detector does

`comparePngs` in `tests/html-test-suite.tsx` runs a port of pixelmatch's `antialiased()` detector (BSD-licensed; mapbox/pixelmatch) against **every** pixel where the two images differ. Previously the check was gated by `dist > SIG` (40 in the 0..441 normalized scale) for performance, which meant tiny non-AA drift was uncategorized and forced lenient % thresholds. The DM-383 strict gate runs the detector on every nonzero pixel so AA classification covers the full range of contrast.

AA-classified pixels contribute 0 to all metrics (`nonAaPixels`, the legacy avg-distance metric, and the significant-pixel count). AA pixels are still drawn into `*-diff.png` (literal absolute difference, see below) so reviewers can see what was filtered.

## Yee / pixelmatch antialias detector — recap

For each pixel `p` whose color differs between expected and actual:

1. Walk `p`'s 3×3 neighborhood in the source image. Compute Y-channel (luminance, ITU-R BT.601) delta to each neighbor.
2. Track:
   - `zeroes` — count of neighbors with identical color to `p`.
   - `min` / `max` — the most-extreme negative and positive Y deltas, with their `(x, y)` coordinates.
3. Bail (not AA) if `zeroes < 2` (no flat region around) OR no high-contrast neighbor exists in either direction.
4. The pixel is AA if either the darkest-neighbor cell or the brightest-neighbor cell has many same-color siblings in BOTH images (`hasManySiblings`). That means the contrasty neighbor is on a stroke that continues, i.e., the pixel is sub-pixel coverage along an edge.

We run the check twice — once anchored in `expected`, once in `actual` — and union the results. A pixel is AA if either check classifies it that way.

## Threshold rationale

Under DM-383 there is one threshold: `PASS_THRESHOLD_NON_AA_PIXELS = 0`. The diagnostic metrics retain their historical meanings (used for reviewer triage and for the worst-tile pointer in the diff PNG):

| metric | meaning |
|---|---|
| `nonAaPixels` | pass/fail gate — count of differing pixels not classified as AA |
| `nonAaPixelPct` | `nonAaPixels / totalPixels * 100` |
| `diffPct` | average normalized color distance % (AA pixels excluded) |
| `sigPixelPct` | % of pixels with `dist > SIGNIFICANT_PIXEL_DIST (40)` and !isAA |
| `worstTilePct` | per-tile avg distance for the worst tile |
| `worstTileSignificantPct` | per-tile sig-pixel % for the worst tile |

The worst-tile selector is now keyed off `nonAaPct` first (since that's what gates pass), with sig% then avg% as successive tiebreaks — so the yellow box in `*-diff.png` always points to the tile most responsible for the failure verdict.

## Diff image legend

The diff PNG is a **literal per-channel absolute difference** between expected and actual:

```
diff[i] = |expected[i] - actual[i]|       (per R/G/B channel, alpha=255)
```

Black pixels are exact matches; brighter pixels show what changed and in which color (a red glyph that should have been blue paints magenta in the diff; a small anti-aliasing shift on a black-on-white edge paints dim grey). No thresholding, no red tint, no dimmed-source overlay — the image is uninterpreted (DM-379). Reviewers reading the diff see the same per-pixel difference the metric saw.

The **only** painted overlay is a yellow rectangle outlining the worst tile by `tileSig` (then `tileAvg` as tiebreak), drawn after the absolute-difference fill so the navigation hint stays visible against the dark background.

Note: the AA classification still drives the `diffPercent` / `sigPixelPct` metrics (AA-classified pixels don't contribute to either), but it no longer affects the diff IMAGE rendering. If you need to know *which* pixels were classified AA, re-derive from the source images using the algorithm above — the diff PNG itself doesn't encode that distinction.

## Edge cases / out of scope

- Pixelmatch's algorithm is anchored to per-pixel comparisons; large translations of identical content (e.g., the entire page shifted by 5px) do not benefit from Yee. The current pipeline doesn't attempt translation-tolerant matching — fixtures should reflect the same captured layout for both expected and actual.
- The detector classifies any pixel that "looks like part of a smooth edge" as AA. A real content difference that happens to fall on a smooth edge in both images can be filtered. In practice this hurts very little because the same pixel typically carries a non-AA companion in the immediate area; tile-significant is the metric that surfaces this case.
- `hasManySiblings` does an exact-color comparison. Subtly different colors across an edge gradient can fool it. Pixelmatch tolerates this by also checking via `colorDelta` — a future iteration could add the relaxed match if needed.

## Tests

- `npm run demos:test:html` — full html-test suite. Under DM-383 the strict gate produces 0 / 156 PASS at baseline (all fixtures have at least some non-AA drift the detector doesn't catch); the user is iterating per-fixture on what should be allowed back to PASS. The diagnostic metrics in `results.json` make it easy to triage by severity (e.g., `nonAaPixels` ascending picks out fixtures with the smallest residual diff to investigate first).
- `npm test` — unit tests unchanged (the diff implementation lives only in the test runner, not in the library).

## Shared comparator

The comparator implementation lives in `tests/compare-pngs.ts`. Both runners (`tests/runner.tsx` for features / showcase, `tests/html-test-suite.tsx` for the html-test sweep) import `comparePngs()`, `passes()`, and the threshold / tile constants from there. Pass criterion, AA detection, tile metrics, and the worst-tile yellow box on the diff PNG are identical across all three suites — when the detector changes, change it once.

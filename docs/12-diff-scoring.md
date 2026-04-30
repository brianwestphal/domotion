# Domotion: visual-diff scoring

Requirements for the `tests/html-test-suite.tsx` PNG-comparison metric. Origin: DM-281 (the original baseline metric was raw per-pixel RGB distance with no anti-aliasing awareness, so glyph-rendering drift dominated the signal and structurally-broken renders could pass under generous thresholds).

## What changed

`comparePngs` in `tests/html-test-suite.tsx` now classifies every per-pixel difference as either real content drift OR sub-pixel glyph anti-aliasing using a port of pixelmatch's `antialiased()` detector (BSD-licensed; mapbox/pixelmatch). AA-classified pixels are excluded from both the average-distance metric AND the significant-pixel count, so the headline numbers reflect *only* actual content mismatches. AA pixels are still drawn into `*-diff.png` (in dim yellow) so reviewers can see what was filtered.

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

Before the Yee filter the text-drift floor sat at ~3% avg / ~6% sig. After the filter most text-only fixtures land at <1% avg / <2% sig because path-mode glyph anti-aliasing is now correctly attributed to the renderer, not to a rendering bug. Thresholds tightened accordingly:

| metric | old | new |
|---|---|---|
| `PASS_THRESHOLD_AVG` | 3.5 | 2.0 |
| `PASS_THRESHOLD_TILE` | 25 | 20 |
| `PASS_THRESHOLD_TILE_SIGNIFICANT` | 50 | 50 |
| `PASS_THRESHOLD_SIG_PIXELS` | 7 | 5 |

The tile-significant threshold stays at 50% because that's the metric that catches "wrong content paints in a small region" (e.g., a missing widget filled by white background). The single failing fixture (`17-bg-multiple`, tile-sig 82%) is the only one above the new threshold; the next-highest passing fixture is at 47%.

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

- `npm run demos:test:html` — full html-test suite. 155 pass / 1 pre-existing fail / 5 skipped both before and after the change; no regressions, but the scoring metric values shifted.
- `npm test` — unit tests unchanged (the diff implementation lives only in the test runner, not in the library).

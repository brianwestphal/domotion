---
id: "requirements/raster-fallback-content-gates"
title: "139 — Raster fallback pixel-content gates"
kind: "contract"
status: "current"
owners: ["images-media"]
platforms: ["macos", "linux", "windows"]
tickets: []
code:
  [
    "src/capture/backdrop-isolation.e2e.test.ts",
    "src/capture/backdrop-isolation.test.ts",
    "src/capture/emoji.test.ts",
    "src/render/conic-raster.test.ts",
    "src/render/text.test.ts",
    "src/stacking-context.test.ts",
    "tests/conic-chromium-raster.e2e.test.ts",
    "tests/cross-origin-iframe-recursion.e2e.test.ts",
    "tests/native-control-source-frame.e2e.test.ts",
    "tests/raster-fallback-content.e2e.test.ts",
    "tests/replaced-used-size.e2e.test.ts",
    "tests/snapshot-isolation.tsx",
    "tools/paint-geometry-oracle.ts",
    "tools/transform-geometry-oracle.ts",
  ]
aliases: ["docs/139-raster-fallback-content-gates.md", "doc-139"]
---

# 139 — Raster fallback pixel-content gates

Activation and content are separate claims. The raster-boundary oracle proves
which representation owns a case; the gates below prove that the owned bitmap
contains current Chromium pixels with the expected geometry and composition.

| Boundary                       | Activation rows                                                        | Pixel/paint gate                                                                                    | Proven dimensions                                                                                                                                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color glyph                    | `glyph.emoji`; `glyph.ascii-vector`                                    | `tests/raster-fallback-content.e2e.test.ts`; `src/capture/emoji.test.ts`; `src/render/text.test.ts` | advance-derived size/crop, alpha/content, placement, adjacent vector ownership                                                                                                                                                    |
| Replaced canvas/media          | `replaced.canvas`; ordinary-div negative                               | `tests/raster-fallback-content.e2e.test.ts`; `tests/replaced-used-size.e2e.test.ts`                 | used size, live color/alpha, crop/placement, changed-frame cache freshness                                                                                                                                                        |
| Unreadable iframe              | `replaced.cross-origin-frame`; recursive-vector negative               | `tests/raster-fallback-content.e2e.test.ts`; `tests/cross-origin-iframe-recursion.e2e.test.ts`      | used size, live color/alpha, recursive-vector boundary                                                                                                                                                                            |
| Image-replacement sprite/frame | `replaced.sprite-replacement`; background-vector negative              | `tests/raster-fallback-content.e2e.test.ts`; `tests/snapshot-isolation.tsx`                         | used size, color/alpha, crop/placement, vector sibling isolation                                                                                                                                                                  |
| Native control                 | `control.native-checkbox`; appearance-none negative                    | `tests/raster-fallback-content.e2e.test.ts`; `tests/native-control-source-frame.e2e.test.ts`        | one source frame + one atomic isolation frame, exact all-channel animated source crop, isolated static alpha, overlap exclusion/fail-closed timing, state, overflow/clip/scroll/zoom/DPR, forced-failure warning and no synthesis |
| Backdrop filter                | `backdrop.active`; ordinary-filter negative                            | `src/capture/backdrop-isolation.e2e.test.ts`; `src/capture/backdrop-isolation.test.ts`              | exact isolated pixels, crop/placement, alpha, later-sibling exclusion and restoration                                                                                                                                             |
| HTML URL-filter convolution    | `url-filter.convolve-html`; Gaussian and direct-SVG negatives          | `tests/raster-fallback-content.e2e.test.ts`; `src/stacking-context.test.ts`                         | current Chromium pixels, filter-region overflow, atomic subtree replacement, matrix controls, clip and transform composition                                                                                                      |
| Projective subtree             | `transform.projective`; affine negative                                | `tests/raster-fallback-content.e2e.test.ts`; `tools/transform-geometry-oracle.ts`                   | nonempty projected size/color/alpha, affine boundary discriminator                                                                                                                                                                |
| Advanced gradient              | `gradient.oklab-raster`, `gradient.alpha-raster`; opaque-sRGB negative | `tests/raster-fallback-content.e2e.test.ts`; `tools/paint-geometry-oracle.ts`                       | physical tile size, color space, premultiplied-alpha routing, stale-cache overwrite                                                                                                                                               |
| Conic gradient                 | `conic.active`; linear negative                                        | `tests/conic-chromium-raster.e2e.test.ts`; `src/render/conic-raster.test.ts`                        | physical tile size, center/angle/stops/colors, stale-cache overwrite and dedupe                                                                                                                                                   |

`mask.element-dormant`, textarea/vertical text, and helper-disabled text rows are
negative controls, not active pixel-content boundaries. They intentionally have
no bitmap-content gate.

Where each gate runs in CI:

- **Blocking, on every push to `main` and every pull request:** every browser
  file in the table (`tests/*.e2e.test.ts`, `src/**/*.e2e.test.ts`, including
  `replaced-used-size`) runs in the full `npm run test:e2e` lane on macOS
  (`ci.yml` `visual-macos`) and on Linux (`test-linux.yml` `regression`, a
  required check). The unit tests in the table run in `npm test` on both.
- **On shard 1 of each macOS, Linux, and Windows `visual-tests.yml`
  dispatch:** `raster-fallback-content`, `native-control-source-frame`,
  `effective-appearance`, `native-control-decoration`, `conic-chromium-raster`
  and `backdrop-isolation`. This is the only place these six run on Windows,
  so there the result **blocks**: the step itself is `continue-on-error`, so the
  shard still renders and uploads its evidence, and a final "Fail on raster
  fallback regression" step fails the Windows job when it failed. On macOS and
  Linux the step stays advisory, because the blocking e2e lanes above already
  cover these files. Before this was made blocking, its outcome across 29
  Windows dispatches was 25 passes, 2 failures (one commit with a real color-glyph
  regression), 1 cancelled and 1 skipped: no flakes.
- **Elsewhere:** `tests/cross-origin-iframe-recursion.e2e.test.ts` also runs
  in its own path-filtered `cross-origin-frame-scroll-ownership.yml` matrix;
  `tests/snapshot-isolation.tsx` runs in the manually dispatched
  `fast-visual-tests.yml` on all three platforms; the
  `tools/paint-geometry-oracle.ts` and `tools/transform-geometry-oracle.ts`
  entries run in `ci.yml`'s `test` job on macOS.

A local pass proves the mechanisms on the local environment; all-platform
confidence is recorded only after the corresponding CI artifacts are green and
reviewed. A Windows raster-fallback regression now fails the dispatch.

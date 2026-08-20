# 139 — Raster fallback pixel-content gates

Activation and content are separate claims. The raster-boundary oracle proves
which representation owns a case; the gates below prove that the owned bitmap
contains current Chromium pixels with the expected geometry and composition.

| Boundary | Activation rows | Pixel/paint gate | Proven dimensions |
| --- | --- | --- | --- |
| Color glyph | `glyph.emoji`; `glyph.ascii-vector` | `tests/raster-fallback-content.e2e.test.ts`; `src/capture/emoji.test.ts`; `src/render/text.test.ts` | advance-derived size/crop, alpha/content, placement, adjacent vector ownership |
| Replaced canvas/media | `replaced.canvas`; ordinary-div negative | `tests/raster-fallback-content.e2e.test.ts`; `tests/replaced-used-size.e2e.test.ts` | used size, live color/alpha, crop/placement, changed-frame cache freshness |
| Unreadable iframe | `replaced.cross-origin-frame`; recursive-vector negative | `tests/raster-fallback-content.e2e.test.ts`; `tests/cross-origin-iframe-recursion.e2e.test.ts` | used size, live color/alpha, recursive-vector boundary |
| Image-replacement sprite/frame | `replaced.sprite-replacement`; background-vector negative | `tests/raster-fallback-content.e2e.test.ts`; `tests/snapshot-isolation.tsx` | used size, color/alpha, crop/placement, vector sibling isolation |
| Native control | `control.native-checkbox`; appearance-none negative | `tests/raster-fallback-content.e2e.test.ts` | authoritative size, alpha/chromatic native paint, placement |
| Backdrop filter | `backdrop.active`; ordinary-filter negative | `src/capture/backdrop-isolation.e2e.test.ts`; `src/capture/backdrop-isolation.test.ts` | exact isolated pixels, crop/placement, alpha, later-sibling exclusion and restoration |
| Projective subtree | `transform.projective`; affine negative | `tests/raster-fallback-content.e2e.test.ts`; `tools/transform-geometry-oracle.ts` | nonempty projected size/color/alpha, affine boundary discriminator |
| Advanced gradient | `gradient.oklab-raster`, `gradient.alpha-raster`; opaque-sRGB negative | `tests/raster-fallback-content.e2e.test.ts`; `tools/paint-geometry-oracle.ts` | physical tile size, color space, premultiplied-alpha routing, stale-cache overwrite |
| Conic gradient | `conic.active`; linear negative | `tests/conic-chromium-raster.e2e.test.ts`; `src/render/conic-raster.test.ts` | physical tile size, center/angle/stops/colors, stale-cache overwrite and dedupe |

`mask.element-dormant`, textarea/vertical text, and helper-disabled text rows are
negative controls, not active pixel-content boundaries. They intentionally have
no bitmap-content gate.

The dedicated browser gates run on shard 1 of every macOS, Linux, and Windows
visual workflow. That avoids multiplying their cost by the shard count while
making platform verification part of every reviewable visual run. A local pass
proves the mechanisms on the local environment; all-platform confidence is
recorded only after the corresponding CI artifacts are green and reviewed.

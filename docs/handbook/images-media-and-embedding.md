---
id: "handbook/images-media-and-embedding"
title: "Images, media, and embedding handbook"
kind: "contract"
status: "current"
owners: ["images-media"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-2596", "DM-2617", "DM-2618"]
code:
  [
    "src/capture/replaced-media-frame.ts",
    "src/capture/background-image-sizing.ts",
    "src/capture/pseudo-fragment-cdp.ts",
    "src/render/element-tree-to-svg.ts",
    "src/render/image-pattern.ts",
    "src/post-processing/",
    "tests/feature-coverage.ts",
  ]
aliases: ["docs/handbook/images-media-and-embedding.md"]
---

# Images, media, and embedding handbook

## Contract

1. Output SVGs are self-contained: required image, font, and resource bytes are
   embedded, and no runtime script is added. Viewer sanitization may reduce an
   animation to its static frame but must not create an external dependency.
2. Ordinary images preserve source bytes or a deterministic bounded resize.
   Inline SVG keeps resource/reference semantics, and the presentation it
   inherits from the page cascade (paint, CSS geometry, and text such as
   `font-family` / `font-size` / `text-anchor`) is baked onto the cloned nodes
   ([doc 96](../96-native-svg-image-inlining.md)). Canvas, video, object, embed,
   broken-image, and other replaced content cross an explicit ownership gate.
   Dynamic image-root font math and font-face name isolation follow
   [the isolated image font contract](../274-dynamic-svg-image-fonts.md).
3. Time-dependent media is captured only from a coherent authenticated frame.
   Animated-image indexed capture is opt-in: owner bytes, decode, frame
   selection, immutable PNG handoff, resize, and emission retain one epoch and
   fail closed on disagreement.
4. Export to raster/video is downstream of the self-contained SVG and uses the
   same selected time/range/crop seen in the scrubber.
5. URL-backed CSS backgrounds preserve Blink's decoded image kind and natural
   sizing. Local `file:` SVG bytes are inspected by the Node capture prepass,
   because a page-side `fetch()` cannot be used as evidence for those resources;
   the resulting width, height, and ratio drive exact no-repeat and repeat tile
   geometry in the renderer.
6. Generated `content: url(...)` images retain Blink's anonymous replaced-child
   ownership. The pseudo element's explicit content-box controls layout advance,
   while a differently sized image keeps its intrinsic paint surface; because
   CDP exposes the slot quad but not that separate overflowing child paint quad,
   capture preserves one isolated Chromium-painted pseudo surface.

## Verified implementation map

| Area                  | Requirements                                                                                                                                                                                                                                                                                  | Code and tests                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Self containment      | [Remote inlining](../26-self-contained-svgs.md), [native SVG images](../96-native-svg-image-inlining.md), [viewer support](../84-viewer-browser-support.md)                                                                                                                                   | image capture/render modules and self-containment E2E tests                                                        |
| CSS background images | Blink `NaturalSizingInfo`, tile size, phase, and repeat semantics                                                                                                                                                                                                                             | `src/capture/background-image-sizing.ts`, `src/render/image-pattern.ts`, and background image sizing/pattern tests |
| Generated URL content | Blink anonymous `LayoutImage` intrinsic paint versus pseudo layout-slot ownership                                                                                                                                                                                                             | `src/capture/pseudo-fragment-cdp.ts`, protocol unit tests, and generated-image browser E2E tests                   |
| Replaced owners       | [Static snapshots](../17-replaced-element-snapshots.md), [ownership matrix](../184-replaced-ownership-transition-matrix.md), [live frames](../229-live-replaced-media-frame-ownership.md)                                                                                                     | `src/capture/replaced-media-frame.ts` and replaced-media tests                                                     |
| Animated images       | [Authenticated bytes](../231-authenticated-animated-image-byte-ownership.md), [static frame](../233-strict-animated-image-static-frame.md), [downstream ownership](../234-frozen-animated-image-downstream-ownership.md), [CSS/SVG owners](../236-strict-static-frames-for-svg-css-images.md) | authenticated collector/decoder/renderer modules and three-platform production gates                               |
| Export                | [Video](../47-svg-to-video.md), [still image](../78-svg-to-image.md)                                                                                                                                                                                                                          | post-processing exporters and scrubber endpoint tests                                                              |

## Responsive raster sizing evidence (DM-MJAMW0)

DOM `naturalWidth` / `naturalHeight` are observable provenance, but their integer
values are not a lossless raster paint-size authority. At Chromium
`6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050`, `HTMLImageElement` density-scales then
truncates those getters; `LayoutImageResource::GetNaturalDimensions` instead
retains floating density-scaled sizing. The native
`raster-intrinsic-density.e2e.test.ts` contract uses identical 396 × 581 PNG bytes
and a 358 × 525.234375 cover box: ordinary and responsive (`396w`, `sizes=390px`)
images paint identical pixels, while the captured intrinsic API values change
from 396 × 581 to 389 × 572. DM-0A2W05 adds selected decoded-resource ratio authority for raster contain/cover;
the original investigation changed no production sizing. The `src/capture/decoded-image-ratio.ts` prepass
uses the live selected IMG with native ImageBitmap, applies native orientation,
closes every bitmap (including late resolutions), and bounds readiness/cleanup
with Node timers. It makes no new asset request and retains source DOM/API
integers. Child frames and open shadow roots share that contract. Unsupported
orientation, decode failure or a deadline reports an explicit diagnostic and
keeps legacy sizing; foreign ownership fails closed. DM-JPDMRD tracks the
proved same-origin EXIF/CSS orientation-none gap: native layout40×20 can coexist
with oriented DOMnatural20×40. SVG natural sizing takes
precedence. DM-FRF6A8 owns complete fractional natural-size authority for none
and scale-down: physical decoded dimensions alone cannot recover density. A
native396w/sizes390px auto-size control lays out389.984375×572.1875 while API
getters report389×572. Do not infer density from those separately truncated
integers.

The retained Stripe mobile card joins actual browser response bytes and emitted
SVG bytes by SHA-256
`e4cdc2217f4841af32552e3b671f2fd72eb053966c7d145aa8ead412edb270d6` (396 × 581 WebP).
Its capture records 389 × 572; the renderer reconstructs a cover surface at
`x=16,y=103.9,width=358,height=526.4` inside the source content box
`x=16,y=104.484375,width=358,height=525.234375`. This is independent evidence of
the integer-ratio authority problem, not proof that every raster difference has
one cause. Private HARs and image bodies remain local.

Two discriminators keep the remaining differences separate:

- Rendering the authoritative anchor tree without output animation still leaves
  background mean absolute RGB error 2.0988953783646522 (maximum 22) and icon
  error 3.07 (maximum 93), at native crop coordinates `(16,180,358,440)` and
  `(329,129,20,20)`. These metrics are channel errors, not `diffPct`.
- The composed output is sampled at final cycle time minus 1 ms. Its outer CTM
  leaves the final anchor about 0.30005 px short; DM-EWYDDF owns that separate
  harness defect. The existing composed result has raw
  `diffPct=0.04592027283545024`, `regionCount=0`; passing that region gate does
  not make its pixels identical.

The static reference crops match the original source crop PNG hashes (background
`4b720e2a339341d79af49f867d3fe2856baa44051b3cca84e2c721ad01706a41`, icon
`3f8d1e227ee4131b5a56fb61ea4dce424fcf89e9f82e97082a3f50bb38a0fa20`).
The static full reference differs outside this component and one unrelated
sessions image is absent from the strict HAR; no full-page correctness claim is
made. CSS HTML image painting also pixel-snaps its destination while SVG image
painting uses fractional geometry in this Chromium revision. That source fact
alone neither quantifies the remaining raster floor nor authorizes position
normalization or a raster/geometry fix.

After the ratio correction, the same static card source/crop hashes remain
unchanged. Background mean channel error is2.0548903842898256/max24 (previous
2.0988953783646522/max22); icon remains3.07/max93. Standard raw full-reference
`diffPct` stays0.012077388292882433 with regionCount0 in both static arms.
This is scoped sizing-authority evidence, not a claim that the remaining
raster-route difference or whole reference is corrected.

---
id: "handbook/images-media-and-embedding"
title: "Images, media, and embedding handbook"
kind: "contract"
status: "current"
owners: ["images-media"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2596"]
code: ["src/capture/replaced-media-frame.ts","src/render/image.ts","src/post-processing/","tests/feature-coverage.ts"]
aliases: ["docs/handbook/images-media-and-embedding.md"]
---

# Images, media, and embedding handbook

## Contract

1. Output SVGs are self-contained: required image, font, and resource bytes are
   embedded, and no runtime script is added. Viewer sanitization may reduce an
   animation to its static frame but must not create an external dependency.
2. Ordinary images preserve source bytes or a deterministic bounded resize.
   Inline SVG keeps resource/reference semantics. Canvas, video, object, embed,
   broken-image, and other replaced content cross an explicit ownership gate.
3. Time-dependent media is captured only from a coherent authenticated frame.
   Animated-image indexed capture is opt-in: owner bytes, decode, frame
   selection, immutable PNG handoff, resize, and emission retain one epoch and
   fail closed on disagreement.
4. Export to raster/video is downstream of the self-contained SVG and uses the
   same selected time/range/crop seen in the scrubber.

## Verified implementation map

| Area | Requirements | Code and tests |
| --- | --- | --- |
| Self containment | [Remote inlining](../26-self-contained-svgs.md), [native SVG images](../96-native-svg-image-inlining.md), [viewer support](../84-viewer-browser-support.md) | image capture/render modules and self-containment E2E tests |
| Replaced owners | [Static snapshots](../17-replaced-element-snapshots.md), [ownership matrix](../184-replaced-ownership-transition-matrix.md), [live frames](../229-live-replaced-media-frame-ownership.md) | `src/capture/replaced-media-frame.ts` and replaced-media tests |
| Animated images | [Authenticated bytes](../231-authenticated-animated-image-byte-ownership.md), [static frame](../233-strict-animated-image-static-frame.md), [downstream ownership](../234-frozen-animated-image-downstream-ownership.md), [CSS/SVG owners](../236-strict-static-frames-for-svg-css-images.md) | authenticated collector/decoder/renderer modules and three-platform production gates |
| Export | [Video](../47-svg-to-video.md), [still image](../78-svg-to-image.md) | post-processing exporters and scrubber endpoint tests |

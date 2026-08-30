---
id: "requirements/background-clip-text-native-parity"
title: "228 — Native background-clip:text parity"
kind: "evidence"
status: "current"
owners: ["text-fonts","paint-effects","platform-release","product-tooling"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2530"]
code: [".github/workflows/background-clip-text-native-parity.yml"]
aliases: ["docs/228-background-clip-text-native-parity.md","doc-228"]
---

# 228 — Native `background-clip:text` parity

DM-2530 promotes the vector-only `background-clip:text` oracle from a local
macOS discriminator to an authenticated Linux and Windows gate. The browser is
always launched headlessly.

The gate records the Chromium executable path and SHA-256, browser version,
platform and architecture, pinned Chromium/Skia source revisions, DPR, and the
CDP-painted families and glyph counts for every fixture owner. Its fixture
crosses color, gradient and URL layers with transparent and opaque text paint,
stroke, inherited ownership, fragmented slice/clone boxes, fallback glyphs,
effective zoom, transform and clipping.

Logical ownership is adjudicated before terminal paint: selected URL records,
alpha glyph masks, vector patterns, transform/clip ownership and destructive
mask/pattern/transform controls must all be active. Only then may the existing
four-device-pixel signal-edge classifier describe the native Skia-versus-SVG
raster boundary. DM-2530 adds no platform envelope and changes no tolerance.

`.github/workflows/background-clip-text-native-parity.yml` collects independent
DPR 1 and 2 reports on native Linux and Windows runners, retains lossless PNG,
SVG and JSON artifacts, and aggregates only when both authenticated reports are
`source-exact`.

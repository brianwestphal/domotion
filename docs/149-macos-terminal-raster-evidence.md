---
id: "requirements/macos-terminal-raster-evidence"
title: "149 — macOS terminal-raster evidence"
kind: "evidence"
status: "current"
owners: ["images-media","platform-release","product-tooling"]
platforms: ["macos"]
tickets: ["DM-2440"]
code: []
aliases: ["docs/149-macos-terminal-raster-evidence.md","doc-149"]
---

# 149 — macOS terminal-raster evidence

`npm run fonts:macos-terminal-raster` is a diagnostic-only classifier for seven
records from macOS Chromium run 32366223808. It does not alter visual thresholds,
routing, shaping, or emission. A record is recognized only after exact face,
glyph, cluster, advance, UPEM, 32px paint, canonical source/subset outline, and
pinned-Skia quarter-pixel position-key agreement.

The measured terminal envelope is intentionally evidence-bound: changed pixels
must remain within one device pixel of thresholded ink, and each connected
region is capped at the observed 47 pixels, 23×24 bounds, and 83.5294 severity.
Neighboring same-face controls must remain exact-zero. Script and codepoint are
reporting labels, never activation keys.

Pinned metadata is Chromium 147.0.7727.15, Skia 62efacd3, macOS, and the source
run id. The `.SFMalayalam-Regular` CFF rows are eligible because DM-2440 isolated
both contributing raster factors: installed-versus-data CTFont provenance and
CFF2-to-static-CFF representation. They partially cancel in the final mask;
glyph-set breadth itself was exact-zero.

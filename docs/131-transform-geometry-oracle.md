---
id: "requirements/transform-geometry-oracle"
title: "131 — Transform, projection, and reflection geometry oracle"
kind: "evidence"
status: "current"
owners: ["layout","platform-release"]
platforms: []
tickets: []
code: []
aliases: ["docs/131-transform-geometry-oracle.md","doc-131"]
---

# 131 — Transform, projection, and reflection geometry oracle

`npm run transform:geometry-oracle` is the live-Chromium decision gate for
transform geometry. It generates adversarial boxes rather than relying on demo
screenshots, measures Chromium's four painted corners, and compares them with
the matrices emitted by Domotion's production transform builder.

The current corpus covers five affine compositions across center, edge,
percentage, and pixel transform origins; rotate, scale, skew, and translated
matrix forms; all four WebKit box-reflection directions with pixel and
percentage offsets; and a preserve-3d/perspective context. The affine rows must
remain vector-native within 0.02 CSS px. The projective row must activate the
Chromium subtree-snapshot boundary because SVG transform attributes cannot
represent perspective division, a non-affine fourth corner, preserve-3d
flattening, or backface compositing.

The gate includes a mutation control: removing the origin composition from the
center-rotation case must move at least one corner by more than one CSS pixel.
It runs in CI after the paint geometry browser oracle.

This is a decision-level gate, not a replacement for visual integration. The
`preserve-3d-translatez-paint-order` fixture proves the projective snapshot is
positioned and composited pixel-exactly, while the existing reflection fixtures
cover duplication and mask paint.

Animated projective geometry has its independent hard gate in
[doc 186](186-animated-3d-frame-state-parity.md). It samples eight 3D families
at four exact document times and DPR 1/2, compares fresh CDP quads and computed
composition with the serialized frame record, and verifies outer atomic-raster
ownership without fitting a 2D matrix.

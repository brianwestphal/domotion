---
audience: developers upgrading the domotion-svg npm package
tone: concise, user-facing, friendly
guidance: |
  Domotion is a DOM-to-animated-SVG renderer: it captures HTML/CSS in
  Playwright Chromium and emits a self-contained, pixel-faithful SVG with
  optional CSS animations.

  Write each bullet as one short line a consumer upgrading the package would
  care about. Group related commits into a single bullet. Prefer fewer, clearer
  bullets over an exhaustive list.

  INCLUDE: new capture/render/animation features, rendering-fidelity fixes a
  user would see, CLI flag additions, and breaking changes (with a one-line
  migration note).

  EXCLUDE: Hot Sheet ticket IDs (DM-####), commit hashes, internal refactors,
  test-only changes, doc-only changes, and build/CI tweaks. Never reference
  DM-#### ticket numbers — they are local-only and meaningless to consumers.
---

## ⚠️ Breaking Changes
<!-- Anything that requires the reader to change their code, CLI invocation, or config. Include a short migration note for each. Omit this section if there are none. -->

## 🚀 Features
<!-- New capture / render / animation capabilities and CLI flags. One bullet per user-facing change. -->

## 🐛 Fixes
<!-- User-visible rendering-fidelity and behavior fixes only. -->

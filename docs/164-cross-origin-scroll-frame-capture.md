---
id: "requirements/cross-origin-scroll-frame-capture"
title: "164 — Cross-origin iframe recursion during scroll capture"
kind: "contract"
status: "current"
owners: ["layout"]
platforms: []
tickets: []
code: []
aliases: ["docs/164-cross-origin-scroll-frame-capture.md","doc-164"]
---

# 164 — Cross-origin iframe recursion during scroll capture

Scroll capture now passes `ScrollExecutorOptions.crossOriginFrames` into every segment's ordinary or self-contained `captureElementTree` call. The CLI supplies the same value used to build `crossOriginFramesLaunchArgs`, so the launch-time web-security opt-in and the per-host recursion gate cannot diverge between static and scroll modes.

The browser test uses separate localhost origins and two scroll anchors. An allowlisted frame remains native, retains its inner text, moves by the exact 40px viewport offset, and has no duplicate captured IDs in either segment. A non-allowlisted host remains an isolated raster in both segments. The existing warning and trusted-page CLI notice are unchanged; no allowlist still means raster-only.

[Doc 217](217-cross-origin-frame-scroll-ownership.md) strengthens this plumbing
into an exact per-anchor ownership protocol. A random capture-local handshake
joins each Playwright browsing context to Chromium's DevTools `FrameId`, binds
that ID to its exact iframe owner element, seals parent-relative allowlist and
reachability decisions, and carries raw frame-local scroll owners/offsets into
composition. Denied/inaccessible ancestors expose no descendant owners, and
composition rejects stale capture IDs, omitted allowlists, wrong-frame owners,
or mismatched frame-local scrollbars. This is logical provenance; it adds no
pixel comparison or tolerance.

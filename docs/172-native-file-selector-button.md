---
id: "requirements/native-file-selector-button"
title: "172 — Native file-selector button ownership"
kind: "contract"
status: "current"
owners: ["rendering"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2454"]
code: ["tests/native-control-decoration.e2e.test.ts"]
aliases: ["docs/172-native-file-selector-button.md","doc-172"]
---

# 172 — Native file-selector button ownership

DM-2454 treats `<input type=file>` as two closed-UA-shadow children with
different owners: Chromium's real `input[type=button]` owns native button
paint, while its following status `span` remains shaped vector text. The file
host, its focus outline, clipping, opacity, transforms, and author paint remain
structural SVG.

## Pinned source boundary

Pinned Chromium revision:
`7d859f271cbda744098ac69f44978d4edfa62be3`.

- `third_party/blink/renderer/core/html/forms/file_input_type.cc:381-435`
  creates a real closed-shadow `<input type=button id=file-upload-button>` and
  then the filename/status `<span>`; `file_input_type.cc:628-645` updates the
  button value and exact localized status string.
- `third_party/blink/renderer/core/html/resources/html.css:796-829` gives the
  button `appearance:auto`, inherited font, and a 4 px logical-end margin.
  The margin is layout between siblings, not native button pixels.
- `third_party/blink/renderer/core/layout/layout_theme.cc:83-131,194-203,485-506`
  resolves the child to `push-button` until author background, border,
  border-radius, or explicit structural appearance transfers ownership to CSS.
  Author color, font, padding, and box-shadow do not by themselves surrender
  native theme paint.
- `third_party/blink/renderer/core/paint/theme_painter.cc:121-141` and
  `theme_painter_default.cc:420-436` send the child's complete border box,
  state, scheme, forced-color, accent, and zoom inputs to platform button
  paint. No platform-neutral sampled button is source-equivalent.

## Capture and routing

`pseudo-style-cdp.ts` pierces the closed tree, retains the exact button and its
topology-defined following status span, and asks CDP for the child button's
matched/computed/animated style facts. File routing intentionally ignores the
host's `appearance:none`: the child EffectiveAppearance is the owner.

| Child result | Render route |
| --- | --- |
| `push-button`, or conservatively unknown | reserve source-owned file button; unknown facts warn/fail closed |
| author background/border/radius or `appearance:none` | existing author-styled vector button route |
| missing/detached/rebuilt/changed button or status topology | named `native-control-decoration-raster` warning; no sampled button fallback |

The synchronous walk records the button's real border rect, localized value,
used font metrics, box-shadow, writing direction, and the status span's exact
text plus `captureTextSegments` geometry. This fixes multiple-selection labels
such as `2 files`, localization, long-label clipping, RTL, and vertical
writing; `input.files[0].name` and `Choose File(s)` literals are legacy-tree
fallbacks only.

## Source-frame materialization and paint order

`native-control-decoration-raster.ts` keeps the host geometry and interaction
state fixed, makes every unrelated page node transparent, hides only the real
status span, and restores the child button's own text fill. It validates both
retained objects, closed-root host, used quads, active/focus/hover/active state,
all style restoration, and a byte-identical full-page image after capture.

The bitmap crop is the child border quad exactly, snapped once at capture DPR.
It excludes the 4 px logical margin and filename. Author outset box-shadow
overflow is emitted structurally outside that exact crop and clipped by the
file host; shadow pixels already inside the native crop are not duplicated.
The SVG phase is:

1. structural host box/focus outline;
2. file-button outset-shadow overflow;
3. exact Chromium child `<image>`;
4. source-shaped status text.

A reservation suppresses the old sampled button whether the bitmap is
materialized, proved empty, or unavailable. Author-owned buttons keep the
vector route but use the real child rect/value and the same captured status
segments.

## Focused evidence

- classifier and pierced-node unit controls cover host-none/child-push-button,
  CSS-owned child negatives, file button mapping, and status topology;
- renderer controls prove reservation suppresses `Choose File`, actual status
  survives, author paint uses the real child rect/value, and split shadow
  overflow excludes the bitmap box;
- `tests/native-control-decoration.e2e.test.ts` covers DPR 2 fractional
  origins, empty and multiple selection, vertical-RTL layout, an author-owned
  button negative, exact capture restoration, and image-before-status order;
- the broader platform control matrix retains disabled, pointer/focus state,
  light/dark/forced-colors, zoom, DPR, and macOS/Linux/Windows execution.

---
id: "requirements/inner-live-scroll-capture"
title: "147. Inner live-scroll capture"
kind: "contract"
status: "current"
owners: ["layout"]
platforms: []
tickets: ["DM-2703"]
code: ["src/scroll/composer.ts","src/scroll/executor.ts"]
aliases: ["docs/147-inner-live-scroll-capture.md","doc-147"]
---

# 147. Inner live-scroll capture

Domotion's scroll executor captures the live DOM at every scroll anchor. It
does not assume that one tall, immutable bitmap exists. This makes recycled or
virtualized lists a supported input: set the inner element with
`--scroll-selector`, and rows regenerated after each `scrollTop` change are
captured in the following segment.

Capture ownership is independent from scroll ownership:

- `--scroll-selector '#list'` chooses the element whose `scrollLeft` /
  `scrollTop` the pattern drives.
- `--selector '#list'` chooses the DOM subtree captured at every anchor.
- `--clip x,y,width,height` chooses the page-space rectangle captured and the
  output SVG's dimensions.

Combining all three produces a list-only animated strip. Fixed or sticky page
chrome outside the rectangle is neither captured nor repeated in the composite.
For example:

```sh
domotion capture app.html \
  --scroll 'down:bottom/8s' \
  --scroll-selector '#list' \
  --selector '#list' \
  --clip '30,187,640,382' \
  -o list-scroll.svg
```

Animate configs carry the same distinction. The frame-level `selector` is the
captured subtree; `scroll.selector` is the scroller; and `scroll.clip` is the
optional page-space crop:

```json
{
  "input": "app.html",
  "duration": 8000,
  "selector": "#list",
  "scroll": {
    "pattern": "down:bottom/8s",
    "selector": "#list",
    "clip": [30, 187, 640, 382]
  }
}
```

When the capture selector includes page context around an element scroll owner
(the default `body` capture is the common case), the composer keeps the first
capture's surrounding page as a static underlay. Only the authenticated
scroller subtree is stacked and translated through its recorded offsets, so
the element's border box stays at its captured DOM/CSS position while its live
contents and scrollbar move inside it. A fixed chain of the owner's and every
clipping ancestor's used overflow geometry encloses the whole moving stack.
These clips retain padding-box insets and per-corner radii, so a scroller nested
inside an `overflow: hidden` rounded panel cannot square off its ancestor's
corners, and per-anchor overflow clips cannot translate across the surrounding
page. The static underlay is rendered before the shared embedded-font snapshot
is emitted, so its subset glyphs remain available alongside glyphs from every
moving capture (DM-2703, DM-2704).
Setting the capture selector to the scroller itself intentionally retains the
list-only strip behavior shown above.

The capture is live by construction: the executor performs an instant scroll,
waits for layout/paint to settle, then invokes the normal DOM capture pipeline.
It repeats that sequence for every viewport-sized anchor. A virtual list must
therefore update synchronously or within the normal settle window after its
scroll event; applications with longer asynchronous updates should include an
appropriate pause in the pattern.

Every anchor also carries an authenticated source record for the selected
owner: Chromium `FrameId`, capture-local live-node owner ID, raw offset and the
exact cross-origin allowlist/frame graph. The current selector API resolves in
the top document; child-frame owners are retained for nested scrollbar and
resource correlation, not accepted as substitute composition anchors. A
fresh state is required for every anchor, so DOM reuse cannot inherit a prior
allowlist. See [doc 217](217-cross-origin-frame-scroll-ownership.md).

The composed SVG animates between the recorded anchors. It does not execute the
application's virtualization code at playback time, so the result remains
self-contained and deterministic.

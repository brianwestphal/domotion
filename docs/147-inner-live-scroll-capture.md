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

The capture is live by construction: the executor performs an instant scroll,
waits for layout/paint to settle, then invokes the normal DOM capture pipeline.
It repeats that sequence for every viewport-sized anchor. A virtual list must
therefore update synchronously or within the normal settle window after its
scroll event; applications with longer asynchronous updates should include an
appropriate pause in the pattern.

The composed SVG animates between the recorded anchors. It does not execute the
application's virtualization code at playback time, so the result remains
self-contained and deterministic.

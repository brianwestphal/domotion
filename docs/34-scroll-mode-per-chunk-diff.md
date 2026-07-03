# 34. Scroll-mode per-chunk diff

`*-scroll` real-world fixtures (e.g. `apple-mobile-scroll`, `stripe-mobile-scroll`) drive Chromium through a smooth top-to-bottom scroll while Domotion captures the DOM at each viewport-height interval and composes the captures into a single animated SVG. The scroll executor and composer are the same machinery the `--scroll` CLI flag uses (see `src/scroll/{pattern,executor,composer}.ts`).

The diff harness for these fixtures runs **per chunk**: one expected/actual/diff PNG triplet per scroll position the executor visited. This lets a reviewer see whether a regression is universal across the page or localized to one section, and lets the harness distinguish "Domotion never paints this" from "Domotion paints this in a frame the t=0 diff doesn't see."

## What gets captured

For a `*-scroll` fixture with N executor segments (chunks):

- **Canonical triplet** (chunk 0, t=0):
  - `<name>-expected.png` — Chromium screenshot of the live page at scrollY=0
  - `<name>-actual.png` — composed SVG screenshotted at animation frame 0 (`animations: "disabled"`)
  - `<name>-diff.png` — pixel diff of the above
- **Per-chunk triplets** for chunks 1..N-1:
  - `<name>-expected-{i}.png` — Chromium screenshot of the live page scrolled to `segments[i].scrollY`
  - `<name>-actual-{i}.png` — composed SVG with its CSS animation seeked to `segments[i].segmentEndMs` (via `document.getAnimations()` → `currentTime` + `pause`), then screenshotted
  - `<name>-diff-{i}.png` — pixel diff

The canonical triplet always exists (no behavior change for downstream tools that don't know about chunks). The per-chunk triplets exist only when N > 1.

## Manifest shape

`tests/output/real-world/results.json` carries an optional `chunks` array on each scroll-mode result:

```jsonc
{
  "name": "apple-mobile-scroll",
  "mode": "scroll",
  "diffPct": 2.43,           // canonical t=0 diff (chunk 0)
  // ...other canonical metrics...
  "chunks": [
    { "index": 0, "scrollY": 0,    "segmentEndMs": 0,     "diffPct": 2.43, /* ...*/ },
    { "index": 1, "scrollY": 844,  "segmentEndMs": 1000,  "diffPct": 1.87, /* ...*/ },
    { "index": 2, "scrollY": 1688, "segmentEndMs": 2000,  "diffPct": 4.12, /* ...*/ }
  ]
}
```

Chunk 0's metrics mirror the canonical metrics for the same triplet.

## Capture-side details

- **Source page**: scrolling back to each `segments[i].scrollY` re-runs intersection observers, which can start new animations the original freeze pass didn't catch. The harness runs a follow-up `getAnimations().pause()` after each scroll to suppress those before screenshotting.
- **Render page**: the composed SVG's animation runs over `segments[N-1].segmentEndMs`. Seeking to `segments[i].segmentEndMs` lands exactly on a composer keyframe anchor (not interpolated), so the rendered frame matches what the SVG paints when the consumer actually scrolls to that point.
- **`animations: "disabled"`** is passed to the *expected* (source-page) screenshots so Playwright freezes the moment of capture independently of any animations Chromium might still be running. The one deliberate exception is the per-chunk *actual* (composed-SVG) screenshot, which OMITS the flag (`tests/real-world.tsx`): the SVG's transition is an infinite CSS animation seeked via `currentTime`, and `animations: "disabled"` would cancel it and undo the seek — so the actual frame is screenshotted with animations live at the seeked time.

## Pass criterion

Unchanged from before this feature: real-world `scroll` mode never `pass`es (the criterion is `mode === "fold" && cmp.regionCount === 0`). The chunk metrics are informational — they let the review surface and ticket-filing flow reason about which scroll position a regression appears at, not whether the test passes overall.

## Composite-against-composite diffing (out of scope)

A future iteration could compare a Chromium-recorded video of the live scroll against a recording of the SVG playback. That would test the composed animation as consumers actually see it, including timing/easing. Per-chunk diffing is the cheaper path that catches the same per-position regressions without a video-recording dependency.

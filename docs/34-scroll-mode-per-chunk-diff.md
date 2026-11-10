---
id: "requirements/scroll-mode-per-chunk-diff"
title: "34. Scroll-mode per-chunk diff"
kind: "contract"
status: "current"
owners: ["layout"]
platforms: []
tickets: ["DM-4GXCMQ", "DM-TRM653", "DM-P0X82N", "DM-SJBWJC"]
code:
  [
    "tests/real-world.tsx",
    "tests/real-world-scroll-reference.ts",
    "tests/real-world-scroll-reference.e2e.test.ts",
    "tests/real-world-scroll-reference.test.ts",
    "tests/real-world-dom-freeze.ts",
    "tests/real-world-dom-freeze.e2e.test.ts",
    "src/scroll/executor.ts",
  ]
aliases: ["docs/34-scroll-mode-per-chunk-diff.md", "doc-34"]
---

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
  - `<name>-expected-{i}.png` — capture-time Chromium screenshot retained with `segments[i]` at its `scrollY`
  - `<name>-actual-{i}.png` — composed SVG with its CSS animation seeked to `segments[i].segmentEndMs` (via `document.getAnimations()` → `currentTime` + `pause`), then screenshotted
  - `<name>-diff-{i}.png` — pixel diff

The canonical triplet always exists (no behavior change for downstream tools that don't know about chunks). The per-chunk triplets exist only when N > 1.

## Manifest shape

`tests/output/real-world/results.json` carries an optional `chunks` array on each scroll-mode result:

```jsonc
{
  "name": "apple-mobile-scroll",
  "mode": "scroll",
  "diffPct": 2.43, // canonical t=0 diff (chunk 0)
  // ...other canonical metrics...
  "chunks": [
    { "index": 0, "scrollY": 0, "segmentEndMs": 0, "diffPct": 2.43 /* ...*/ },
    { "index": 1, "scrollY": 844, "segmentEndMs": 1000, "diffPct": 1.87 /* ...*/ },
    { "index": 2, "scrollY": 1688, "segmentEndMs": 2000, "diffPct": 4.12 /* ...*/ },
  ],
}
```

Chunk 0's metrics mirror the canonical metrics for the same triplet.

## Capture-side details

- **Source page**: each executor capture pauses currently known document animations in the relevant frames at their sampled times. Setting the same resolved `currentTime` completes pending pauses without seeking to the animation end. Inactive timelines with no resolved time or effect progress remain unchanged; their `ready` promises can stay pending indefinitely. Frame pause work has a shared 2000 ms Node-owned deadline and fails before publishing reference pixels if active paint cannot settle (DM-TRM653 / DM-4GXCMQ). The harness then uses `captureElementTreeWithDebug` to retain source PNG bytes with that anchor's tree. The explicit capture ordinal determines the output filename; reference count must equal segment count. Source references are not reconstructed by scrolling back later.
- **Render page**: the composed SVG's animation runs over `segments[N-1].segmentEndMs`. Seeking to `segments[i].segmentEndMs` lands exactly on a composer keyframe anchor (not interpolated), so the rendered frame matches what the SVG paints when the consumer actually scrolls to that point.
- **Screenshot animations**: source and per-chunk actual screenshots omit `animations: "disabled"`. Playwright's installed `screenshotter.js` calls `animation.finish()` for finite animations even when they are paused, while canceling infinite animations. That changes paint instead of preserving the sampled state. The harness pauses source animations without seeking; the actual animation is explicitly paused at its composed anchor.

DM-4GXCMQ reproduced the distinction on the fixed Resend desktop recording at scrollY 11469: a footer wordmark with near-zero captured opacity became fully visible only when the later reference screenshot finished its entrance animation. The correction preserves the captured state; it does not force the wordmark visible or change production SVG paint/culling. The Chromium `Page.captureScreenshot` protocol records pixels; the finite-animation finishing policy belongs to Playwright's screenshot preparation, not the renderer. Browser regressions exercise hidden, intermediate and complete wordmark opacity, anchor pairing, evidence failures, unresolved inactive scroll timelines, and active-to-inactive scroll timeline transitions. The sampled-time pause follows the [Web Animations current-time setter](https://www.w3.org/TR/web-animations-1/#setting-the-current-time-of-an-animation); the deadline does not depend on page timers, which the real-world freeze may override.

This is a paused-animation comparison contract. It does not claim an atomic snapshot of arbitrary live JavaScript mutations, newly created animations, or network-driven DOM changes. The existing real-world DOM freeze still limits those independent sources of drift.

## Live JavaScript motion (DM-P0X82N)

`freezeRealWorldDom` intentionally preserves author `requestAnimationFrame` callbacks so page warmup and WebGL priming can finish. Pausing Web Animations does not pause JavaScript-written DOM transforms. The capture debug source screenshot runs before the asynchronous capture prepasses; a live rAF loop can therefore move an element before the tree walk even though the source PNG and tree belong to the same capture call.

The recorded Stripe mobile logo carousel demonstrates this distinction with the JQ font and TRM pause-readiness controls applied. Its `ul.logo-carousel__marquee` moves about 15 px in 500 ms after both the DOM freeze and WebGL output freeze. The source PNG records the track near x = −89 px, while the later tree records x = −123 px. A static render of that tree reproduces the logo shift without scroll composition. This identifies live author DOM motion across capture stages; it does not justify changing renderer geometry or forcing the carousel to a chosen position.

The browser contract regression keeps a self-scheduling rAF transform loop alive through the initial DOM freeze. Capture-time reference/runtime ownership **after** warmup and graphics priming remains the actionable fix in DM-SJBWJC. Global rAF cancellation during warmup is not a substitute: it can break the WebGL source and capture-owned waits. This investigation establishes the current limitation rather than claiming arbitrary-JavaScript snapshot coherence.

## Pass criterion

Unchanged from before this feature: real-world `scroll` mode never `pass`es (the criterion is `mode === "fold" && cmp.regionCount === 0`). The chunk metrics are informational — they let the review surface and ticket-filing flow reason about which scroll position a regression appears at, not whether the test passes overall.

## Composite-against-composite diffing (out of scope)

A future iteration could compare a Chromium-recorded video of the live scroll against a recording of the SVG playback. That would test the composed animation as consumers actually see it, including timing/easing. Per-chunk diffing is the cheaper path that catches the same per-position regressions without a video-recording dependency.

# 221 — Scroll/view/rAF timeline sampling ownership

**Status:** DM-2531 source and live investigation complete. Production rejects
enumerated document-TreeScope ScrollTimeline/ViewTimeline seeks, silently
misses progress animations in other TreeScopes, and neither owns nor reports
requestAnimationFrame motion. DM-2553 and DM-2554 own the two bounded
implementation protocols. No capture semantics, raster threshold, or
tolerance changed in this investigation.

## Question and verdict

`animationTimeMs` is an exact document-timeline coordinate. It is not a common
clock that can be applied to every animation-like source in a page:

- a scroll/view timeline exposes a CSS percentage derived from a post-layout
  snapshot of scroll and range state, not an absolute millisecond;
- a composited scroll-linked effect can tick from the compositor scroll tree;
- an rAF callback is script scheduled by `PageAnimator`, not a WAAPI
  `Animation`, and therefore never appears in `document.getAnimations()`.

The exact partial primitives are narrower than a universal seek. A resolved
progress-timeline effect can be paused and held at its own sampled
`CSS.percent(...)`, but that does not freeze the timeline source, its range, or
the compositor scroll state. The tested Playwright clock stops benign calls
through the replaced page global, but page script can reach its saved native
rAF through `__pwClock.builtins`, and worker rAF is not instrumented. A future
protocol must own or explicitly reject those queues; current production does
neither.

## Pinned Blink and compositor trace

The audited Chromium checkout is
`7d859f271cbda744098ac69f44978d4edfa62be3`.

| Source | Exact ownership consequence |
| --- | --- |
| `core/animation/animation.cc:512-590` | `currentTime` accepts an absolute number only for a document timeline. A progress timeline requires a CSS percentage and rejects an absolute value. |
| `core/animation/animation.cc:593-665,674-720` | A successful seek writes a hold/start time and marks the compositor pending; exposed scroll-snapshot times convert back to CSS percentages. |
| `core/animation/animation.cc:1654-1728,2898-3014` | `pause()` on a finite, non-monotonic timeline can remain auto-aligned until snapshot validation. Snapshot duration/range changes preserve percentage progress and may require another style/layout/compositor update. Pausing alone is not proof of a held effect. |
| `core/frame/post_layout_snapshot_client.h:18-35` | Timeline snapshots are refreshed after layout; an invalid snapshot requests another style/layout pass, and a state difference can schedule another frame. |
| `core/animation/scroll_snapshot_timeline.cc:21-70,137-160,186-266` | Public time is read from `timeline_state_snapshotted_` as a percentage. Snapshot comparison writes the new state before range resolution, validates every animation, and marks the compositor timeline pending when state changes. |
| `core/animation/document_animations.cc:190-248` | Timeline animation timing is serviced before the microtask checkpoint; post-layout snapshot clients own the later scroll-timeline scheduling path instead of ordinary `ScheduleNextService()`. |
| `core/animation/document_animations.cc:277-290,404-425` | `Document.getAnimations()` requests one `TreeScope`, and Blink filters out targets belonging to another scope. The current helper therefore cannot use document enumeration as proof that shadow-root progress animations are absent. |
| `core/animation/scroll_timeline.cc:78-150` | Current time is derived from the physical scroll offset and positive used range at 16 microseconds per layout pixel. Effective zoom and resolved scroll limits are part of the snapshot. |
| `core/animation/view_timeline.cc:304-379,484-544` | The range comes from subject size/static position, viewport, resolved insets, and sticky adjustments. `SubjectPosition()` ignores transforms. An HTML/CSS `LayoutBox` uses `StitchedSize()`, but an SVG child maps its decorated bounds through `LocalToAncestorQuad(...).BoundingBox()`, so SVG transforms can change timeline time. |
| `core/animation/scroll_timeline_util.cc:18-38` | Blink gives the compositor a scroll-element ID, physical orientation, and the resolved scroll offsets. |
| `cc/animation/scroll_timeline.cc:57-156,164-220` | The compositor reads its active/pending scroll tree, computes time from the physical offset, promotes pending IDs/ranges, and directly ticks scroll-linked animations. An unchanged last tick lets the compositor go idle. |
| `core/page/page_animator.cc:41-110,114-303` | PageAnimator gathers local documents, fixes each document animation clock for the rendering update, services scroll animations, then dispatches events/tasks and finally executes rAF callbacks at the document timeline time. |
| `core/dom/scripted_animation_controller.cc:100-108,176-182,238-249` | rAF registration stores a callback and schedules a main frame; execution drains that callback collection. The queue is independent of WAAPI animation enumeration and schedules another frame while callbacks remain. |

This order rules out two tempting approximations. A document millisecond is not
a progress percentage, and a painted/projected subject quad is not a
ViewTimeline range. The source state has to be carried explicitly.

## Current capture discriminator

`src/capture/animation-frame.ts` deliberately keeps its document-timeline
contract. For every Frame it:

1. waits two rAF callbacks for initial style/animation enrollment;
2. calls `pause()` and assigns the requested numeric millisecond to every
   `document.getAnimations()` result;
3. waits two more rAF callbacks and requires stable enumeration, numeric time,
   and paused/finished state.

That rejects progress timelines visible to the queried document TreeScope.
The numeric assignment is rejected and the later `currentTime` remains a
`CSSUnitValue`, so strict capture reports both facts. It does not query shadow
roots: after cancelling document-scope animations, strict capture succeeds
while open- and closed-shadow progress animations remain live. It is also not
fail-closed for rAF motion; its settle callbacks can mutate DOM state.

## Exact live logical oracle

`tools/timeline-sampling-ownership-oracle.ts` serves the main document from
`127.0.0.1` and a child from `localhost`, launches with
`--site-per-process`, and verifies separate DevTools `page` and `iframe`
targets. It reads CSS percentage times, effect progress, computed opacity,
exact scroll offsets, DevTools content quads, callback counters, target IDs,
and target-local clock time. It never reads a pixel and defines no numeric
visual envelope.

Run it directly or through the focused tests:

```sh
node --import tsx tools/timeline-sampling-ownership-oracle.ts --json /tmp/dm2531-oracle.json
npx vitest run tests/timeline-sampling-ownership-oracle.test.ts
npx vitest run --config vitest.e2e.config.ts tests/timeline-sampling-ownership-oracle.e2e.test.ts
```

The authenticated local run used Headless Chrome `147.0.7727.15`, Playwright
`1.59.1`, macOS arm64, and two distinct renderer targets. All eleven logical
discriminators were active in both the main target and OOPIF:

| Mutation | Exact observation |
| --- | --- |
| absolute milliseconds | Every enumerated progress animation rejected `currentTime = 375`; strict mode threw with refusal and non-document-time records. |
| transformed scroller | The CDP quad and computed transform changed while `scrollTop` and ScrollTimeline time remained exactly `31.96969696969697%`. |
| projective HTML-box subject | A non-parallelogram CDP quad changed while ViewTimeline time remained exactly `14.678899082568808%`, authenticating the HTML/CSS-box branch only. |
| transformed SVG subject | At fixed `scrollTop`, mapped SVG bounds and ViewTimeline time changed from `20.909090909090907%` to `19.615384615384613%`. |
| exact percentage hold | Reassigning each sampled percentage held all three effects exactly while moving the source changed all source timeline percentages. |
| TreeScope enumeration | Each target had three document, one open-shadow, and one closed-shadow progress animation. With only shadow animations left, strict capture returned success. |
| current settle versus rAF | Main/OOPIF callback counters advanced from `3` to `7` while the current helper tried to settle one capture. |
| benign pre-navigation clock | After pausing at `performance.now() === 1000`, callbacks through the replaced global stayed exactly frozen in both targets. |
| page-visible native escape | Under the same frozen clock, `__pwClock.builtins.requestAnimationFrame` loops advanced from `17` to `29` in both targets. |
| worker escape | Dedicated-worker rAF messages advanced from `17` to `29` in both targets while page clocks stayed frozen. |
| late-install escape | Both globals exposed a paused fake `performance.now() === 1`, but callbacks that had retained native rAF advanced in both targets. A visible frozen clock is therefore insufficient proof. |

The oracle fingerprints Playwright's server and injected clock sources.
`lib/server/clock.js:95-110` reaches existing frames, but `clockSource.js`
returns `{controller, builtins}` to page-visible `__pwClock`, and context init
scripts do not instrument worker globals. The benign arm therefore proves
replacement behavior, not complete callback ownership. Compositor
active/pending-tree ownership in this investigation is pinned-source evidence;
the live discriminator observes exposed timeline/effect state, not internal CC
tree state.

## Freezeability and fail-closed matrix

| State | Deterministic disposition before every capture prepass |
| --- | --- |
| document-timeline CSS/WAAPI or SMIL | Already supported by the exact millisecond protocol in doc 186. |
| active ScrollTimeline/ViewTimeline effect with resolved CSS percentage | Potentially holdable: pause, assign the same exact CSS percentage, commit, and reverify effect time/progress/output. This freezes the effect only. |
| stable progress source and range | Must authenticate source identity, writing mode/direction and reversed logical axis, signed physical offset/limits, subject type/size/static position, SVG mapped bounds, insets, sticky adjustments, zoom, post-layout snapshot, and compositor commit. DM-2553 owns this record. |
| progress animation outside the queried TreeScope | Fail until every reachable document/open-shadow scope is enumerated and the closed/inaccessible-scope policy is explicit. |
| inactive/unresolved progress timeline | Fail: there is no percentage to hold or verify. |
| smooth/compositor scroll, source/range mutation, target churn, or prepass drift | Fail: a held effect does not own those inputs. |
| rAF through a replaced page global | The tested pre-navigation clock stops this benign case only; page-visible native builtins and workers prevent an ownership claim. |
| saved-native/page-builtin rAF, worker rAF, uninstrumented/new target, mismatched time, or changing counter | Fail: callback ownership is incomplete. DM-2554 must own, disable, or reject every escape. |
| paused fake rAF plus the current two-rAF settle helper | Fail: the settle promise cannot run while the shim is paused. A future protocol needs a controlled tick or authenticated non-rAF rendering barrier. |

## Bounded follow-ups

- **DM-2553 — Implement exact ScrollTimeline/ViewTimeline percentage-hold and
  source-snapshot capture protocol.** Carry every resolved percentage and
  source/range/compositor fact before every prepass; resolve writing
  mode/direction and RTL/reversal; support or reject the SVG mapped-bounds
  branch; enumerate or explicitly refuse every document and shadow TreeScope;
  prevalidate or roll back before a non-mutating rejection; and kill drift,
  inactive, hidden-scope, and target-churn mutations without mapping a document
  millisecond to progress.
- **DM-2554 — Install and authenticate pre-navigation rAF clocks across main
  and OOPIF capture targets.** Use non-page-visible ownership or fail-closed
  detection for saved native builtins; own, disable, or reject dedicated-worker
  rAF; prove target identity and one paused time; replace the paused-rAF settle
  barrier; reject late/native escape and target churn; then run the combined
  progress/source/controlled-rendering/rAF ordering gate after DM-2553.

Until those tickets land, the production statement remains unchanged:
document timelines are deterministic; enumerated document-scope scroll/view
timelines are reported and rejected rather than approximated, shadow-scope
progress can be missed, and rAF is unsupported, unreported, and can mutate
state during the current settle.

# DM-FTRBES: visibility transition ownership during raster isolation

The native-control isolation path can preserve final source pixels while destroying an authored transition or baking an unrelated overlay into its stamp. The replaced-element path currently refuses the active-transition case explicitly and preserves source state. No production repair is made by this investigation; **DM-THP2FS** owns it.

The verified source is Chromium 147, revision `6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050`. The checkout is published `1abdf3d6` plus the explicit D8 prerequisite `5b9d6b0d` (local cherry-pick `30ce1906`). The [evidence manifest](dm-ftrbes-evidence.json) contains exact hashes, observations and commands.

## Actual producer behavior

The 16-case native/replaced matrix crosses target versus unrelated overlay, visible-to-hidden versus hidden-to-visible, and paused versus running transitions. Each source transition lasts 30 seconds and is initialized at 10 seconds; capture never changes its source time afterward.

| Route and transition owner                     | Observed result                                                                                                                                |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Native, unrelated overlay, destination hidden  | Original transition survives, but used visibility stays visible. An otherwise transparent stamp guard contains `[255,255,255,51]`; no warning. |
| Native, unrelated overlay, destination visible | Original becomes idle with null time and two CSS cancellation events; overlay alpha still leaks, with no warning.                              |
| Native, retained target                        | D8's redundant-write avoidance preserves original state and a transparent guard in all four cases.                                             |
| Replaced, either owner                         | Explicit isolation failure before mutation; no emitted raster, original state and source paint retained.                                       |

The live source image is restored in every producer case. That pixel equality alone does **not** establish animation preservation or isolated stamp ownership.

## Exact Blink mechanism

- [`CSSAnimations::CalculateTransitionUpdateForPropertyHandle`](https://chromium.googlesource.com/chromium/src/+/6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050/third_party/blink/renderer/core/animation/css/css_animations.cc#2542) returns when the after-change destination matches the running transition's destination. Otherwise it queues cancellation; the apply phase around lines 2390–2405 clears ownership and calls `cancel()`.
- [`CanCalculateTransitionUpdateForProperty`](https://chromium.googlesource.com/chromium/src/+/6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050/third_party/blink/renderer/core/animation/css/css_animations.cc#2494) skips retargeting while an ordinary animation contributes that property. Its existing comment explicitly discusses important declarations.
- [`KeyframeEffect::Create(source)`](https://chromium.googlesource.com/chromium/src/+/6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050/third_party/blink/renderer/core/animation/keyframe_effect.cc#250) clones the model/timing and copies native priority and the event delegate.
- [`Animation::setEffect`](https://chromium.googlesource.com/chromium/src/+/6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050/third_party/blink/renderer/core/animation/animation.cc#1361) changes ignore-CSS flags on the assigned effect and rebinds its event delegate. The base [`Animation::CreateEventDelegate`](https://chromium.googlesource.com/chromium/src/+/6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050/third_party/blink/renderer/core/animation/animation.h#518) returns null.

## Rejected shortcuts

Changing the original effect's keyframes permanently sets its ignore-CSS flag and replaces its native transition model. Swapping its effect and later reattaching the original also changes that original's ignore-CSS flags. Matching immediate pixels and `getKeyframes()` output does not undo those internal changes.

Simply creating `Animation(clonedEffect)` retains the copied CSS event delegate. Canceling that owned animation then causes spurious source CSS cancel/run events. The raw probe reproduces this despite preserving the original animation object.

## Qualified browser protocol

The test-only prototype uses two owned animations and never changes the original animation, effect, keyframes, timing, start time or playback controls:

1. An ordinary owned visibility animation prevents CSS transition retargeting, so no guessed authored destination is needed.
2. A clone retains native transition paint priority and supplies constant isolated visibility. Assign it to a **private base Animation** with an existing empty effect targeting the same element. This resets the clone's copied CSS event delegate through the base setter; it does not touch the source object.
3. Restore isolation styles and source attributes, then cancel only the two owned animations. Non-active visibility transitions are kept immediate during style restoration.

Nine native contracts cross target/overlay, both directions and paused/running state, plus failed-readback cleanup. They require original animation/effect identity **throughout**, original frames/timing, paused time exactly 10,000 ms or unchanged running start time with natural clock progress, unchanged CSS and original Animation event counters, and no extra animations after cleanup. The isolated canvas has exact transparent pixels outside its blue paint and exact opaque blue inside. Restored source pixels are exact.

The proof applies to these ordinary same-document Element fixtures. It is **not** production admission, arbitrary-animation atomicity or a guarantee under concurrent author edits.

## Repair and remaining qualification

DM-THP2FS must integrate an owned controller with existing replaced/native callers. Source visibility, source occlusion and source-frame facts must be read **before** isolation changes. Preserve D8's exact null/literal attribute cleanup and the known custom-callback boundary DM-Q4J4JG. Do not mutate index/external-CSS ownership surfaces without coordination.

Validate actual pipeline pixels and events, readback/cleanup failures and foreign ownership before admitting a raster. Pseudo targets, cross-document contexts, non-document timelines, author-modified effects, natural completion/concurrent source edits, and partial-native mutations of other transition properties remain unqualified. Keep explicit diagnostics or type separate proved gaps rather than weakening assertions, copying a contaminated backdrop or silently omitting paint.

## Validation and independent failure

Gate 305 passed typecheck, build/package-dist, lint, text-engine 1,800 plus 3 transport tests, root 5,688 tests and documentation checks (277 documents). The native combined lane passed 35 of 36, including all nine new contracts, and failed the unchanged existing number-decoration hover assertion. It is not reported as an all-green native gate.

Matched diagnostic 308 reproduced the exact missing stamp on untouched published `1abdf3d6` production: DPR 1, light, horizontal LTR, zoom 1; captured `inner-spin-button` raster `empty:true`, with no decoration warning. That base arm failed 1 of 4; the D8 prerequisite arm passed all four. Instrumentation only retained data after observing the missing captured result and did not change the strict assertion. Both test files were restored afterward. The source image after failure shows the control; it does not establish its pre-capture native state.

**DM-WRFW22** owns distinguishing source/fixture rendezvous from isolation state loss. This establishes the failure condition independently of D8, but does not measure any frequency impact from D8 or identify a renderer/host cause. The full failure, matched child exit codes and artifacts remain retained; no arbitrary assertion retry or tolerance was added.

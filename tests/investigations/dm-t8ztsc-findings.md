# DM-T8ZTSC: generated-pseudo isolation preserves transition ownership

`isolatePseudoSurface` previously inserted its visibility stylesheet without protecting active authored transitions. Pausing the compositor animation rate did not prevent CSS style updates from canceling the original transition. An unchanged published `6d4c7b72` select witness loses the original paused visibility transition before native-control materialization; the same failure remains on published `152ddd08` plus the explicit D8/FTR/THP prerequisite stack.

The repair reuses THP's qualified ordinary Element/document-timeline controller independently in each actual Frame. The only shared-controller change is accepting Frame as well as Page. No public barrel, capture/index, external CSS raster, font or geometry behavior is changed. Current published native opaque-raster skip predicates remain intact.

## Source and ownership

Pinned actual Chromium revision `6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050`: `css_animations.cc:2494–2510` skips transition retargeting while an ordinary animation owns the property; `keyframe_effect.cc:250–268` copies priority and the CSS event delegate; `animation.cc:1464–1475` with `animation.h:518–522` clears the copied delegate when a private base Animation replaces a targeted dummy effect. FTR/THP source hashes and primary URLs remain in `dm-ftrbes-evidence.json`. Never mutate or replace the original Animation/effect/native frame model, time or playback state.

Observe every prepared context before the first mutation. Activate capture-owned controllers, bind iframe ancestor roles through actual parent-context Element handles, then install each frame's isolated style. A private handle binds the source Document, target registry token, actual Element identities, ancestor set, owned stylesheet and original marker values. Authored null, empty and literal marker attributes restore exactly. Ancestor roles come from actual handles and bound Element sets; marker text alone is not a source-role fact.

Retain the original visibility declarations; private animations do not replace CSS used-paint authority. Verify the active owners' resulting visibility before accepting pixels. Refuse source frame-set changes, wrong contexts, unavailable native APIs, unknown owners and affected non-visibility transitions. Flat iframe ancestors are qualified; author-shadow ancestry remains an explicit refusal, covered by the existing DM-284W1M qualification investigation.

Restore all frames' source styles and markers before disposing any transition controller. Cleanup failure invalidates an already-read bitmap through the existing unavailable warning. Preserve concurrent foreign marker edits while reporting lost ownership. Node-owned two-second operation bounds apply even when page timers/fetch and author rAF are frozen. Capture scheduler barriers use the existing private compositor lane; no author callback is resumed. A failed final facts installation releases the prepass registry.

## Native discriminators

The strict select witness remains executable in `dm-t8ztsc-select-ownership.probe.ts` and is promoted into ordinary browser regressions. Eighteen focused cases cover target/overlay, both directions and paused/running; exact original animation/effect/frames/timing/events and source attributes/pixels; frozen real-world timers plus parked author rAF; same-origin and opaque-origin iframe contexts; timeout rollback, foreign-marker/stylesheet/API refusal, source-frame removal and unknown author-shadow ancestry; and a visible intrinsic generated image.

Matching baseline and after arms run the same retained fixture script (SHA-256 `371736d08b7f1f57a0e7c26dece07abb61d19bcb42a4d0400fbbecde85fe8507`), Chromium147.0.7727.15, viewport180×160, DPR1. A generated 80×80 orange image overflows its 20×20 pseudo slot; an unrelated overlay has a visibility transition paused at10000ms. Neither arm uses geometry normalization, a capture-time source animation seek, or an authored layout override to reconcile the result. Temporary isolation styles and markers remain real source mutations, with the existing D8/Q4 callback limits.

Both directions previously contaminated the isolated surface: guardRGBA255,255,255,51 and orange center255,183,51,255. The repaired actual Chromium readback has guard0,0,0,0 and center255,165,0,255. All28800 full-readback pixels differ (rawdiffPct100) because the old overlay affected the whole viewport; this is an isolation correction, not a source-vs-SVG score. Source PNG hashes match between arms and restored source rawdiffPct0. Hidden-to-visible also cancels the original animation only on the baseline; the repair preserves it. Visible-to-hidden preserves original identity in both arms, demonstrating why source identity alone cannot prove isolated paint ownership.

Inspect the exact actual buffers before attaching. Source/isolated/restored pairs describe this qualified plane and select source ownership, not complete SVG/site fidelity. The pre-existing select overflow-guard warning and DM-WRFW22's strict hovered-number matrix remain separate; do not waive either assertion or silently present flawed full SVG output as proof. Final gate results, crop rectangles, hashes and attachment IDs belong in the integration handoff.

Linux and Windows append all 18 cases to the existing snapshot-transition
profile, requiring 74 passing assertions with no skips. Its always-retained
`snapshot-visibility/pseudo/` directory contains the original PNGs and source
commit, runtime and normalized fixture-hash metadata. The integrated local
selection is 47 cases (18 pseudo and 29 controller); the wider profile runs on CI.

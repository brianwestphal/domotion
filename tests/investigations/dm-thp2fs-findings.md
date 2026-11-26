# DM-THP2FS: production visibility-transition isolation

The native full-control, partial-decoration and replaced-surface isolation owners share one internal controller. Deferred activation keeps source visibility, occlusion and interaction reads ahead of isolation. The controller never changes an original Animation, KeyframeEffect, native frame model, time, playback state or CSS event delegate.

## Native mechanism

Pinned Blink sources and hashes are recorded in `dm-ftrbes-evidence.json`, Chromium revision `6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050`:

- `css_animations.cc:2494–2510`: an ordinary animation owning visibility prevents CSS transition retargeting.
- `keyframe_effect.cc:250–268`: cloning preserves effect priority and copies the CSS event delegate.
- `animation.cc:1464–1475` and `animation.h:518–522`: assigning the clone to a private base Animation with an existing targeted dummy effect replaces that copied delegate with null.
- `keyframe_effect.cc:415–429` and `animation.cc:1420–1427`: changing or reattaching the original effect would change native CSS ownership flags. The controller never does this.

Each qualified active owner gets a private ordinary guard and a private paint animation. Configure only detached clones and attach them through the private base Animation. Normalize only private clone timing to a one-millisecond filled interval, held at its interior; no source duration or time is changed. Callers retain their actual isolation visibility declarations. A production discriminator showed that private animations alone do not authorize hidden used paint: without the caller's important declaration the unrelated native overlay remained visible; retaining that declaration restores exact transparent isolation. This does not establish that attached-clone editing caused the initial failure.

Capture native constructor, pause/cancel, timing, frame and effect-setter hooks before mutation. Reject unavailable or foreign APIs; never resume author loops. Node-owned deadlines bound controller operations independently of frozen page timers. Observation-only preparation releases late remote handles. Cleanup closes the owner against late activation, restores caller styles first and transition declarations next, commits source style, then cancels every private animation. Source and private animation/effect/frame/timing identities are verified before raster admission. A canceled or changed private paint owner invalidates its stamp even if the pixels were already read. Source ownership changes or cleanup failure invalidate raster admission. Replaced cleanup failures clear any already-installed affected stamps.

Potential non-active visibility channels retain the existing transition-list suppression, including generated before/after rules and exact null/literal attribute restoration. Native setters refuse known active non-visibility property changes instead of canceling those authored transitions. This is a conservative boundary, not general multi-property isolation. D8's original attribute/callback contract and DM-Q4J4JG's callback limitation remain in force.

## Qualified contracts

`tests/snapshot-visibility-controller.e2e.test.ts` exercises sixteen actual native/replaced producer routes: target/overlay, both directions and paused/running. It verifies original animation/effect identity during readback and afterward, unchanged original frames/timing/events, exact paused time or running start time, exact original attributes, no private animation leak, transparent guards, and exact restored source pixels. Untouched native retarget controls establish the next authored CSS operation's direction-dependent behavior; the repaired producer must match it.

The suite also exercises actual full capture after `freezeRealWorldDom`, including native full controls, replaced canvas and partial file-button decoration; source-error, CDP-style readback rejection and timeout rollback; foreign native API refusal; and owner replacement between preparation and activation. A unit contract bounds preparation from the Node clock and verifies late observation-handle release. No backend, profile, source time, tolerance or assertion retry is changed.

The generated-pseudo path is independently unsafe: the styled-select variant cancels the original transition in `pseudo-fragment-cdp.ts:isolatePseudoSurface` before native decoration materialization. The exact unchanged published `6d4c7b72` control reproduces it. **DM-T8ZTSC** owns that repair; the strict witness remains `dm-t8ztsc-select-ownership.probe.ts`, intentionally outside ordinary E2E discovery. The partial-native qualification uses a file button without that independent option-checkmark route. Do not claim the original select path is repaired by this ticket.

**DM-284W1M** holds qualification of pseudo, shadow/cross-document and non-document-timeline owners, pending/unresolved or modified effects, natural completion, concurrent edits, other affected transition properties and foreign runtime capabilities. Those cases are not covered by an arbitrary-animation atomicity guarantee.

DM-284W1M qualifies part of that list in `tests/snapshot-visibility-qualification.e2e.test.ts` against installed Chromium.

Explicit refusals, with the source Animation, effect, frames, timing, time, events and attributes unchanged:

- pseudo-element targets;
- a CSSTransition moved to a non-document timeline;
- author-replaced keyframes carrying another property.

Qualified and restored exactly:

- an author-modified duration/easing;
- the ordinary paused owner.

A running owner that finishes naturally during isolation fails closed with "ownership changed" and leaks no private animation.

**DM-J5V8WD qualifies author-shadow visibility transitions.** Blink enumerates animations in the calling tree scope (`DocumentAnimations::getAnimations(tree_scope)`, `core/animation/document_animations.cc:277–291`, Chromium `7d859f27`). The original native-control guard measured `[255,255,255,51]` for an author-shadow overlay. Capture now reads the native animation list on each actual open or closed ShadowRoot in its document’s isolated CDP world. A live visibility transition in any such scope produces an explicit diagnostic and withholds the isolated raster. The native button and replaced canvas tests preserve transition identity, effects, frames, timing, paused time, events and style attributes. Light DOM and static shadow controls retain the exact transparent guard `[0,0,0,0]`.

The pierced CDP tree identifies same-process child documents. Cross-origin out-of-process iframes use their own target sessions. On both native and replaced routes the qualification checks actual process placement, active closed-shadow refusal, static shadow acceptance and the ordinary child-document control. Topology or visibility ownership changes observed through readback invalidate the raster. Session creation and verification have Node-clock deadlines.

Still unqualified:

- pending effects (not deterministically reachable from a page script; the controller's `animation.pending` refusal is unexercised);
- other cross-document ordinary owners, including transitions targeting the iframe element itself;
- concurrent authored edits during isolation;
- non-visibility transition channels.

**DM-WRFW22** retains the unchanged strict hovered-number raster assertion and its independently reproduced missing-stamp investigation.

## Evidence and validation

The gate writes representative native and replaced source/isolated/restored PNGs and exact source-restoration raw difference metrics into the explicitly selected local evidence directory. Inspect those exact bytes before attaching. The earlier gate 314 stopped at lint because a pixel decoder named `raw` triggered a kerf escaping rule; the helper was renamed without changing that rule or any pixel assertion. Final gate result and attachment IDs belong in the integration handoff.

The Linux and Windows fidelity workflows run the native production-controller,
source-restoration, replaced-transition, effect-ownership, generated-pseudo,
decoration and scope-qualification suites. Their strict results floor is 111
passed cases, including 17 scope qualifications. They retain
`snapshot-visibility/` after failures, including the production PNGs and
source-commit, runtime and normalized fixture-hash metadata. The ordinary
macOS browser lane runs the complete selection.

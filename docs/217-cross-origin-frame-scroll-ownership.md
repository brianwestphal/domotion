# Cross-origin frame scroll ownership

DM-2537 closes the logical gap between iframe recursion and multi-segment
scroll capture. The earlier cross-origin flag reached the synchronous DOM walk,
but the live scrollbar prepass was deliberately main-document-only and the
scroll composer knew only an unqualified `(scrollX, scrollY)`. Repeated frame
URLs, nested frames, or a stale allowlist could therefore not be proven to
belong to the captured scrollbar/offset record.

This change does not fit screenshots, add a tolerance, or reconstruct Blink
scroll geometry. It carries Chromium-owned identity and live offsets through
the existing source-owned capture route.

## Pinned source ownership

The source checkout is Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3`.

- `third_party/blink/renderer/core/inspector/main_thread_debugger.cc:128-145`
  places `IdentifiersFactory::FrameId(frame)` in every default execution
  context's inspector `auxData.frameId`.
- `third_party/blink/renderer/core/inspector/identifiers_factory.cc:84-92`
  derives that ID from the frame's DevTools token.
- `third_party/blink/renderer/core/inspector/inspector_page_agent.cc:1468-1501`
  serializes the same ID and its exact parent ID in `Page.Frame`.
- `third_party/blink/renderer/core/inspector/inspector_dom_snapshot_agent.cc:380-401`
  serializes that same frame identity on each document snapshot.
- `third_party/blink/public/devtools_protocol/domains/Target.pdl:20-35`
  publishes the exact parent `FrameId` for a site-isolated `iframe` target.
- `third_party/blink/renderer/core/paint/paint_layer_scrollable_area.cc:619-649`
  owns the live `ScrollOffset`, the physical-pixel snapped offset, and the
  writing-direction-sensitive minimum/maximum range.
- `paint_layer_scrollable_area.cc:857-870` and `2783-2847` distinguish the
  layout viewport from visual-viewport scrollbar supply; scrollbar existence,
  phase and paint remain the live marker/native-raster pass documented in
  [165](165-native-scrollbar-layout-paint-ownership-audit.md) and
  [169](169-authoritative-scrollbar-capture.md).

HarfBuzz `4de187dd0a915d13c976fa8bd474c084229f3aab` and Skia
`ebf50520d720a1ce9d842d942d04c6c39c3fbc7b` do not choose frame identity,
allowlist access, or scroll ownership here. Text shaping and native raster
contents retain those pinned owners after the frame boundary is selected.

## Capture-local authority

`src/capture/frame-scroll-state.ts` creates one random private registry key for
each capture. It writes a random token into every Playwright frame's default
world, enables CDP Runtime/Page, and reads the token back from the default
execution context carrying Chromium's `frameId`. The handshake is exact even
when two siblings have the same URL/name or several nested `srcdoc` documents
are indistinguishable by content.

The top target's `Page.getFrameTree` supplies local-frame edges. A
site-isolated cross-site child is an out-of-process iframe (OOPIF) target and
is not part of that local tree, so capture attaches Runtime to that exact frame
target and joins its token-authenticated `FrameId` to
`TargetInfo.parentFrameId`. It does not infer the edge from URL, load order or
geometry.

After that handshake, Node binds the authenticated child record directly to
the exact iframe owner `Element` in its immediate parent world. The walker does
not try to read an authority through `contentWindow`, which would itself cross
the Same-Origin Policy for the inaccessible case that needs a precise raster
diagnostic. Both frame-global and owner-element properties are non-enumerable,
capture-local, and removed on every exit.

For a frame classified as readable, recursion also requires the live child
global to retain the same private token. Owner elements and Chromium FrameIds
can survive a document navigation, so the owner binding alone must not reuse an
earlier origin/allowlist decision. Scroll-owner sampling repeats that token,
origin and parent-readability check and makes a changed frame fail closed.

For every frame the capture records:

- Chromium `frameId` and exact `parentFrameId`;
- current origin and one access decision: top, same-origin,
  cross-origin-allowlisted, cross-origin-denied, inaccessible, or
  identity-unavailable;
- whether the parent could actually read `contentDocument` at this capture;
- whether every ancestor from the top frame was authenticated and readable;
- every live viewport/element scroll owner, identified by
  `${frameId}:${frame-local DOM index}`;
- raw `scrollLeft`/`scrollTop` (including negative RTL values), scroll/client
  extents, direction and writing mode.

The normalized allowlist, frame graph and owner records receive separate
SHA-256 digests. The complete state receives an integrity digest. Each scroll
segment additionally seals the selected owner plus its exact x/y offset against
that state. The segment's composition anchor is taken from that owner's sampled
raw offsets, not from a second independently timed page query. These digests
are mutation detectors and provenance bindings, not a
replacement security boundary; the browser launch remains the explicit trusted
opt-in described in [81](81-iframe-recursion.md).

The private registry is removed in `finally` on success and every failure path.
A later capture always receives a new key and capture ID. An allowlisted first
capture therefore cannot authorize an omitted-allowlist second capture.

## Authenticated recursion and fail-closed boundaries

The capture script now accepts the private registry key alongside `cof`.
Before recursing an iframe it requires that the child record:

1. uses the pinned `chromium-cdp-frame-scroll-v1` protocol;
2. belongs to the current capture ID;
3. carries the current capture's allowlist digest;
4. names the current document's exact Chromium frame as its parent; and
5. is same-origin or cross-origin-allowlisted.

The existing current-origin allowlist check remains as a second gate. A missing,
wrong-parent, denied, or inaccessible authority stays a Chromium raster. Its
record contains no child scroll owners and both the capture result and iframe
walker emit a machine-readable, frame-specific diagnostic. There is no fallback
to URL, child order, DOM ID, guessed origin, or old capture state.

Origin decisions are relative to each immediate parent, matching the actual
owner/child access boundary. A same-origin grandchild of an allowlisted foreign
frame stays same-origin; a grandchild that returns to the top origin is still
cross-origin to its foreign parent and must pass the allowlist again. A denied,
inaccessible, or unauthenticated ancestor makes its complete descendant branch
unreachable: descendants retain their exact frame/parent records but expose no
scroll owners and carry an ancestor-boundary diagnostic.

Each captured iframe owner carries `frameScrollIdentity`, including denied
raster owners. This keeps fixed descendants and TreeScope-local mask/clip
resources under the same exact browsing-context identity while the established
iframe recursion and fragment-scope logic continue to own their placement.

## Frame-local scrollbar capture

`prepareCapturedScrollbarSets` now visits every authenticated readable frame,
not only the top document. Each candidate keeps its Playwright frame handle,
Chromium `frameId`, live-node owner ID and frame-to-top viewport mapping.
Reserved marker CSS is installed/restored in the candidate's own document;
screenshots remain one atomic top-page Chromium surface. Native overlay
underlay/restoration also mutates and restores all participating frame-local
owners together.

The resulting `CapturedScrollbarSet.owner` must match one scroll owner in the
same segment's frame state. RTL and vertical-writing offsets remain raw DOM
values; no absolute-value normalization or synthetic range calculation is
allowed. A non-axis-aligned frame/scroll owner retains the existing unavailable
source state instead of receiving a guessed transform.

## Composition invariants

`assertScrollFrameOwnership` runs before SVG scroll composition whenever an
input carries frame authority. It rejects:

- a missing state, selected owner, or owner binding;
- duplicate/reused capture IDs across segments;
- a changed or omitted allowlist;
- a changed Chromium frame tree;
- duplicate, cross-frame or non-finite owner records;
- a selected owner's raw offset differing from the segment anchor;
- a frame-local scrollbar whose owner ID, frame ID, or raw current position
  differs from the element's authenticated browsing-context ancestry;
- stale/wrong-frame iframe tree identities;
- vector recursion for denied/inaccessible frames; and
- raster substitution for authenticated readable frames.

Synthetic legacy unit inputs with no frame-related fields remain supported.
Production `executeScrollPattern` always supplies all four fields.

## Evidence

`src/scroll/frame-scroll-ownership.test.ts` contains destructive mutations for
sibling-frame segment-owner substitution, wrong-frame scrollbar assignment,
omitted allowlist, reused capture state and unsealed offset changes.

`tests/cross-origin-iframe-recursion.e2e.test.ts` uses three localhost origins
and covers:

- nested same-origin and cross-origin frames;
- parent-relative origin decisions and denied-ancestor descendant isolation;
- allowlisted recursion and two denied raster boundaries;
- exact CDP parent/frame IDs and unique per-frame owners;
- negative RTL and vertical-rl scroll offsets;
- frame-local captured scrollbar owner IDs;
- fixed descendants;
- duplicate outer/iframe mask and clip resources with distinct TreeScopes;
- per-segment composition validation;
- wildcard-to-omitted-allowlist isolation, including both frame-global and
  owner-element registry cleanup;
- same-frame document navigation after the authority handshake becoming an
  identity-unavailable raster record with zero owners; and
- a forced-site-isolated, web-security-on OOPIF with exact target/parent
  identity, inaccessible-frame diagnostics, and zero child owners.

`.github/workflows/cross-origin-frame-scroll-ownership.yml` runs those exact
logical tests and type/generated-bundle checks on macOS, Linux and Windows.
There is no pixel comparison, percentage threshold, adjustable epsilon or
tolerance change in this closure.

---
id: "requirements/native-css-shadow-isolation"
title: "Native CSS resource paint and document shadow isolation"
kind: "investigation"
status: "current"
owners: ["images-media", "paint-effects"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-302BYE", "DM-M6VWFD", "DM-CKS6JY", "DM-JDJ0DP", "DM-ST8D8V"]
code:
  [
    "src/capture/external-css-svg.ts",
    "src/capture/external-css-svg-raster.ts",
    "src/capture/external-css-svg-shadow-guard.ts",
    "tests/external-css-svg.e2e.test.ts",
    "tests/external-css-svg-shadow.e2e.test.ts",
  ]
aliases: ["docs/278-native-css-shadow-isolation.md", "doc-278"]
---

# Native CSS resource paint and document shadow isolation

DM-302BYE preserves an already painted CSS clip/mask owner when CSP prevents an
auxiliary resource read. It captures the original owner's coupled paint; it
neither imports denied bytes nor asks an inspector loader to fetch another body.
The renderer reserves that surface atomically so descendants and generated
paint are not emitted twice. Readable resource handling keeps its own contract.

## Measured unsafe intermediate boundary

DM-M6VWFD measured22 native Chromium147 controls on macOS. Eight open/closed
slotted-foreign and flat-owner/foreign-host cases admitted unrelated blue16×16
paint into the selected owner's PNG:256 differing pixels, maximum difference255.
The reported raster crop expanded from16×32 to64×32. All22 original source
before/after images remained pixel-identical, with no extra HTTP request.

The selected flat owner can have no shadow ancestors while a separate closed
host supplies foreign paint. A selected-root ancestry fact therefore cannot
authenticate document-wide native isolation. Some simple slotted controls
matched exactly; those positives did not establish general ownership. Four
slotted-opacity controls differed at512 pixels/max1; that observation remains
unattributed under DM-N933MV and is not a universal raster floor.

The baseline used shipping `dcf45cee` plus302 source commits `5a3f1af1` and
`01784710`. Its rebuilt capture payload was intentionally uncommitted. The
investigation's raw native measurements are not a clean production gate.
Original source/probe and inspected problem images are retained on DM-M6VWFD;
the committed machine-readable summary records this provenance distinction.

## Retained guard

DM-CKS6JY binds public CDP evidence to the actual remote owner, original unique
default execution context, owner/document backend IDs and private journal token.
The full pierced tree must contain that owner exactly once. CKS also required no
author roots anywhere; that blanket refusal now applies only to roots inside
embedded documents, and main-document roots are isolated per scope (next
section). Browser-owned UA roots do not grant author paint another CSS scope.
Unknown, changed or unavailable authority refuses the native fallback.

Topology/context subscriptions invalidate the lease during readback, including
a late root removed before the final query. Owner, document and coverage are
verified again after the screenshot and before adopting its bytes. Setup and
verification use Node-owned five-second phases with one-second query/cleanup
bounds. Isolation restoration and owned-session cleanup preserve the primary
failure; a late-created session is detached. No CSP, backend or author clock is
changed by this guard.

Pinned `InspectorDOMAgent` source7d859f27 supplies pierced-tree and bound-host
shadow event semantics; installed browser147 revision6b5a1b80 supplies the native
controls. These are separately stated authorities, not an assertion that the
two Chromium revisions are identical. The regression files retain ordinary
CSP clip/mask positives and19 static/late-topology/identity/cleanup controls.
The six-file frozen-resource profile requires all 176 selected native assertions
on Linux and Windows, including 57 author-shadow controls.

## Per-scope author-shadow isolation

DM-JDJ0DP replaces the blanket author-root refusal above with an authority that
isolates inside every author scope. The guard is opened before isolation. From
the pierced tree (`BuildObjectForNode` pushes every `GetShadowRoot()`,
`inspector_dom_agent.cc:2375-2381`, pin 7d859f27) it resolves each main-document
author root, open or closed, by backend node into the journal's own default
context (`resolveNode`, :1886-1917) and registers those actual `ShadowRoot`
objects in the private journal. The isolation then:

- walks the flat tree: a host's light child's parent is the slot it is assigned
  to, read from each registered root's own slots because `assignedSlot` hides
  closed slots; the chain must reach the document element;
- scans every scope for foreign paint, transition channels and active
  `CSSTransition`s (each scope's `getAnimations()` reports only its own tree);
- adopts one owned constructed copy of the same hide/show rules into each
  author root, appended last, since a document sheet never matches inside a
  shadow tree. One global attribute index serves every scope.

`arm()` re-verifies the owner, the document and that the pierced author-root set
equals the registered set before the screenshot; topology events then invalidate
as before, and the after-screenshot check also requires every owned sheet to be
still adopted and every page-visible open root to be registered. Restore removes
each owned sheet by identity, reports a changed author list or mutated owned
rules, and always drops the registered roots.

DM-ST8D8V also collects resource owners inside each main-document author root.
The actual element remains the raster owner. The capture walk follows host and
slot children leading to it and retains sibling paint in order. A document-local
readable definition still serves a light-tree host. An inner owner uses its
existing native resource paint without cloning a definition across tree scopes.
When the owner itself hosts a shadow tree, isolation marks its composed
descendants and fingerprints their styles and child order. Local SVG references
resolve from the consumer's own tree scope. Each registered root observes
slot reassignment during readback, including a change reverted before adoption.

DM-96KECE captures direct shadow text and assigned slot text from the original
`Text` nodes. The capture walk and the CDP fragment prepass use the same
projected parent, so a slot supplies its text style and the original node
supplies the native Range, UTF-16 intervals and quads. Before adopting the
owner's PNG, capture checks that the text, physical parent, Range endpoints
and fragment rectangles still match. A character-data observer also detects
changes reverted during the screenshot.

Direct text beside a clip and assigned text beside a clip can be isolated in
open and closed roots. An assigned text sibling of a mask is supported when
the document's font-face set is empty. Direct text beside a mask still refuses.
In the native source fixture, making text transparent at the common host
removed all 512 mask pixels along with the glyphs. For assigned text,
suppressing the slot kept all 512 mask pixels. Each source page recovered its
original pixels after the probe. A separate mask control with a document font
face produced the correct owner PNG, then lost all 512 source mask pixels when
isolation ended. Declaring an unused face also reproduced the loss. Capture
refuses before installing isolation rules in that case. DM-1NGDVV tracks the
related native mask restoration defect.

The guard refuses author roots in embedded documents, owners outside the flat
tree, direct ancestor text over a native mask, and cascades that
leave foreign or ancestor paint visible. An inner-scope `!important` wins over
the outer hide because important declarations reverse tree order
(`cascade_priority.h:29-38`); it refuses through the computed-visibility check.

Native controls (`tests/external-css-svg-shadow.e2e.test.ts`): open and closed
roots × slotted, slotted under a painted wrapper, separate host and empty root ×
clip and mask produce a PNG byte-identical to the flat document's, with the
source pixels, markup and the root's author adopted sheets restored exactly.
Production capture reproduces the flat raster for closed slotted and separate
host roots. Removing only the adoption makes every positive refuse, so the
mechanism is in the loop. A CSP-blocked mask whose slotting root adopts an author
sheet within the same task as slotting stops painting in the source page itself;
the mask positives therefore keep the author-sheet witness on non-slotting roots.

Fourteen owner-side controls cover both external properties, both modes, and
owners inside or hosting a root. They compare the placed RGBA surface to the
equivalent flat owner, compare the full SVG to Chromium and check source
restoration. The additional controls distinguish a shadow-local gradient from a
document ID collision, retain the existing readable document route, and verify
the idle-root and transient-slot boundaries. Eight text cases vary the
projection, tree mode and external property. They check source order, Range
geometry, the independent PNG and original text after capture or refusal.
A separate case changes and restores a character during readback. Two mask
cases verify source preservation when the document declares a used or unused
font face. The clip cases compare the default embedded-font SVG with Chromium.
The system-face mask cases compare the full system-font SVG with Chromium and
the default embedded-font SVG with the corresponding flat capture. The open
root also requires the complete default embedded-font SVG to match the native
source. It uses four distinct green glyphs, `KILT`, in 20px Courier New beside a
red 16 × 32 mask. A second comparison combines Chromium’s text-only body with
the independent mask-only raster and checks the entire result against the
original screenshot. The restored source must match that screenshot as well.
The closed root uses 18px Arial to retain fractional glyph advances. DM-0S5YWW
tracks the installed and embedded Liberation Mono ink difference for `Hint` in
ordinary Linux text.

## Remaining capability boundaries

- DM-N933MV owns unsupported ancestor/compositing, transition, scrollbar and
  direct-text boundaries. Refusal does not establish their rendering parity.
- DM-F19PYG owns local SVG dependencies outside the selected owner's subtree.
- DM-HSABGR investigates readable auxiliary-body identity; a differing response
  at the same URL is not, by itself, a measured full-output defect.

Native macOS measurements do not claim Linux or Windows execution. Those target
platform results and green covering shipping CI remain completion requirements.

---
id: "requirements/native-css-shadow-isolation"
title: "Native CSS resource paint and document shadow isolation"
kind: "investigation"
status: "current"
owners: ["images-media", "paint-effects"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-302BYE", "DM-M6VWFD", "DM-CKS6JY"]
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
The full pierced tree must contain that owner exactly once and no author roots,
including empty/open/closed roots elsewhere in the document or embedded
documents. Browser-owned UA roots do not grant author paint another CSS scope.
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
The complete native frozen-resource CI profile requires96 passing assertions.

## Remaining capability boundaries

- DM-JDJ0DP owns authenticated isolation in legitimate author-shadow documents.
- DM-N933MV owns unsupported ancestor/compositing, transition, scrollbar and
  direct-text boundaries. Refusal does not establish their rendering parity.
- DM-F19PYG owns local SVG dependencies outside the selected owner's subtree.
- DM-HSABGR investigates readable auxiliary-body identity; a differing response
  at the same URL is not, by itself, a measured full-output defect.

Native macOS measurements do not claim Linux or Windows execution. Those target
platform results and green covering shipping CI remain completion requirements.

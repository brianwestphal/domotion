# 184 — Replaced and native ownership transition matrix

DM-2364 expands the decision-stage gate before any additional synthesis is
allowed. This document is the compact contract for the producer, adjudicator,
and all-platform workflow; [doc 133](133-replaced-geometry-oracle.md) contains
the detailed source rationale.

## Captured representation

- `<img>`: unzoomed intrinsic dimensions plus the exact cumulative effective
  zoom used by Blink's natural-size query; object-fit consumes the product.
- Canvas/video: one source-frame PNG, Blink content quad, device dimensions,
  and one bitmap-to-output map. A second capture must produce a different SHA
  after an actual frame/poster mutation.
- Image decode fallback: loader state, fallback disposition, UA-shadow
  container/icon/text facts, and exact versus terminal capture status.
- Native controls: EffectiveAppearance, whole-host versus decoration
  reservation, materialized/empty status, pseudo-fragment ownership, and
  platform-sensitive source-frame SHA.
- Generated boxes: ordered source pseudo box fragments and physical quads,
  never the legacy aggregate host-anchor approximation.

## Ownership transitions

| Pair | Source state | Control state | Required result |
| --- | --- | --- | --- |
| Image sizing | zoom 1 | zoom 1.25 | natural object size changes by effective zoom; ≤1 device px |
| Decode | loaded | loading/failed | vector image crosses to Blink's visible fallback owner |
| Dynamic surface | frame A | frame B | same replaced-snapshot owner, different source SHA |
| Checkbox/radio | auto | none/base | whole Chromium host crosses to structural/generated pseudo |
| Button/progress/meter | auto | author paint | whole Chromium host crosses to structural vector |
| Select | auto | author host | whole host crosses to narrow menulist decoration |
| Native state | accent/scheme A | accent/scheme B | owner stays native; source pixels discriminate state |
| Generated box | positioned | flow/axis/affine | authoritative physical fragments track source ink |

## Glassbox decisions

The production change is limited to one source fact that the old object-fit
renderer lacked: `imageEffectiveZoom`. It is not calibrated from the fixture;
the value is captured from the same effective-zoom walk used elsewhere in the
capture script and its activation is directly predicted by Blink source.

The oracle intentionally reports a loading image as Blink fallback-owned.
Fresh Chromium evidence showed `complete:false`, `naturalWidth:0`, and a live
hybrid icon/vector-text fallback before network completion. Treating loading as
unpainted would encode an intuitive but false state transition.

Fractional affine generated boxes are compared against anti-aliased source
coverage. The scanner selects the largest connected component nearest the
target color, preventing a disconnected AA edge from another fixture color
from widening bounds. This changes evidence extraction only; the hard
one-device-pixel criterion is unchanged.

Unsupported or missing ownership facts never reactivate generic/native
synthesis. The adjudicator requires explicit exact records and source warnings
make the release row red.

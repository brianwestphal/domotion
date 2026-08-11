# 115 — Parameterized transition design

**Status: investigation complete (DM-2042); foundation and built-in parameters
shipped in DM-2070/DM-2071; custom recipes remain DM-2072.**

## Finding

Transitions are already objects, but motion remains selected by a closed string
enum. Geometry is encoded partly in names (`push-left`, `zoom-in`) and partly in
ad-hoc optional fields (`wipeAngle`, `wipeStartAngle`,
`wipeCounterclockwise`). The animator then reclassifies those names in several
places: reveal/slide sets, entrance and exit classifiers, legacy family emitters,
and the mixed-family compositor. The declarative animate and storyboard schemas
also maintain different copies of the transition vocabulary.

Adding one optional field at a time scales poorly: invalid combinations validate
and are silently ignored, every new family variant widens several enums and
dispatch tables, and the public schema cannot explain which parameters apply to
which type. Replacing the enum directly would unnecessarily break existing
configs and byte-stable output.

## Recommendation

Adopt a three-layer model:

1. A shared schema accepts all legacy names and new discriminated parameter
   families. It is the single source for animate, storyboard, programmatic types,
   and generated JSON Schema.
2. A compatibility normalizer lowers both forms into one internal transition
   plan: incoming/outgoing opacity, translate, scale, clip, and supported overlay
   primitives with explicit timing, easing, origin, and z-order.
3. The animator emits from that plan. Existing names normalize to plans that
   reproduce current bytes; parameter families and a later custom recipe reuse
   the same emitter.

The parameter surface should use bounded, typed primitives rather than raw CSS:

- push: direction/angle and distance;
- reveal: shape, angle, origin, radius, and sweep direction;
- zoom: starting scale and viewport-relative origin;
- shine: angle, band width, color, and opacity;
- custom recipe: a composition of the safe opacity/translate/scale/clip channels
  plus a supported overlay.

Raw CSS, animated filters/masks, JavaScript, and SMIL remain excluded. Every plan
must use one CSS timeline, rest at identity, define reduced-motion behavior, and
specify the outgoing/incoming ownership of each primitive.

## Delivery order

- **DM-2070 — foundation:** shared schema and legacy-name normalization only.
  No new motion knobs; exhaustive byte-identity tests bound the refactor.
- **DM-2071 — built-in parameters:** typed parameters for push/reveal/zoom/shine,
  retaining legacy names as default aliases.
- **DM-2072 — open recipe:** declarative composition of the same viewer-safe
  primitives, after the normalized plan has proven stable.

This order separates compatibility risk from new behavior and avoids building a
second emitter for the eventual escape hatch.

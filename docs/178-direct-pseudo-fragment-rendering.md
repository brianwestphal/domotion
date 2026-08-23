# 178 — Direct source-owned generated-pseudo rendering

**Ticket:** DM-2468
**Status:** direct record rendering, compatibility-bridge retirement, and the
native macOS/Linux/Windows DPR gate are shipped
**Source pins:** Chromium `7d859f271cbda744098ac69f44978d4edfa62be3`,
HarfBuzz `4de187dd0a915d13c976fa8bd474c084229f3aab`, and Chromium-pinned
Skia `62efacd37737505732dbe3d8daa62abd679626a1`

## Outcome

`src/render/pseudo-fragments.ts` consumes `CapturedPseudoFragmentSet`
directly. New live captures no longer project a source-owned record back into
`textSegments`, `pseudoImages`, or `pseudoBoxes`, so the old host-first/last
text anchor, flex-center, 0.8-line-height wrap threshold, and synthetic
half-leading branches cannot regain authority. Old serialized trees that only
contain the legacy fields remain readable through their existing renderer
paths; the deleted `pseudo-fragment-compat` projection is not needed for them.

The renderer validates the record before paint. Invalid or collapsed box
quads/baselines fail closed to a diagnostic boundary; a captured
`terminal-raster` record emits its single isolated Chromium surface. Hidden,
collapsed, and zero-opacity records emit no pseudo paint. Exact records retain
the captured pseudo/content-item identity, fragment order, physical plane,
baseline, selected-face typography, logical edge ownership, and paint slot.

## Direct paint ownership

The implementation keeps Blink's decisions separated by owner:

- Each generated text fragment follows the ordinary resolved-face,
  HarfBuzz/fontkit, and path route at its captured physical baseline and
  inline origin. Bidi fragments are projected from the retained visual order;
  horizontal, vertical, and sideways records use the captured writing plane.
- Each anonymous `url()` child stays a separate content item and is emitted
  through the ordinary image embedding cache at its captured replaced-child
  quad. Text/image/text sequences are never concatenated or independently
  anchored.
- Each box fragment maps its retained local border rectangle onto the full
  physical quad. Background, border, padding, radius, and
  `box-decoration-break` slice/clone edge ownership are painted per fragment,
  including multicolumn translations.
- `::before`, `::after`, positioned, negative, and positive records enter
  explicit host paint slots. A negative positioned pseudo whose host does not
  establish a stacking context remains owned by the ancestor context and
  paints below the host box; a host-local stacking context retains Appendix E
  ordering.
- An already-emitted host CTM is inverted around source-owned physical pseudo
  paint, so transforms are applied exactly once rather than baking host
  geometry into every fragment.

For checkboxes and radios, DM-2459 assigns `::checkmark` to the before slot
ahead of `::before`, matching Blink's attachment order. Resolved
`appearance:none`/`base` plus an authoritative pseudo record array (including
an empty array) suppresses the generic checkbox/radio indicator. Native
`appearance:auto` remains a negative control, and only pre-contract trees with
an undefined record field can use the legacy heuristic. Uniform solid rounded
pseudo borders preserve their circular contour rather than becoming four
square-corner side strokes.

The main renderer continues to allocate image/background paint servers and
the existing affine wrappers. The pseudo renderer supplies their authoritative
fragment geometry; it never reads host `textSegments`, host edges, or host
font ascent to reconstruct placement.

DM-2488/doc 193 extends that same record-local order for `backdrop-filter`.
One Chromium prior-device raster paints first inside the already selected
pseudo slot, followed by a separately marked direct box/text/image vector
group. The raster never migrates to the host and does not terminate otherwise
exact pseudo descendants.

## Independent paint gate

`tools/pseudo-fragment-render-oracle.ts` captures one adversarial live Chromium
page, renders the resulting tree to SVG, rasterizes that SVG in a second
Chromium page, and compares the colored pseudo-paint edge sets in device space.
The acceptance disk is exactly four device pixels at both DPR 1 and DPR 2; it
is deliberately not multiplied by DPR. Exact record count, terminal record
count/reasons, emitted source-marker count, structural validation errors, both
directed unmatched-edge counts, and maximum edge distance are recorded.

The corpus covers before/after and child-first/child-last hosts; one, two, and
three wrapped lines; all Blink `vertical-align` families; mixed fallback fonts
and sizes; LTR/RTL bidi; vertical and sideways writing; text/URL/text;
asymmetric slice/clone edges; multicolumn; inline-block/flex/grid; absolute and
fixed placement; negative stacking, affine transform, zoom, and DPR 1/2.
`content:none`, `display:none`, `visibility:hidden`, and `opacity:0` are
negative pseudo-paint controls, while ordinary text, first-letter, line-clamp,
and list-marker routes remain outside the generated-pseudo owner.

The DM-2459 extension adds none/base checkbox and radio indicators across
checked, unchecked, indeterminate, disabled, generated text/box/gradient,
affine transform, switch, fractional-origin, zoom, and DPR rows. The focused
browser test independently asserts `::before`/`::after`/`::checkmark`
identities, authoritative empty ownership, synthesis suppression, and the
native-auto raster negative.

The focused unit mutations prove that changing host text coordinates cannot
move source-owned output and that a collapsed baseline or quad cannot silently
reactivate a legacy anchor. `tests/pseudo-fragment-render-oracle.e2e.test.ts`
provides the focused browser leg. Run the full local gate with:

```bash
npm run pseudo:fragment-render-oracle -- \
  --json tests/output/pseudo-fragment-render/report.json \
  --artifact-dir tests/output/pseudo-fragment-render/artifacts
```

`.github/workflows/pseudo-fragment-render-parity.yml` runs the unit, capture,
and DPR-1/2 paint legs natively on macOS, Linux, and Windows for pull requests
and `main`. Every runner always uploads its report, source PNGs, rendered PNGs,
and generated SVGs. Platforms do not share a font or screenshot baseline.

## Evidence boundary

Docs [157](157-pseudo-generated-fragment-geometry-audit.md),
[175](175-pseudo-fragment-protocol-oracle.md), and
[176](176-source-owned-pseudo-fragment-capture.md) remain the authority for
the source decision, structural decoder, and production capture. This document
owns direct paint consumption and the independent final-device-space gate.
Ordinary legacy serialized pseudo fields are compatibility input only; new
capture is source-record-only. A future Chromium protocol or pseudo-layout
change must fail either structural validation or the native pixel gate before
any new compatibility behavior is admitted.

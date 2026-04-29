# Domotion: `appearance: none` checkbox / radio / switch

Requirements for honoring author CSS on `appearance: none` checkboxes, radios, and switch-shaped toggles. Origin: DM-285 (follow-up from DM-247). Doc 26 covers `<input>` shadow-DOM pseudos generally; this doc focuses on the host-element side of the custom-control story.

## Why now

`06-forms-style-checkbox-radio.html` exercises three custom patterns:

```css
.cbx { -webkit-appearance: none; appearance: none; ...; border: 2px solid #94a3b8; border-radius: 5px; }
.cbx:checked { border-color: #4f46e5; background: #eef2ff; }

.rdo { -webkit-appearance: none; appearance: none; ...; border-radius: 50%; }
.rdo:checked { border-color: #059669; }

.sw  { -webkit-appearance: none; appearance: none; width: 44px; height: 24px; border-radius: 999px; background: #cbd5e1; }
.sw:checked { background: #16a34a; }
```

Before this work, `renderCheckbox` and `renderRadio` always overlaid the UA-default 13×13 blue-tinted square / circle, ignoring the host's author-styled border + background. Toggle switches got the checkbox treatment, producing a checkmark icon in a 44×24 box rather than a pill with a thumb.

## Capture

`CapturedElement.styles.inputAppearance` carries the input's resolved `appearance` / `-webkit-appearance` longhand. `'none'` is the only value the renderer reacts to — anything else (`'auto'`, `'checkbox'`, etc.) routes through the existing UA-default chrome path.

## Render

`renderCheckbox` and `renderRadio` early-out when `inputAppearance === 'none'`:

- **Switch shape detection** (in `renderCheckbox`): aspect ratio `width / height > 1.5` AND `border-radius >= height / 2 - 1` → render a thumb circle, not a checkmark. Thumb is 2 px inset from the host edges, anchored left when unchecked / right when checked. Thumb fill is white (matches the common `::before { background: white }` pattern).
- **Custom checkbox** (square-ish, no pill radius): only the checkmark indicator is overlaid. Stroke color = host's captured `border-top-color` (which on the `:checked` rule typically swaps to the accent color). The two-segment tick path is the same geometry as the UA path; only the stroke color differs.
- **Custom radio**: small filled circle at 0.25× host size, fill = `border-top-color`.

The host's background and border come from the normal element-rendering path (which already paints them at the captured colors / radius), so the renderer only adds the indicator overlay on top — no double-paint.

## Edge cases / out of scope

- The fixture's `:indeterminate` styling on `.cbx` (purple bg + horizontal white dash) is not specifically handled in the appearance-none path; it would inherit the standard `:checked` indicator rather than the dash. No fixture exercises this combination yet.
- Author CSS that places the indicator via `::before { transform: scale(...); clip-path: polygon(...) }` (the canonical 'animate the checkmark in' pattern) is approximated with a fixed two-segment tick. Animations of `::before` are out of scope.
- The thumb fill is hard-coded to white because the `::before { background: ... }` capture would require the broader pseudo-element capture story (tracked separately). For the current fixture this matches Chrome's painted output.
- Heuristic-based switch detection can misfire on a wide-but-square-cornered checkbox. The cutoff (`aspect > 1.5` AND `border-radius >= height / 2 - 1`) requires both pill-radius AND landscape aspect, so a bare wide checkbox still falls into the checkmark branch.

## Tests

The `06-forms-style-checkbox-radio` html-test fixture is the regression guard. Diff dropped from 0.71% → 0.57% with the visible improvements: indigo checkmarks (was UA blue), green dots (was UA blue), real pill-shaped switches with thumb position based on `:checked` (was overlaid checkmark on a stretched rectangle).

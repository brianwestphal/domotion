# 93 — Realistic simulated typing

Status: **v1 shipped** (DM-1518). Character-by-character reveal with the caret
glued to the true text edge, plus a paste-vs-type mode and humanized jitter.
Deeper behaviors (mistake/correct, per-keystroke real-site re-sampling,
proportional/glyph-path rendering) are designed here and tracked as follow-ups.

The surface is the **`typing` overlay** (`docs/43-declarative-animate-config.md`
§5, `docs/13-cursor-overlay.md`, `src/animation/overlay-schema.ts`), rendered by
`renderTypingOverlay` in `src/animation/animator.ts`. It layers a typed-text
reveal onto a captured frame — the mechanism the CLI/templates use to simulate a
user typing into a field (see the `typing-search` and `form-fill` gallery
examples).

## The bug this fixes

The reveal painted the text as a monospace `<text>` element and unveiled it with
a width-growing clip, while a separate caret bar swept the same span. Both the
clip and the caret positioned characters at an **estimated** cell advance of
`fontSize × 0.6` (`MONO_CHAR_WIDTH_RATIO`). But the font that actually paints —
`'SF Mono', Menlo, Monaco, monospace` — is **not** 0.6em per cell: SF Mono's
advance at 28px is `17.31px` (≈`0.618em`), measured both from Chromium's painted
`Range.getBoundingClientRect()` and from fontkit's `glyphForCodePoint().advanceWidth`.

That ~`0.51px`/char gap accumulates: after 25 characters the caret parked at
`25 × 16.8 = 420px` while the real text edge was at `25 × 17.31 = 432.7px` — the
caret sat **~12.7px (nearly a full glyph) behind the trailing edge**, and worse
on longer lines. That trailing-caret drift is what read as unprofessional.

## v1 model (shipped)

### Measured advances → exact caret

`measureTypingLines()` resolves the overlay's monospace font via the renderer's
own `resolveFontKey` + `getFontInstance` (`src/render/font-resolution.ts`) and
builds a **cumulative per-glyph advance array** `cum[line][k]` = the caret x
after `k` glyphs of that line, from fontkit's real advances. Both the reveal
clip and the caret ride this one array, so the caret sits at the exact glyph
edge. On the platform that painted the capture, fontkit's advance equals
Chromium's painted advance (verified: `17.309` vs `17.31`), so the parked caret
lands within `0.02px` of the true text width (was `12.7px` behind).

When the font can't be resolved (a platform without the monospace face),
`measureTypingLines` falls back to the old uniform `0.6em` estimate — no crash,
same behavior as before, and still self-consistent.

### One shared reveal plan (`buildTypingPlan`)

Typing is compiled once into a `TypedGlyph[]` — one entry per typed character
carrying `{ line, edge (caret x after it), appearMs }`. The line clips
(`buildTypingLines`) and the caret (`buildTypingCaret`) are both generated from
this single plan, so they **cannot desync** — the class of bug that DM-1204
patched (a `linear` clip racing an `ease`-timed caret) is removed structurally
rather than by matching timing functions.

### Character-by-character stepping

In `mode: "type"` the reveal is a **per-keystroke staircase** (`step-end`): each
keystroke reveals one whole glyph and the caret jumps to its measured edge —
matching how real typing paints (a glyph appears atomically), not a smooth wipe.
Above `MAX_DISCRETE_TYPING_CHARS` (300 glyphs) the intra-line reveal falls back
to a linear sweep between the line's first/last glyph to keep the emitted CSS
bounded; the endpoints still use the measured edges, so the parked caret stays
exact. (Typing overlays are field entries — names, emails, queries — so the
ceiling is rarely reached.)

### Parameters

All optional; existing configs are unchanged.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `speed` | number (ms/char) | `60` | Per-keystroke delay. |
| `mode` | `"type"` \| `"paste"` | `"type"` | `type` steps glyph-by-glyph; `paste` drops the whole string at once (caret jumps to the end). `speed`/`jitter` are ignored in `paste`. |
| `jitter` | number `0–1` | `0` | Humanize the cadence: each delay becomes `speed × (1 ± jitter)` (min `0.25×speed`) drawn from a **deterministic** PRNG seeded off the text — so the SVG stays byte-stable across runs while the typing loses its robotic fixed interval. |
| `caret` | boolean \| `{ color, width, blinkMs }` | off | The blinking insertion bar; now `step-end` on both its position (per-keystroke jumps) and blink tracks. |
| `delay` | number (ms) | `300` | Delay from frame start before typing begins. |

Determinism note: jitter is seeded via an FNV-1a hash of the overlay text into a
mulberry32 PRNG, so a given config always emits the identical SVG (the project's
committed-golden invariant, `examples/animate/*/`).

## Verification (rendered SVG, not plan-math)

The fix is proven in the **rasterized frames**, per the house rule that the
rendered SVG is the source of truth:

- `svg-to-image out.svg --at <ms>` on a 25-char, 28px overlay shows a clean
  per-character reveal with the caret sitting immediately after the last revealed
  glyph at every step (no partial glyph under the caret, no trailing gap).
- The emitted `caret-pos` end stop is `translate(432.71px, …)` against a measured
  text width of `432.73px` (0.02px) — vs the old estimate's `420px` (12.7px
  behind).
- The `typing-search` / `form-fill` / `progress-install` golden SVGs were
  regenerated (`npm run demos:test:animate -- --update`); only those three
  changed, deterministically.

## Roadmap (designed, not yet built)

These were considered for v1 and deliberately scoped out; each is a clean
addition on top of the shared reveal plan.

1. **Mistake → backspace → correct.** A `mistakes` knob (probability or explicit
   `[{ at, wrong }]`) that types a wrong glyph, pauses, backspaces it, and
   retypes the right one. The reveal plan already sequences per-glyph events; a
   mistake is a plan entry with a negative (delete) step and a re-type. Needs:
   the reveal clip to shrink (not only grow), and the caret to step backward —
   both are just extra `TypedGlyph` events with earlier edges. Tunables: mistake
   rate, backspace speed, "think" pause before correcting.

2. **Per-keystroke real-site re-sampling.** Instead of synthesizing the field
   text as an overlay, actually drive the live page one `page.keyboard.type`
   keystroke at a time and **capture the field's painted state after each
   keystroke**, compositing the real per-character frames. This is the
   highest-fidelity mode (it renders the site's own font, IME, autocomplete,
   validation styling) at a capture cost the ticket accepts. Needs a capture-side
   loop in `src/cli/animate.ts` (a new `fill`-with-`type: "keystrokes"` action or
   a `resample: true` on the typing action) that emits N sub-frames. The caret
   would come from the field's real caret rect rather than the synthetic bar.

3. **Proportional / glyph-path rendering.** v1 keeps the monospace `<text>` +
   viewer-font dependency (exact on the capture platform, within the project's
   normal cross-viewer font tolerance elsewhere). Rendering the typed text as
   **glyph paths** via `renderTextAsPath` would make the painted advances equal
   the measured ones on **every** viewer by construction (no viewer-font
   dependency) and unlock **proportional** fonts (matching the field's actual
   font for realism) with **pixel-based wrapping** instead of the current
   char-count wrap. This is the natural convergence with the main text pipeline.

4. **`fontFamily` override on the overlay.** Let an author point the reveal at a
   specific family (e.g. the captured field's font) for both measurement and
   paint. Blocked on (3) for correct wrapping when the family is proportional.

5. **Paste-with-selection / replace.** A paste that first selects existing field
   text (highlight) then replaces it, for "edit an existing value" demos.

## Related

- `docs/43-declarative-animate-config.md` §5 — the `typing` overlay authoring
  surface (anchor, `wrapWidth`, `mask`, and now `mode` / `jitter`).
- `docs/13-cursor-overlay.md` — the cursor/caret model; typing overlays target
  the **content** box (where text starts inside a padded field).
- `docs/08-animation-model.md` — `AnimationOverlay` / `generateAnimatedSvg`, the
  renderer input the typing overlay is part of.
- `src/animation/animator.ts` — `renderTypingOverlay`, `measureTypingLines`,
  `buildTypingPlan`, `buildTypingLines`, `buildTypingCaret`.

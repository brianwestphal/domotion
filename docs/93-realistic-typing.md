# 93 — Realistic simulated typing

Status: **v1 shipped** (DM-1518). Character-by-character reveal with the caret
glued to the true text edge, plus a paste-vs-type mode and humanized jitter.
**Per-keystroke real-site re-sampling** (roadmap §2) is now also shipped
(DM-1556) — see "v2 — per-keystroke real-site re-sampling" below. The remaining
deeper behaviors (mistake/correct, proportional/glyph-path rendering) are
designed here and tracked as follow-ups.

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

### Exact caret height (per-font ascent + descent)

The caret x rides the measured advances (above); its **height** is likewise
taken from the face's exact metrics, not a fixed em multiplier. Blink draws a
bar caret at the text fragment / line-box height, which for `line-height:
normal` is the font's **metrics height = ascent + descent** (see the
`caret-metrics.ts` module note). `overlayAdvances` returns the resolved fontkit
face's `ascent` / `descent` (× `fontSize / unitsPerEm`), and `buildTypingCaret`
sizes the caret to `round(ascent + descent)` and places its top at `baseline −
ascent` (the overlay's `y` is the text baseline). That is algebraically the same
placement the `typeResample` caret uses — centering ascent+descent within the
line box under CSS half-leading — so both simulated-typing surfaces draw an
identical caret. The result is per-font-exact: a 20px serif, sans, and monospace
caret differ in height (e.g. 23 / 20 / 24 px) because their real metrics differ,
where the old `1.15×em` fallback gave all three the same 23px. When the face
can't be resolved, the caret falls back to `round(fontSize × 1.15)` with its
bottom 2px below the baseline (DM-1587), so it stays self-consistent without a
measurable font. (DM-1590.)

### Caret shape

The caret can be a `bar` (default), `block`, or `underscore` — see
[97-caret-shapes.md](97-caret-shapes.md). The geometry lives in the same
`caret-metrics.ts` module (`caretShapeRect`), shared with the `typeResample`
caret, so a block/underscore caret is drawn identically on both surfaces.

### GPOS-kerned proportional typing (`kern`)

By default the typed glyphs ride per-glyph advances (no kerning) — simple and
guaranteed to lock the caret to the true edge. Setting **`kern: true`** shapes
each line through `font.layout` (which applies `kern`/GPOS), so proportional
pairs like "AV" / "To" tighten. The kerned cumulative offsets become the ONE
`cum` array the glyphs, the reveal clip, AND the caret all ride — so the caret
stays flush even as the pairs pull together. A line whose shaped glyph count
doesn't map 1:1 to its code points (ligatures / reordering) falls back to the
per-glyph advances for that line, so the caret lock is never broken. Off by
default → the no-kern output is byte-identical (`fontkit` per-glyph advances).

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
| `mistakes` | number `0–1` \| `[{ at, wrong? }]` | off | Humanizing typos (DM-1555). See below. |
| `mistakeThinkMs` | number (ms) | `400` | Pause between typing a wrong glyph and backspacing it. |
| `delay` | number (ms) | `300` | Delay from frame start before typing begins. |

### Mistake → backspace → correct (DM-1555)

`mistakes` makes the typist occasionally slip: type a wrong glyph, pause to
"notice" it (`mistakeThinkMs`), backspace, then retype the correct one. Two
spellings:

- a **number** in `[0, 1]` — the per-character probability a typo fires. Only
  alphanumeric characters are eligible, never two adjacent, never the final
  character. Positions and the wrong glyphs are chosen by a **deterministic**
  PRNG seeded off the text, so the SVG stays byte-stable (the committed-golden
  invariant) while the slips look organic.
- an **explicit list** `[{ at, wrong? }]` — force a typo at flattened character
  index `at` (0-based across wrapped lines), optionally typing `wrong` first.
  When `wrong` is omitted a QWERTY-neighbor of the correct glyph is used
  (case-preserved; next digit for digits).

Mechanism: it rides the SAME shared reveal plan as the normal typing, so nothing
can desync. The wrong glyph is painted as a standalone element OUTSIDE the line
clip (which only ever reveals the correct text), shown over the held prefix
across `[showMs, hideMs)` and hidden on backspace. The caret's waypoint list
gains the extra steps — advance past the typo, **retreat** to the prefix edge on
backspace, re-advance on retype — so it visibly steps back then forward. The
natural type window grows by each typo's cost (wrong glyph + backspace + think
pause) so mistakes don't over-compress the rest of the typing.

Ignored in `mode: "paste"` (a paste has no keystrokes to mistype) and above the
discrete-stepping ceiling (`MAX_DISCRETE_TYPING_CHARS`), where the coarse linear
sweep has no room for per-keystroke detours.

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

## Glyph-path rendering, proportional fonts & pixel-accurate wrap (DM-1557)

The reveal now paints the typed text as **glyph paths** (`renderTextAsPath`,
forced into `paths` mode) instead of a native `<text>` element. Each wrapped
line becomes `<g class="tN-text" clip-path="…"><g transform="translate(x,
baseline)" aria-label="…"><use href="#gK"/>…</g></g>`, and the glyph `<path>`
defs are hoisted into the SVG's top-level `<defs>`. Why:

- **Viewer-independent advances.** A `<text>` element's width depends on the
  viewer having the font; a glyph path is baked geometry, so the painted advance
  equals the fontkit-MEASURED advance on **every** viewer by construction. The
  caret/clip (which already ride the measured `cum` array) can no longer disagree
  with the paint on a machine that lacks the field font.
- **Proportional fonts.** `overlayAdvances` measures each glyph's real
  `advanceWidth`, so a variable-width family lays out correctly — not just the
  monospace default. Each glyph is pinned at its measured left edge via the
  `xOffsets` passed to `renderTextAsPath`, so the system stays locked regardless
  of the font's own kerning.
- **Pixel-accurate wrap.** `wrapTypingTextPx` breaks lines by MEASURED pixel
  width (via the same advance fn), replacing the old `fontSize × 0.6` char-count
  estimate — so a proportional field wraps where it actually overflows.

Self-containment / determinism: `generateAnimatedSvg` snapshots the glyph-defs
registry before rendering, emits only the defs its overlays added
(`getGlyphDefsSince`), then rolls the registry back (`truncateGlyphDefs`), so a
repeat call in the same process re-assigns the same `gK` ids — byte-stable
output. When the font can't be resolved (a platform without the face), each line
falls back to a native `<text>` element, exactly as before.

Verified in the rasterized SVG: a 28px overlay paints "illus|" → "illustriou|"
with the blinking caret glued to the trailing edge of the glyph run, the parked
`caret-pos` stop matching the measured run width; the emitted markup is
`<use href="#gK">` refs with matching `<path id="gK">` defs and no `<text>`.

## `fontFamily` override (DM-1558)

The overlay takes an optional **`fontFamily`** — the CSS font-family the reveal
both MEASURES and PAINTS with. It defaults to the monospace field stack (`'SF
Mono', Menlo, Monaco, monospace`); point it at the captured field's own family
(e.g. `"Inter, sans-serif"`, `"Georgia, serif"`) so the simulated typing matches
the surrounding UI. Because the text is rendered as glyph paths (DM-1557), a
PROPORTIONAL family measures, wraps, and paints correctly — the caret still sits
at the true glyph edge, and `wrapWidth` breaks lines by the family's real pixel
widths. A first-choice family that can't be resolved falls back through the
stack; if nothing resolves, the reveal degrades to a native `<text>` element.

Verified in the rasterized SVG: `fontFamily: "Georgia, serif"` on a `wrapWidth:
220` overlay wraps "Wire Wave William milliliter" into `Wire Wave` /
`William milliliter` (two lines — the narrow proportional glyphs fit more per
line than the monospace default's three), paints a proportional serif, and
mid-type the caret sits flush against the wide `W`.

**Auto-resolve from the anchored field (DM-1579).** The sentinel
`fontFamily: "anchor"` adopts the anchored field's own computed `font-family`
(and its `font-size`, unless an explicit `fontSize` is set) during capture — so a
"type into this real field" overlay matches the field's font without the author
restating it. It reuses the same anchor-resolution path as `anchor` / `maxWidth:
"anchor"` (`resolveAnchoredOverlays`, which now also measures the element's
`font-family`/`font-size`) and requires an `anchor`.

## v2 — per-keystroke real-site re-sampling (shipped, DM-1556)

The `typing` overlay above SYNTHESIZES the field's text: it paints a monospace
`<text>` reveal on top of ONE captured frame. That's cheap and gives an exact
caret, but it renders *our* font and *our* characters — it cannot show what the
**page itself** does to the input. If the field applies an input mask
(`4155550142` → `(415) 555-0142`), auto-formats, validates (a green border once
complete), composes via an IME, or paints in its own font, the synthetic overlay
knows none of it; the author would have to hand-type the already-masked string
and still wouldn't get the field's real styling.

`typeResample` is the high-fidelity counterpart. It drives the **live** field one
keystroke at a time and **re-captures the whole page after each keystroke**, so
every intermediate state is the browser's own paint — masking, validation
styling, and font included. It's an explicit per-frame opt-in (docs/43 §, on the
same frame that would otherwise carry `input` / `continue` + `actions`):

```jsonc
{
  "input": "./checkout.html",
  "actions": [{ "type": "focus", "selector": "#phone" }],
  "duration": 2500,
  "typeResample": {
    "selector": "#phone",          // the input / textarea to type into
    "text": "4155550142",          // raw keystrokes — one re-captured state each
    "speed": 130,                  // per-keystroke hold (ms); default 60
    "delay": 300,                  // hold before the first key (ms); default 0
    "tailMs": 900,                 // hold on the fully-typed state (ms); default 700
    "clear": true,                 // clear the field first; default true
    "caret": true,                 // draw the field's REAL caret; default true
    "caretShape": "auto",          // DM-1591: "auto" honors the field's computed CSS caret-shape; bar/block/underscore force one
    "regionOnly": false            // DM-1581: capture only the field per keystroke; default false
  }
}
```

**`regionOnly` — cut the output size (DM-1581).** By default every keystroke
re-captures the WHOLE page, so the output is O(N·page) and any change OUTSIDE the
field (a live character counter, a validation message) animates too. With
`regionOnly: true` the full page is captured ONCE as a static base and each
keystroke captures only the FIELD's subtree, overlaid on that base — output drops
to O(page + N·field) (~30–70% smaller in practice, more the larger the page). The
field's own masking / validation / font is still faithful (the field itself is
re-captured); the tradeoff is that non-field page changes freeze at their initial
state. Opt-in, so the default output is unchanged.

### Mechanism — nest, don't extend the animator

The re-sampler follows the **`cast` / `template` nesting pattern** (docs/67,
docs/73) rather than adding anything to `generateAnimatedSvg`:

1. `clear` + focus the field, then, for each of the N characters, send **one**
   real `page.keyboard.type(char)` (so the page's `keydown` / `input` / `keyup`
   handlers run — the mask fires) and `captureElementTree` the whole page.
2. The N + 1 captures (0…N chars typed) become an in-memory `AnimationConfig`
   whose frames `cut` from one to the next on the keystroke clock — a flipbook.
   `generateAnimatedSvg` composes that into one self-contained animated SVG.
3. That SVG is namespaced (`tr<i>_`) and dropped in as the **single** outer
   frame's `svgContent`, with `embeddedAnimationPeriodMs` = the flipbook's total
   so the animator re-anchors the typing to restart when the frame is shown.

Because it produces exactly **one** outer animation frame per config frame, the
outer loop's 1-config-frame ↔ 1-animation-frame invariant (which the cursor
overlay, magic-move bridge, and frame-tree indexing all depend on) is preserved,
and **no animator code changes**. The per-keystroke captures render with
`includeEmbeddedFontCss=false`, so their glyphs accumulate into the whole run's
shared embedded-font block (collected once), exactly like a `cast` frame's
`manageFonts: false` — the field's own font is embedded once, not per state.

The caret comes from the field's **real** caret rect: after each keystroke the
renderer measures `selectionEnd` against the field's computed font (so it tracks
the edge of the *masked* value, not the raw keys) and draws a blinking bar there
(a `blink` overlay per state, using the field's `caret-color`). Set `caret:false`
to omit it.

### Cost & timeline

It's O(N) full-page captures — much heavier than the overlay's single capture,
which is why it's opt-in. Size the frame's `duration` to ≈ the play time
(`delay + N·speed + tailMs`); the CLI logs a note if `duration` is shorter (the
typing would be cut off), the same rule as a `cast` frame. Mutually exclusive
with the other content-producing frame kinds (`scroll` / `cast` / `template`);
it DOES drive the live page, so it's valid on a fresh `input` load or a
`continue` frame.

### Verification (rendered SVG, not live HTML)

Proven in the rasterized frames of the committed
`examples/animate/type-resample/` golden (a phone field that masks digits into
`(NNN) NNN-NNNN` and turns green when valid):

- At an early step the field reads `(415) 5` — the `(` and space were injected by
  the page's mask, **not typed** — proving the re-sample captured the page's own
  formatting rather than the raw keystrokes.
- The final held state reads the full `(415) 555-0142` **with the green
  `.valid` border**, i.e. the page's validation styling round-tripped too.
- Guards: `src/cli/type-resample.test.ts` (pure timeline / defaulting),
  `src/cli/type-resample.e2e.test.ts` (real-Chromium: the live field's masked
  `input.value` diverges from the raw keys; the config path nests the N-state
  animation in one frame), and the `type-resample` entry in
  `tests/animate-examples.tsx` (structural: 1 outer frame, nested animated
  `<svg>`, the final `tr0_f-10` state, a caret per state).

## Roadmap (designed, not yet built)

These were considered for v1 and deliberately scoped out; each is a clean
addition on top of the shared reveal plan.

Both **mistake → backspace → correct** (DM-1555) and **per-keystroke real-site
re-sampling** (DM-1556, the `typeResample` field — see the v2 section above) have
since shipped, as have **glyph-path rendering** (DM-1557) and the **`fontFamily`
override** (DM-1558). What remains:

1. **Paste-with-selection / replace.** A paste that first selects existing field
   text (highlight) then replaces it, for "edit an existing value" demos.

## Related

- `docs/43-declarative-animate-config.md` §5 — the `typing` overlay authoring
  surface (anchor, `wrapWidth`, `mask`, and now `mode` / `jitter` / `mistakes`).
- `docs/13-cursor-overlay.md` — the cursor/caret model; typing overlays target
  the **content** box (where text starts inside a padded field).
- `docs/08-animation-model.md` — `AnimationOverlay` / `generateAnimatedSvg`, the
  renderer input the typing overlay is part of.
- `src/animation/animator.ts` — `renderTypingOverlay`, `overlayAdvances`,
  `buildTypingPlan`, `planMistakes`, `buildTypingLines`, `buildTypingMistakes`,
  `buildTypingCaret` (the v1 overlay).
- `src/cli/type-resample.ts` — `buildTypeResampleAnimation` (v2 per-keystroke
  re-sampling), wired into `composeAnimateFrames` via the per-frame `typeResample`
  field in `src/cli/animate.ts`.
- `examples/animate/type-resample/` — the runnable v2 demo + committed golden.

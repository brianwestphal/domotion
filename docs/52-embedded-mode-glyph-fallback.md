# Domotion: per-glyph helper fallback in embedded-font mode

Requirements for extending the DM-891 per-glyph helper fallback (a font fontkit
opens but can't decode a specific glyph in → fetch that glyph's outline from the
native CoreText / FreeType / DirectWrite helper) to the **embedded-font render
mode**, which is the production default. Origin: DM-892, follow-up to DM-891;
pairs with DM-259 (Linux) / DM-260 (Windows) calibration. Sibling reference:
`docs/51-probe-then-fallback-dispatch.md`.

> **Status: implemented (DM-892).** The embedded-font glyph loop now routes
> through `commandsFor`, so a fontkit-empty-but-inkable glyph gets the helper's
> outline baked into the synthesized TTF — the same fallback `paths` mode got in
> DM-891. Inert on macOS by design (see "Why it's inert here"); its first real
> fixtures arrive with DM-259 / DM-260.

## The gap (before DM-892)

Domotion has two text render modes (`src/render/text-to-path.ts`):

- **`paths` mode** emits each shaped glyph as an SVG `<path>`. DM-891 added the
  per-glyph helper fallback here: at the five glyph sites, `commandsFor(glyph,
  …)` returns fontkit's outline when present, else — for an inkable,
  cmap-covered glyph fontkit decoded as empty — the helper's outline, fetched by
  glyph id from the same file fontkit loaded.
- **embedded-font mode** (`renderTextAsEmbedded`, the production default) instead
  bakes each shaped glyph into a synthesized TTF (`trackGlyphInEmbedFont`,
  `src/render/embedded-font-builder.ts`) and emits `<text>` carrying PUA
  codepoints that reference it. This loop read `glyph.path?.commands ?? []`
  directly — so a glyph fontkit couldn't decode produced an **empty `glyf`** in
  the synthesized font and rendered blank, even though `paths` mode would now
  fall back to the helper for the identical glyph.

## The design — simpler than the ticket assumed

DM-891 deferred this because supplying a helper outline in embedded mode "means
injecting it into the TTF `glyf`, a different mechanism than the `paths`-mode
`<path>` emission." Probing the actual code showed the two pieces already line
up, so **no bespoke glyf-construction code is needed**:

1. The helper's outline comes back as **fontkit-shaped `PathCommand[]`**
   (`moveTo` / `lineTo` / `quadraticCurveTo` / `bezierCurveTo` / `closePath`) —
   `helperGlyphOutline` returns `helper.getGlyph(id).path.commands` verbatim,
   the same shape fontkit's own `glyph.path.commands` has. That's why `paths`
   mode could feed `commandsFor`'s output straight into `ensureGlyphDef`.
2. `trackGlyphInEmbedFont` **already accepts that exact `PathCommand[]` shape**
   and converts each command into an opentype.js `Path` op (`moveTo` →
   `Path.moveTo`, `bezierCurveTo` → `Path.curveTo`, …), which opentype.js
   serializes into the TTF `glyf`. It does not care whether the commands came
   from fontkit or the helper.

So the fix is a one-line routing change: the embedded glyph loop computes
`const cmds = commandsFor(glyph, run.fontKey, weight, fontSize, slant)` instead
of reading `glyph.path?.commands` directly, then passes `cmds` to
`trackGlyphInEmbedFont` as before. The helper outline is in the font's design em
units (the helper opens the same file), matching the `run.font.unitsPerEm` the
builder is given, so no rescaling is required.

This reuses the entire DM-891 apparatus unchanged: the `commandsFor` gate, the
`isLegitimatelyInklessCodepoint` guard, the `(file, glyphId)` outline cache, and
the `fontSourceMap` WeakMap that restricts the fallback to fontkit-opened,
real-file fonts (helper-instance / webfont glyphs have no entry and never fire).

## Why it's inert on macOS

Inherited verbatim from DM-891. The fallback fires only for a glyph that is
**plausibly inkable** (`isLegitimatelyInklessCodepoint` excludes Cc/Cf/Zl/Zp/Zs,
the invisible math operators, variation selectors, and tags) yet came back empty
from fontkit. Empirically, every macOS glyph fontkit returns empty for is in
that inkless set **and** the helper agrees it's empty — so the embedded fallback,
like the `paths` one, never activates on macOS today. Its genuine targets are
Linux/Windows CFF/CJK faces fontkit opens but can't fully decode, which only get
routed once DM-259 / DM-260 calibration adds them.

## Out of scope

- **Stretchy math fences** (`renderStretchyFenceGlyph`) still can't use the
  per-glyph fallback: stretching needs the glyph's `bbox`, which the helper's
  outline response doesn't carry. It keeps the prior behavior (empty glyph →
  null). Minor; no fixture exercises it.
- **Cross-platform real-world validation** is gated on DM-259 / DM-260 providing
  a fixture that hits a genuinely-undecodable inkable glyph; until then the path
  is unit-tested only.

## Validation

- Unit (`src/render/text-to-path.test.ts`): a helper-supplied `PathCommand[]`
  injected via `trackGlyphInEmbedFont` re-parses out of the `@font-face` data URI
  as a **non-empty `glyf`**; plus a macOS-gated end-to-end case that fakes the
  trigger (an inkable Helvetica `H` whose fontkit outline is forced empty), runs
  the production `commandsFor` → helper → `trackGlyphInEmbedFont` chain, and
  confirms the baked glyph has a real contour.
- Regression: the feature suite (embedded-font is the default mode) stays at its
  current diffs on macOS — `text-mixed-script` and the showcase suite unchanged —
  proving the routing change is faithful for the normal (fontkit-decodes-fine)
  case. The DM-891 guard's existing unit coverage carries over since the same
  `commandsFor` is reused.

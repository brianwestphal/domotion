# Domotion: probe-then-fallback glyph dispatch

Requirements for routing a glyph to the native helper (CoreText / FreeType /
DirectWrite) when fontkit can read the font's `cmap` but not its outline — the
"probe-then-fallback" trigger from `docs/16` that was never built. Origin:
DM-887 (follow-up to DM-881; pairs with DM-259 / DM-260).

> **Status: design corrected after implementation probing — re-confirming (see
> [Implementation findings](#implementation-findings-correction)).** The
> maintainer approved "Option A, build now," but a probe disproved a premise:
> **PingFang has no openable font file on current macOS**, so fontkit can't be
> its primary and Option A can't subsume it (it must *coexist*), and the new
> probe path is **inert on macOS** (nothing validates it there). The corrected
> design + the decision this changes are at the bottom.

## The gap

DM-881 made the helper *resolvable + invocable* on all three platforms, but the
renderer only routes to it via the static `extractor: "coretext"` flag on
`FONT_PATHS` — set on macOS PingFang keys only. So:

- On Linux/Windows the helper is reachable but **nothing routes through it** (no
  `LINUX_FONT_PATHS` / `WIN32_FONT_PATHS` entry sets the flag).
- The trigger is per-*font* (a static flag), not the per-*glyph*
  "fontkit-empty-path → consult helper" model `docs/16` specifies.

## Current state (verified)

`textToPathMarkup` (`src/render/text-to-path.ts`) builds font *runs*: for each
codepoint it picks a font by **cmap coverage** — `primaryFont.glyphForCodePoint(cp).id === 0`
→ walk `fallbackFontChain`, take the first font whose `.id !== 0`. Each run is
then shaped with `font.layout(runText)`, and each shaped glyph's
`.path.commands` is converted to an SVG `<path>` by `ensureGlyphDef`.

The helper enters via `getFontInstance` (~line 1602): when the resolved spec has
`extractor: "coretext"` and the helper is available, the **whole font instance**
is swapped for a `CoretextFontInstance` that routes *everything* — cmap, metrics,
shaping (`layout`), and outlines — through the helper. fontkit is not consulted
for that font at all.

This works for PingFang because **all** its outlines live in the Apple-private
`hvgl` table, so fontkit can't read *any* of them — the font is all-or-nothing.

## The architecture fork

`docs/16` specifies a **per-glyph** model; the current code is **per-font**.
Two ways to close the gap:

### Option A — per-glyph outline fallback (doc-16 aligned) *(recommended)*

fontkit stays the primary font for cmap + metrics + shaping. Only at outline
extraction, when a shaped glyph's `.path.commands` is empty *and* its `.id !== 0`
(cmap-covered but outline-unreadable), fetch **that glyph's** outline from the
helper by glyph id (`createCoretextFont(...).getGlyph(id)`), keyed in a
`(fontFile, glyphId) → fontkit | helper | missing` cache so each glyph is probed
once per process.

- Pro: matches the contract; works for any font with unreadable outlines, on any
  platform, without per-font flags; correct for a hypothetically-mixed font.
- Con: **changes the macOS PingFang path** — shaping moves from the helper to
  fontkit. CJK is non-complex (no contextual joining / reordering), so fontkit
  shaping should be byte-equivalent, but this is the flagged render path, so it
  needs the PingFang fixture to stay clean (and a nod).
- Lets the static `extractor: "coretext"` flag eventually retire (it becomes one
  case of the general probe).

### Option B — probe-triggered whole-instance swap (incremental)

Keep the `CoretextFontInstance` whole-font swap, but *decide* to use it by
probing fontkit for empty outlines instead of reading the static flag.

- Pro: smaller; preserves the PingFang path (helper still does shaping) exactly.
- Con: per-*font*, not per-glyph — wrong for a font fontkit reads partially; and
  "is this font outline-unreadable?" needs a representative-glyph probe that's
  itself fuzzy. Diverges from the doc-16 contract.

In practice the only fonts we've hit with unreadable outlines are `hvgl`-based
(all-or-nothing), so B is *adequate today* — but A is the durable design and the
one doc 16 promises consumers.

## Dependency / timing

Pairs with **DM-259** (Linux) / **DM-260** (Windows) fallback calibration, which
decide *which* fonts route through the helper. Until they land, the only glyph
that exercises any helper path is macOS PingFang — so:

- Building now is **validated only by the PingFang fixture** (`text-mixed-script`,
  currently 0.00%); the new generality is inert on every other current fixture.
- There's no Linux/Windows fixture yet that hits a fontkit-empty-but-cmap-covered
  glyph, so the cross-platform benefit can't be regression-tested until
  calibration adds one.

This is the same "low-impact-but-correct ahead of calibration" caveat the
maintainer accepted for DM-881.

## Decision needed

1. **Option A or B?** Recommend **A** (doc-16-aligned per-glyph fallback) — it's
   the durable design and unifies all platforms. It refactors the macOS PingFang
   path (shaping → fontkit), so I'll prove `text-mixed-script` + any CJK showcase
   stay clean before/after.
2. **Build now or defer to DM-259/DM-260?** Recommend **build now** (A is
   self-contained and PingFang validates the refactor on macOS), *or* defer the
   build until calibration provides a non-PingFang validating fixture if you'd
   rather not touch the PingFang path until there's cross-platform payoff.

## Validation plan (when built)

- macOS: `text-mixed-script` (CJK via PingFang) and the showcase suite stay at
  their current diffs — proves the shaping-path change is faithful.
- Unit: the `(fontFile, glyphId)` resolution cache (probe-once), and that a
  cmap-covered-but-empty-outline glyph routes to the helper while a normal glyph
  stays on fontkit.
- Cross-platform dispatch is covered once DM-259/DM-260 add a routing fixture.

## Implementation findings (correction)

Probing the actual machine before building turned up three things that change
the plan I got the "Option A, build now" nod on:

1. **PingFang has no openable file on current macOS.** `/System/Library/Fonts/PingFang.ttc`
   does not exist (this box has `Hiragino Sans GB`, `STHeiti` instead); a
   filesystem search finds no PingFang file at all. CoreText still resolves
   `PingFangSC-Regular` *by name* (the helper works), but `fontkit.openSync`
   throws `ENOENT`. So **fontkit cannot be PingFang's primary instance** — the
   whole-instance swap isn't an optimization for PingFang, it's the *only* way
   to render it. Option A therefore **coexists with** the swap; it cannot
   subsume it, and the static `extractor: "coretext"` flag does **not** retire.
   This is also why the swap deliberately does `return null` instead of trying
   fontkit for `extractor:"coretext"` fonts — fontkit would throw.

2. **The naive trigger mis-fires on blank glyphs.** "empty `.path.commands` +
   `.id !== 0`" is *also* true of a space (U+0020) and other inkless glyphs in
   perfectly readable fonts. Routing those to the helper is at best wasted
   helper round-trips per space (the helper returns empty too, so it's a perf
   bug, not a correctness one). The real signal is per-*font*: "this font has no
   outline table fontkit can decode" (no `glyf`/`CFF`/`CFF2`) → then per-glyph
   the helper supplies outlines. So the trigger needs a **per-font
   outline-readability gate**, not a bare per-glyph empty-path check.

3. **The probe is inert on macOS.** The only macOS font fontkit can't extract
   outlines from is PingFang — which has no file, so it never reaches a fontkit
   primary instance (it's on the swap). There is **no fontkit-opened,
   outline-unreadable font on macOS** for the probe to fire on, so PingFang does
   *not* validate the new path (contrary to the "PingFang validates it on macOS"
   rationale in my build-now recommendation). The genuine targets are
   Linux/Windows CFF/CJK faces — which only get routed once DM-259/DM-260 land.

### Corrected design

- **Keep** the whole-instance swap for `extractor:"coretext"` / no-file fonts
  (PingFang) unchanged.
- **Add** a probe-then-fallback that engages only for a fontkit-*opened* font
  whose outline table is absent/undecodable (per-font gate), then fills each
  glyph from the helper by glyph id (ids match across engines for the same
  file), cached `(fontFile, glyphId)`.
- On macOS this is **inert + unit-tested only** (no fixture exercises it).

### Decision this changes

The "build now" nod rested on "PingFang validates the refactor on macOS," which
is false. Given the probe is fully inert on macOS and the real validation needs
a Linux/Windows fixture (DM-259/DM-260):

- **(i) Defer** the build until DM-259/DM-260 provide a validating fixture
  *(now recommended — avoids adding inert hot-path code with no integration
  test; matches how DM-889 was deferred on its dependency)*, **or**
- **(ii) Build now, unit-tested only** — the per-font-gated probe + cache, with
  PingFang regression-checked (stays on the swap, unchanged) and the new path
  covered by unit tests against a synthesized empty-outline glyph.

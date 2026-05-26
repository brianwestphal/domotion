# Domotion: probe-then-fallback glyph dispatch

Requirements for routing a glyph to the native helper (CoreText / FreeType /
DirectWrite) when fontkit can read the font's `cmap` but not its outline — the
"probe-then-fallback" trigger from `docs/16` that was never built. Origin:
DM-887 (follow-up to DM-881; pairs with DM-259 / DM-260).

> **Status: whole-font tier IMPLEMENTED (DM-887); per-glyph tier is a follow-up.**
> Investigation (below) corrected a premise of the original plan — PingFang has
> no openable file on current macOS, so the helper is a *whole-font* fallback,
> not a per-glyph patch on a fontkit primary. The implemented design and what
> shipped vs. deferred are in [Implemented](#implemented-dm-887). The two-tier
> framing + findings that motivated it follow.

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
is swapped for a `GlyphHelperFontInstance` that routes *everything* — cmap, metrics,
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
helper by glyph id (`createGlyphHelperFont(...).getGlyph(id)`), keyed in a
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

Keep the `GlyphHelperFontInstance` whole-font swap, but *decide* to use it by
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

## Implemented (DM-887)

The **whole-font fallback tier** — the part that handles every real case today,
including PingFang in both macOS configs — shipped in `getFontInstance`
(`src/render/text-to-path.ts`):

- The static `extractor: "coretext"` flag is retained as a **helper-eligibility
  marker** (so we never over-route inkless glyphs / color-bitmap fonts to the
  helper), but its behavior is now **fontkit-first, helper-as-fallback** rather
  than "always swap":
  1. Try `fontkit.openSync(spec.path)`.
  2. fontkit can render this font ⇔ it opened **and** has a `glyf` / `CFF ` /
     `CFF2` outline table (`fontHasOutlineTable`, which reads
     `font.directory.tables` — the `font.glyf`/`font['CFF ']` accessors read
     falsy even when the table exists).
  3. If the font is helper-eligible **and** fontkit can't render it (didn't open,
     or no outline table) **and** the helper is available → use the helper
     (`createGlyphHelperFont`, by postscriptName on macOS / fontPath elsewhere).
  4. Otherwise use the fontkit font; if it couldn't even open and the helper
     didn't rescue it, return null and the chain walks on (pre-DM-385 baseline).
- This covers **PingFang in both configs**: no file → `openSync` throws → helper;
  file present → opens but `hvgl`-only (no glyf/CFF) → helper. Validated on
  macOS: `text-mixed-script` (CJK via PingFang) stays at 0.00%, full feature
  suite unchanged (the 3 pre-existing border/button/counter diffs are unrelated),
  and `src/render/text-to-path.test.ts` covers `fontHasOutlineTable` directly.

### Deferred — the per-glyph tier (follow-up)

The second tier — a font fontkit **opens with** an outline table but **can't
decode a specific glyph** (a partial CFF/CJK face) — is **not** built:

- No current fixture exercises it. PingFang never reaches it (it's a whole-font
  case — no outline table at all), so it's **inert on macOS**; the genuine
  targets are Linux/Windows faces that only get routed once DM-259/DM-260
  calibrate their fallback chains.
- It's invasive: the per-glyph outline is consumed at ~7 sites in the render
  hot path, each of which would need the "empty + cmap-covered + non-whitespace
  → fetch from helper by (fontPath, glyphId), cached" logic.

Filed as a follow-up; it pairs with DM-259 / DM-260, which provide both the
routing and a fixture to validate against.

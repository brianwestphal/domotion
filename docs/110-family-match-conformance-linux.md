# 110 — Declared-family match conformance oracle (Linux)

`tools/family-match-conformance-linux.ts` · `npm run fonts:family-match:linux`
· baseline `tests/baselines/family-match-linux.json`

Sibling of doc 109 (macOS) and doc 111 (Windows). Blink runs different code
for this step on each platform, so each platform carries its own oracle and
its own baseline; a number from one says nothing about another.

## The mechanism being scored

Given `font-family: X; font-weight: N` on Linux, which concrete face does
Chrome open? The pinned Chrome build (tag `147.0.7727.15`, the build
Playwright ships) decides it as:

1. `FontCache::CreateTypeface` → `skia::DefaultFontMgr()->matchFamilyStyle(
   name, font_description.SkiaFontStyle())`
   (`third_party/blink/renderer/platform/fonts/skia/font_cache_skia.cc`,
   verified identical at the tag and at local checkout rev `7d859f27`).
2. On Linux that font manager is fontconfig-backed:
   `SkFontMgr_New_FCI(SkFontConfigInterface::RefGlobal(), …)`
   (`skia/ext/font_utils.cc:86-89` at the tag).
3. The whole decision is `SkFontConfigInterfaceDirect::matchFamilyName`
   (Skia rev `fd139e79` — the revision the tag's DEPS pins —
   `src/ports/SkFontConfigInterface_direct.cpp:592-713`):
   build an `FcPattern` from the family plus the style (weight/width mapped
   through Skia's anchor tables, which put extra rungs at 350 → DemiLight and
   380 → Book), `FcConfigSubstitute` + `FcDefaultSubstitute`, one
   `FcFontSort(trim=0)`, take the FIRST valid pattern (SFNT format required —
   Chrome defines `SK_FONT_CONFIG_INTERFACE_ONLY_ALLOW_SFNT_FONTS`,
   `skia/config/SkUserConfig.h:151-152` — and the file must be readable), then
   ACCEPT it only if its family list matches the request, the
   post-substitution name, or one of Skia's metric-equivalence classes
   (Arial/Arimo/Liberation Sans, Times New Roman/Tinos/Liberation Serif, …).
   Rejection is how Blink walks to the next CSS family.

**The pinned revision matters.** The current Skia tree rewrote `MatchFont` to
keep scanning until an acceptable pattern and added a direct `FcFontMatch`
stage; the shipping build has neither. The transcription follows the tag, not
the checkout.

The transcription lives in the Linux glyph helper (`familyMatch` query,
`tools/linux-glyph-extractor/src/main.cpp`); the render path reaches it
through `resolveLinuxFamilyMatch` → `linuxPrimaryCutKey`
(`src/render/font-resolution.ts`), which replaces the old two-slot
`key` / `key-bold` sibling routing. Both are gated on the helper being
present and on `DOMOTION_SYSTEM_FALLBACK != 0`, and degrade to the sibling
table otherwise.

## Method

Families are **derived, not authored**: every installed fontconfig family with
at least two faces (single-face families cannot discriminate between rules),
plus every declared name in the fixture corpus
(`tools/font-conformance-stacks.linux.json`) — which is how the
metric-alias path ("Arial" accepting Liberation Sans) and the REJECT path
(bare "Helvetica", which the shipping matcher refuses on the noble image)
both get measured.

Weights are the CSS ladder **plus intermediate rungs** (350 / 450 / 550). The
macOS port was exact at all nine canonical weights and divergent in the
301-399 / 501-599 bands — a canonical-only sweep is structurally blind to
exactly the region where this decision moves. 550 is the discriminating rung
on the noble image: the two-slot table crosses to bold at 600, fontconfig's
scoring (and Chrome, measured) crosses at 550.

Our side is the shipped helper query itself, not a restatement. Chrome's side
is CDP `CSS.getPlatformFontsForNode`, read by `postScriptName`, selected by
maximum `glyphCount`. Rows where our matcher rejects agree iff Chrome's paint
left the requested family too; rows where Chrome leaves both the requested and
matched families are skipped as Latin-probe coverage artifacts.

## Result at the time of writing (Playwright noble image, arm64)

    families 192  cases 2,304  scored 2,292  skipped 12
    agreement 2,292/2,292 (100.00%)  (agreed rejections: 2,184)

The rejection mass is expected: the corpus declares many families the CI image
does not install, and the shipping matcher genuinely refuses them (Chrome then
walks the stack / its last-resort chain). The 108 accept rows walk the
Liberation and WenQuanYi ladders across all twelve rungs, including the 550
crossover.

## In-the-loop verification (disable and require movement)

A flag being on is not evidence a mechanism is in the loop. Measured in the
noble image, through `getFontInstance`:

    DOMOTION_SYSTEM_FALLBACK unset:  arial@550 → LiberationSans-Bold
    DOMOTION_SYSTEM_FALLBACK=0:      arial@550 → LiberationSans

The answer moves at a discriminating rung, so the matcher is in the render
loop, and the disable knob restores the two-slot behavior. The seam test
`src/render/linux-declared-family-cut.test.ts` pins this permanently.

## Baseline discipline

`--write-baseline` records the run plus an environment fingerprint (platform,
arch, OS image, fontconfig version, font-inventory digest). The default mode
compares misses against the committed baseline and **refuses to judge (exit
3)** when any fingerprint field differs — a difference measured across two
environments is not evidence about the code. The committed baseline was
recorded in the pinned Playwright noble image on arm64 (Docker on Apple
Silicon); a CI x64 runner must record its own before the gate can grade it.

## What this oracle cannot see

- The family-NOMINATION stage above this call (`resolveFontKey`'s calibrated
  key table, and Blink's browser-side generic-family preferences) — the
  oracle asks both sides about the same family string, so a wrong nomination
  upstream is out of frame. Doc 107's whole-pipeline oracle covers that end.
- Italic and width axes are not swept (weight only, upright, normal width).
- The last-resort chain after a rejection ("Sans" → "Arial" →
  `legacyMakeTypeface(nullptr)`, `font_cache_skia.cc:146-200`) is asserted
  only as "Chrome left the family", not face-for-face.

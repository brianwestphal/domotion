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

## The nomination stage above it (transcribed where readable)

The stage that decides WHICH family gets style-matched is Blink's stack walk,
and `matchFamilyNameToKey` now runs the readable parts of it verbatim for
non-generic names (same gates, same degradation to the calibrated tables):

1. Ask the transcribed matcher about the declared name itself
   (`FontFallbackList::GetFontData` walks the stack per name,
   `font_fallback_list.cc:149-193`, tag `147.0.7727.15`).
2. On rejection, retry ONCE under Blink's alias — Courier ↔ Courier New,
   Times ↔ Times New Roman, Arial ↔ Helvetica
   (`font_platform_data_cache.cc:74-105` + `alternate_font_family.h:74-105`
   at the tag; `blinkAlternateFamilyName` is the transcription). This is how
   bare "Courier" lands on Liberation Mono: "Courier" rejects, "Courier New"
   accepts through the metric-equivalence class.
3. If both reject, walk PAST the family — return null so the next CSS name
   resolves — exactly as Blink does. Measured over CDP on the noble image:
   bare "Menlo" / "Consolas" / "Helvetica Neue" stacks paint Liberation
   Serif because Chrome exhausts the stack and lands on `-webkit-standard`,
   which is what our `times` terminal yields.
4. An accepted name registers the matched face under a `sysfb:` key carrying
   the ACCEPTED spelling, so `linuxPrimaryCutKey` re-matches that spelling at
   each run's real weight/slant/width.

The last-resort chain is transcribed too:
`FontCache::GetLastResortFallbackFont` (`fonts/skia/font_cache_skia.cc:147-261`
at the tag) tries `GetFallbackFontFamily(description)` — the EMPTY name for a
standard description — then "Sans", then "Arial", then
`legacyMakeTypeface(nullptr, style)`, which the FCI manager forwards to
`matchFamilyName(nullptr, …)` (`SkFontMgr_FontConfigInterface.cpp:253-256`,
Skia rev `fd139e79`). An empty-family pattern matches everything and
`IsFallbackFontAllowed` accepts it, so the first rung terminates on any host
with one valid SFNT font — the later rungs are defense-in-depth in Blink and
in our `linuxLastResortMatch` alike. It runs where Blink runs it: when a
declared family and its calibrated stand-in both match nothing.

**Deliberately NOT transcribed** — stated rather than approximated, because
the values live in the browser process, outside the renderer checkout:

- The generic-family → concrete-name preferences. The MECHANISM is readable
  (`FontSelector::FamilyNameFromSettings` reads
  `GenericFontFamilySettings.Standard/Serif/SansSerif/Cursive/Fantasy/Fixed/
  Math(script)`, `font_selector.cc:20-113` at the tag) but the VALUES are
  pushed from the embedder. `serif` / `sans-serif` / `monospace` / `cursive` /
  `fantasy` / `math` therefore stay on the measured static routes
  (`LINUX_SETTINGS_MAPPED_GENERICS` excludes them from the walk). Measured on
  noble: monospace → WenQuanYi Zen Hei Mono, sans-serif → Liberation Sans,
  serif → Liberation Serif.
- The `-webkit-standard` stage a fully-rejected stack falls to
  (`settings.Standard(script)`). Measured on noble as "Times New Roman" →
  Liberation Serif; carried as the calibrated `times` terminal, not a
  transcription.
- What `system-ui` becomes (`FontCache::SystemFontFamily()`, pushed from the
  browser side; `CreateTypeface` asserts `DCHECK_NE(family, kSystemUi)`).
  Its Linux route (the fontconfig default) and its weight ladder stay
  measured, not transcribed.

One residual of the shared key model, worth naming: a QUOTED generic
(`font-family: "sans-serif"`) is a plain family name to Blink
(`FamilyNameFromSettings` bails when `!FamilyIsGeneric()`), but our stack
splitter strips quotes before nomination, so it takes the generic's
calibrated route instead of the walk's rejection path.

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
arch, **Chromium version**, OS image, fontconfig version, font-inventory
digest). The default mode
compares misses against the committed baseline for THIS environment and
**refuses to judge (exit 3)** when no recorded fingerprint matches — a
difference measured across two environments is not evidence about the code.

The baseline file is an **env-keyed set** (`tools/family-match-baseline.ts`,
`{"format": "family-match-baseline-set/1", "baselines": [...]}`): one
recorded baseline per environment, selected by fingerprint equality, so the
arm64 Docker-on-Apple-Silicon image and CI's x64 container each carry their
own entry in the same committed file. A legacy single-report file reads as a
one-entry set, and `--write-baseline` records or replaces only the current
environment's entry, preserving the others.

**The browser is part of the fingerprint**, and it is the field the set went
without longest. Chrome's answers are what this oracle grades, so two runs under
different builds are two different oracles — measured: `font-variant-emoji:
emoji` moves U+00A9 to the colour font in Chromium 147.0.7727.15 and leaves it on
the run's primary in 148.0.7778.96, on one host with the platform held constant.
Read it from `browser.version()`, never from the Playwright revision directory: a
local VM launched a 148 build out of a folder named `chromium-1217`.

A fingerprint field ABSENT on either side is skipped rather than counted as a
difference ("cannot tell", not "known different"), which is what let `chromium`
join without disarming every committed baseline until each environment is
re-seeded. The check arms by itself the first time an entry is recorded carrying
it. `tests/family-match-baseline.test.ts` pins both halves and names the
exemption so it is removed once every entry carries the field.

## The CI gate

The `Linux family-match conformance` job in
`.github/workflows/test-linux.yml` runs on every PR inside the pinned noble
container: it builds the helper, runs the armed declared-family seam test
(`src/render/linux-declared-family-cut.test.ts` — the one CI site where the
nomination-walk pins execute rather than skip), then runs this oracle
**regression-relative**, exactly like the feature-suite fidelity gates: a
regression vs this environment's committed entry fails the job; identical or
improved misses pass. Until a baseline recorded on the CI image is
committed, the comparator's refuse-to-judge (exit 3) is turned into a green
run that records a candidate and uploads it in the `family-match-linux`
artifact — review it, commit `tests/baselines/family-match-linux.json`, and
the gate arms on the next run. The committed entry as of this writing was
recorded on arm64 (Docker on Apple Silicon), so the first CI run on the x64
image is expected to take the candidate path.

## What this oracle cannot see

- The family-NOMINATION stage above this call — the oracle asks both sides
  about the same family string, so a wrong nomination upstream is out of
  frame. The walk itself (declared name → alias retry → walk past) is now
  transcribed and pinned by `src/render/linux-declared-family-cut.test.ts`
  against CDP-measured paint, but this oracle still does not score it; doc
  107's whole-pipeline oracle covers that end. The generic-family
  preferences and `-webkit-standard` remain browser-side VALUES (measured,
  un-transcribed — see above).
- Italic and width axes are not swept (weight only, upright, normal width).
- Where a rejected family's paint actually LANDS is asserted only as
  "Chrome left the family", not face-for-face. The stages it lands through —
  the alias retry, the `-webkit-standard` stand-in, and the last-resort
  chain (`GetLastResortFallbackFont`, `font_cache_skia.cc:147-261` at the
  tag, now transcribed and wired) — are pinned by the seam test's measured
  cases instead.

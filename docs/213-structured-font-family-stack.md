---
id: "requirements/structured-font-family-stack"
title: "Structured captured font-family stack"
kind: "contract"
status: "current"
owners: ["text-fonts"]
platforms: ["macos", "linux", "windows"]
tickets:
  ["DM-2518", "DM-VY5DHJ", "DM-JQ57WW", "DM-N80HJW", "DM-ESH89H", "DM-PJG8E9", "DM-WREGPJ", "DM-ZAXD0C", "DM-JRG1BD"]
code:
  [
    "src/font-family-stack.test.ts",
    "src/capture/script/font-family-default.ts",
    "src/capture/script/font-family-default.test.ts",
    "src/capture/font-family-declarations.ts",
    "src/capture/font-family-declarations-cdp.ts",
    "src/capture/font-family-cascade.ts",
    "src/capture/font-family-cascade.test.ts",
    "src/capture/font-family-cascade-cdp.ts",
    "src/capture/font-family-cascade-cdp.test.ts",
    "src/capture/font-family-animation.ts",
    "src/capture/font-family-animation.test.ts",
    "src/capture/font-family-animation-cdp.ts",
    "tests/font-family-animation-provenance.e2e.test.ts",
    "src/capture/font-locale.ts",
    "src/capture/font-locale.test.ts",
    "src/capture/renderer-default-locale.ts",
    "src/capture/renderer-default-locale.test.ts",
    "tests/renderer-default-locale.e2e.test.ts",
    "tests/computed-font-locale.e2e.test.ts",
    "src/capture/font-family-values.ts",
    "src/capture/font-family-values.test.ts",
    "tests/font-family-css-wide-provenance.e2e.test.ts",
    "src/capture/font-family-default.e2e.test.ts",
    "packages/text-engine/src/font-family-stack.test.ts",
    "packages/text-engine/src/font-family-stack.ts",
    "packages/text-engine/src/render/registered-family-identity.test.ts",
    "packages/text-engine/src/render/webfont-registry.ts",
    "packages/text-engine/src/render/text-engine.ts",
    "src/capture/cross-origin-font-face.ts",
    "src/capture/font-face-family-identity.test.ts",
    "src/capture/script/font-metrics.ts",
    "tests/literal-family-whitespace.e2e.test.ts",
    "tests/font-family-stack-capture.e2e.test.ts",
    "tests/capture-script-determinism.test.ts",
    "scripts/build-capture-script.mjs",
    "src/capture/text-paint-geometry-cdp.ts",
    "tests/truncation-marker-capture.e2e.test.ts",
  ]
aliases: ["docs/213-structured-font-family-stack.md", "doc-213"]
---

# Structured captured font-family stack

## Contract

DM-2518 carries one decoded, typed font-family list from capture to every text
paint owner. The structured record is authoritative; the former CSSOM string
remains only for compatibility with older serialized trees.

This is a logical font-selection correction. It changes no screenshot score,
pixel tolerance, native-raster envelope, or host-font answer table.

## Pinned Blink ownership

The implementation is pinned to Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3`:

- `platform/fonts/font_family.{h,cc}` stores each linked-list node as either
  `kFamilyName` or `kGenericFamily`, with the decoded name rather than its CSS
  quoting or escape spelling.
- `core/css/resolver/style_builder_converter.cc::ConvertFontFamily` walks the
  CSS list in reverse. The first enum-bearing generic it encounters becomes
  `FontDescription::GenericFamily`, so the rightmost legacy generic wins.
  `system-ui` and `math` are generic list nodes but do not occupy that legacy
  enum.
- `core/css/properties/computed_style_utils.cc::ValueForFamily` serializes
  generic nodes as identifiers and literal nodes as CSS font-family values.
  Quoted generic-looking literals therefore remain distinguishable from bare
  generics in computed style.

HarfBuzz and Skia receive a face after this decision; neither can reconstruct a
lost CSS list-node type. The information must therefore be retained at capture
and consumed before Domotion resolves or shapes the run.

## Record and parser

`packages/text-engine/src/font-family-stack.ts` owns the browser-safe record:

```ts
{
  source: "blink-font-family-stack-v1",
  entries: Array<{ name: string; type: "family-name" | "generic-family" }>,
  genericFamily: "none" | "standard" | "webkit-body" |
    "serif" | "sans-serif" | "monospace" | "cursive" | "fantasy"
}
```

The CSS-aware tokenizer does not split quoted or escaped commas, decodes CSS
identifier/string escapes including hexadecimal escapes and escaped newlines,
and classifies a generic only when the computed token is an unquoted canonical
generic identifier. Literal names serialize quoted on output; only typed
generic nodes serialize bare. That makes a round trip unambiguous even for
`"monospace"`, `"A, B"`, and `Escaped\,Name`.

### Decoded family-name data (DM-N80HJW)

Only CSS token padding and unquoted identifier-sequence gaps are normalized.
Decoded quoted-string and escaped-character data is never trimmed: `" Face "`,
`"Face"`, escaped tabs, NBSP, all-space names and the empty literal string are
distinct family identities. NBSP is a valid identifier character, not CSS
whitespace. Escaped trailing spaces remain data even when PostCSS stores them
in declaration raw metadata or the containing rule's trailing raw text.

Font registration functions accept `{ decodedName: string }` for names already
decoded from CSSOM or font metadata. Their legacy string input retains its
existing quote normalization. This explicit boundary distinguishes a decoded
name containing literal quote characters from CSS quote syntax without
changing existing callers. Capture discovery, cached-registration replay,
session registration and isolated image-own-face metrics use decoded inputs.
Empty literal names resolve only when registered; an absent family stack still
uses the ordinary initial/fallback route. Local aliases follow the same exact
data boundary. Caller registrations are restored after isolated resolution,
including rejected font bytes.

This follows pinned Blink:
[`ConsumeFamilyName`/`ConcatenateFamilyName`](https://github.com/chromium/chromium/blob/7d859f271cbda744098ac69f44978d4edfa62be3/third_party/blink/renderer/core/css/properties/css_parsing_utils.cc#L6348-L6380)
passes string token data directly to `CSSFontFamilyValue`, while joining
identifier tokens with one space.
[`FontFace::SetFamilyValue`](https://github.com/chromium/chromium/blob/7d859f271cbda744098ac69f44978d4edfa62be3/third_party/blink/renderer/core/css/font_face.cc#L550-L557)
retains that value; `FontFaceCache::SegmentedFacesByFamily::AddFontFace` keys
`familyNameUnquoted()` without trimming. The binary `FontFace` constructor also
takes decoded name data directly, while CSS properties take serialized CSS.

Native controls match `Range` advances against the actual bundled candidate
fonts, then verify discovery, captured records and isolated `ch` geometry with
competing same-named caller bytes. The image controls also compare actual
glyph pixels, in both flatten modes. Generic-vs-literal node types and the
separate authored-default ambiguity (DM-ZZRZWK) retain their existing rules.
New exotic image family names with `font-family`/inline `style` XML attributes
retain source raster until the separate original-attribute namespace boundary
is proved (DM-SV4B1M). This restriction does not trim or alter their name data.
The same-byte DOM/embedded-SVG fixture control retains an independent existing
three-pixel antialias difference, at most two channel values; DM-FC9VGC owns
its attribution. It is unchanged by this identity correction. The image-own
geometry/glyph controls are pixel-exact.

Blink's initial `kStandardFamily` has no faithful concrete CSSOM spelling.
Capture represents it as one typed `-webkit-standard` node with descriptor
generic `standard`. Generated/first-letter/first-line/line-clamp paths inherit
that host record when their computed family is inherited. A matching authored
pseudo family declaration prevents the inheritance rewrite even when it
resolves to the same concrete settings face; this is the same-face mutation
control that a computed string alone cannot pass.

The UA-default admission guard requires one concrete family equal to the
current document's computed `initial` family, sampled once through a hidden
inline-important probe. Known author declarations and UA control fonts still
exclude the rewrite. A multi-family stack or a distinct named family is
retained even when its defining stylesheet is cross-origin and cannot be read
through CSSOM. This prevents an opaque authored webfont stack from being
replaced with standard serif routing (DM-JQ57WW), without changing renderer
fallback tables or assuming a platform-specific initial font name.

## Winning initial-name provenance

DM-ESH89H supplements the existing ZZR literal-only witness; it does not widen
that classifier. Readable and opaque initial-name candidates receive optional
native cascade facts. Computed `Times` alone is never evidence of concrete
versus standard family type.

Pinned Chromium `7d859f271cbda744098ac69f44978d4edfa62be3` owns the distinction:
[`FontFamily::ApplyInitial`/`ApplyInherit`](https://github.com/chromium/chromium/blob/7d859f271cbda744098ac69f44978d4edfa62be3/third_party/blink/renderer/core/css/properties/longhands/longhands_custom.cc#L4480)
create the initial description or copy the parent's complete description.
[`FontBuilder::InitialGenericFamily`](https://github.com/chromium/chromium/blob/7d859f271cbda744098ac69f44978d4edfa62be3/third_party/blink/renderer/core/css/resolver/font_builder.h#L106)
is `kStandardFamily`; literal `CSSFontFamilyValue` conversion is `kNoFamily`.
The resolver uses canonical inspector properties without raw source ranges/text,
matching-rule order, origin/importance and explicit `CSS.getLayersForNode` order.
`initial` stops inherited authored witnesses; `inherit`/inherited-property `unset`
copy the parent type. `revert` rolls to the lower origin. `revert-layer` follows
`CascadePriority::ForLayerComparison`/`CascadeMap::FindRevertLayer`, which remove
importance inversion before comparing rollback layers. A missing canonical
entry cannot authenticate a losing source declaration or ancestor.

Computed custom-property tokens come from inspector `GetVariables`. Bounded
`var()` substitution preserves strings, escapes, comments and token boundaries;
a known missing variable selects fallback or invalid-at-computed-value `unset`.
Unknown/budget-exceeded syntax is not called unset. A pending font shorthand
requires its empty canonical family plus matching canonical `shorthandEntries`;
important suffixes are removed before that pairing. `CSS.getLonghandProperties`
parses the substituted value. Its fixed size prefix validates standalone family
syntax only; no font metric or selected face comes from that prefix.
`CSS.resolveValues(font-family)` and animation `getKeyframes()` are not provenance:
both serialize distinct initial/concrete descriptions to the same concrete name.

Facts use the existing private per-element key, with separate standard/concrete
classification and renderer usability. Standard adoption requires authenticated
computed `-webkit-locale` to agree with captured DOM language, or an explicitly
decoded CSS locale string that the renderer can route (DM-PJG8E9); live
consumption rechecks both bindings. `all:initial` can reset locale to `auto`
despite `lang=ja`.
That known mismatch retains its exact prior family-type route with a warning
(DM-PJG8E9), without changing existing language metadata. Pseudos have their own bound facts;
unknown/blocked pseudo evidence cannot borrow a newly proved host standard type.
Native query failure preserves an independently valid ZZR literal witness.

### Animated family type

An animation that wins the family cascade keeps its keyframe's type. Chromium
has no interpolation type for `font-family`: `CSSDefaultInterpolationType`
applies the keyframe's own CSSValue (`interpolation_types_map.cc:497-504`,
`css_default_interpolation_type.cc:64-83`, Chromium 7d859f27), so an `initial`
keyframe applies the standard family even though every serialization prints the
concrete-looking `Times`. `src/capture/font-family-animation.ts` transcribes the
sampler that picks the keyframe:

- interval records with open first/last ranges and coincident-offset collapse
  (`keyframe_effect_model.cc:567-627`), synthetic neutral boundaries and the
  zero-offset easing (`:509-553,846-864`), and `RemoveRedundantKeyframes`
  (`:694-711`);
- the local fraction eased by the interval's START keyframe
  (`interpolation_effect.cc:27-41`) with gfx cubic-bezier, `steps()` and
  `linear()` (`ui/gfx/animation/keyframe/timing_function.cc`);
- the discrete flip `fraction < 0.5 ? start : end`
  (`primitive_interpolation.h:127-143`, chosen by
  `invalidatable_interpolation.cc:168-206`); a neutral side leaves the lower
  layer or static cascade in place, and a value replaces whatever is below it,
  because `CSSDefaultInterpolationType::Composite` is a plain set.

`src/capture/font-family-animation-cdp.ts` joins the element's own
`getAnimations()` (composite order, `getComputedTiming().progress`, keyframe
offsets and easings) with the authored values: the Blink-resolved
`cssKeyframesRules` from `CSS.getMatchedStylesForNode` for CSS animations (the
last block per offset wins, `css_animations.cc:406-711`), or the specified
`Element.animate()` keyframes. The keyframe chosen for a CSS animation must
reproduce the element's computed family, which rejects a wrong interval or flip
side outright. CSS transitions (their keyframes are computed values), scroll and
view timelines, pseudo-element targets, `font`/`all` keys, running animations
whose keyframes change type, step boundaries whose result depends on the phase
limit direction, results within solver tolerance of the flip, and an empty page
join all stay unknown. `tests/font-family-animation-provenance.e2e.test.ts`
proves each admitted case against natively painted static `initial` and
same-named concrete controls, with a negative control that breaks the join.

Assigned-slot/author-shadow inheritance, nested or anonymous layer identity,
scoped/starting rules and injected sheets whose author/user origin is not exposed,
unsupported direct functions, unproved `all` substitution and transition-driven
family type remain explicit unknowns (DM-RRAX58, DM-D8RS5E). No broader cascade
parity is claimed. Inheritance is capped at 64 scopes, computed style at 4,096 properties,
and substitution at 64 KiB/32 nested levels/256 expansions. New native reads have
Node bounds; late reads cannot start another query or install a family fact.
Object groups, sessions and private keys retain their owned cleanup.

Native readable/opaque controls use the real production capture entry point in
both A/B arms, toggling only the declaration provider's literal-only test mode.
Actual painted A PostScript faces and Range advances must match fontkit candidate
advances (including Blink's 1/64 CSS-pixel layout quantum); usable captured types
must select those same faces. Existing ZZR reset/literal/iframe/shadow controls
remain strict. Matching source/legacy/current PNG/SVG evidence is retained, with
raw pixel differences reported separately from semantic face/type assertions.
Full-frame residual differences are not attributed by the improvement alone
(DM-GREERW). Linux and Windows have a separate strict two-case native profile;
local macOS evidence does not stand in for those target runners.

## Owner matrix

The record is captured and consumed for:

- ordinary element styles and ordinary horizontal/vertical text;
- exact `::before`/`::after` pseudo-fragment typography and legacy generated
  segments;
- styled `::first-letter` and `::first-line` segments;
- generated `-webkit-line-clamp` ellipsis segments;
- input/textarea placeholder text;
- listbox option rows, closed select display text, and captured file-selector
  button/status text;
- emoji raster-selection checks, emphasis marks, decorations, named
  `@font-feature-values`, palette ownership, and font-metric alias probes.

All renderer entry points call the shared serializer before face resolution.
If the structured field is absent, the legacy string is retained unchanged so
previous capture files remain readable.

The `text-overflow` marker path also renders its measured ellipsis
or author string through the text engine. It emits glyph paths or an embedded
font subset at the captured baseline, rather than a plain SVG `<text>` that
would depend on the SVG viewer's installed fonts. Default capture retains a
single untransformed overflowing text node in a block container for this path;
other fragment shapes can still use Chromium's raster surface when their
source intervals cannot be proven.

## Exact gates

`packages/text-engine/src/font-family-stack.test.ts` covers quoted commas,
escaped names, hexadecimal escapes, quoted generic-looking literals, rightmost
legacy generic semantics, non-occupying `system-ui`/`math`, the standard
sentinel, and round-trip identity; `src/font-family-stack.test.ts` covers the
root renderers that consume the record under hostile raw-string/node-type
mutations.

`tests/font-family-stack-capture.e2e.test.ts` captures the same authored stack
through ordinary, generated, first-letter, line-clamp, placeholder, and
listbox owners. Its UA-default arm requires inherited standard identity across
ordinary/generated/first-letter/clamp owners, while an authored same-face
pseudo must remain a literal family node. The assertions compare decoded
entries and descriptor semantics only—there is no pixel assertion or
tolerance.

The generated capture script is rebuilt twice and must have the same SHA-256
before handoff; `tests/capture-script-determinism.test.ts` enforces this (two builds to a temporary path via `DOMOTION_CAPTURE_SCRIPT_OUT` must match each other and the tracked `src/capture/script.generated.ts`).
The bytes must also be independent of the checkout layout (DM-WREGPJ). esbuild
labels each inlined module with a `// <path>` comment relative to its working
directory after resolving symlinks, so a worktree whose `node_modules` linked
into another checkout once committed `../../../Users/<name>/…` paths. The build
pins `absWorkingDir` to the checkout, keeps symlinked workspace packages at
their `node_modules/@domotion/…` specifier path (`preserveSymlinks`), and
refuses any escaping or absolute module comment. The same test also rebuilds
from a foreign working directory and from a checkout whose `src` and
`node_modules` are links into this one, and requires the tracked bytes both
times.

## Computed font locale and language metadata (DM-PJG8E9)

`CapturedStyles.fontLocale` and `CapturedPseudoTypography.fontLocale` are
optional raw computed CSS `-webkit-locale` values. Their existing `lang` and
`language` fields remain DOM/document language metadata. New captures retain
both; JSON round trips keep the distinction. Older captured trees omit the new
field and retain their previous rendering route.

`fontSelectionLanguage()` decodes only a complete explicit CSS string, including
escapes and an explicit empty string, for font selection, shaping, emphasis,
vertical decoration and generated pseudo font paths. The same route governs
pseudo glyph bitmap representation checks. Initial-name family facts may adopt
a proven standard type under an explicit CSS locale even if it differs from DOM
language. Their live computed locale and original DOM-language binding are still
checked. No text-engine public API signature changes or blanket locale overrides
are introduced. Platform dispatch remains the existing CoreText/fontconfig/
DirectWrite path behind the shared language argument.

The existing Page generic-font probe requests `-webkit-locale` in its owned
DOMSnapshot read and adds decoded explicit layout-style locales to the existing
per-script target set. This includes a script authored only in CSS, absent all
DOM language attributes and response headers, and retains old/absent snapshot
styles and invalid string indices safely. It adds no new CDP command or lifetime.

Pinned source authority:

- [WebkitLocale parsing, computed serialization and null/string application](https://github.com/chromium/chromium/blob/7d859f271cbda744098ac69f44978d4edfa62be3/third_party/blink/renderer/core/css/properties/longhands/longhands_custom.cc#L11345).
- [HTML XML-language priority over lang](https://github.com/chromium/chromium/blob/7d859f271cbda744098ac69f44978d4edfa62be3/third_party/blink/renderer/core/html/html_element.cc#L445) and [language presentation declarations](https://github.com/chromium/chromium/blob/7d859f271cbda744098ac69f44978d4edfa62be3/third_party/blink/renderer/core/dom/element.cc#L12550).
- [FontDescription null locale uses LocaleOrDefault for script](https://github.com/chromium/chromium/blob/7d859f271cbda744098ac69f44978d4edfa62be3/third_party/blink/renderer/platform/fonts/font_description.h#L298), [LayoutLocale default language](https://github.com/chromium/chromium/blob/7d859f271cbda744098ac69f44978d4edfa62be3/third_party/blink/renderer/platform/text/layout_locale.cc#L294) and [renderer --lang authority](https://github.com/chromium/chromium/blob/7d859f271cbda744098ac69f44978d4edfa62be3/content/renderer/render_thread_impl.cc#L711).

**Renderer default locale (DM-JRG1BD).** Computed `auto` is a null
`FontDescription` locale, so Blink selects with `LayoutLocale::GetDefault()` →
`DefaultLanguage()` → the renderer's own `--lang` switch
(`content/renderer/render_thread_impl.cc:711-720`, Chromium 7d859f27). The browser
appends `--lang=<GetApplicationLocale()>` to every renderer after the switches it
propagates (`render_process_host_impl.cc:3757-3765`) and `base::CommandLine` keeps
the last value (`base/command_line.cc:433-451`). `src/capture/renderer-default-locale.ts`
reads that value: it takes the browser and renderer pids from
`SystemInfo.getProcessInfo`, requires the browser to descend from this Node
process and every renderer from the browser, reads each argv (macOS `ps`, Linux
`/proc/<pid>/cmdline`, Windows `Win32_Process` through CIM, never a shell), takes
the last `--lang`, canonicalizes `_` to `-` and an empty value to `en`, and
requires all renderers to agree. Only the language value is kept. Capture writes
it as `defaultFontLocale` beside every computed `auto` locale (elements and pseudo
typography), the Page generic probe adds its script, and `fontSelectionLanguage`
prefers it over DOM language for `auto` only. A connected/remote browser,
unreadable argv, disagreement, or `DOMOTION_RENDERER_DEFAULT_LOCALE=0` leave it
absent, which keeps the prior DOM-language route; old trees are unchanged.

The locale reaches paint through the per-script generic settings on every
platform: `FontSelector::FamilyNameFromSettings` reads
`FontDescription::GetScript()` = `LocaleOrDefault().GetScript()`
(`platform/fonts/font_selector.cc`, `font_description.h:299-302`), and
`FontFallbackList::GetFontData` appends `-webkit-standard` after the author
families (`font_fallback_list.cc:180-188`). On macOS, measured with launches at
`--lang=ja` / `zh-TW` / `ko`, a no-`lang` Han run in `Times`, `Helvetica`,
`sans-serif` or `initial` paints the script's standard face (Hiragino Kaku Gothic /
PingFang TC / Apple SD Gothic Neo) and `serif` the script's serif face, while
`CTFontCreateForString` itself receives no locale (`mac/font_cache_mac.mm:127-185,
314-372`). Linux additionally passes `LocaleOrDefault()` to fontconfig and Windows
to `LayoutLocale::GetDefault()`, both through the same `lang` route.

Navigator language comes from AcceptLanguages and Intl locale can be separately
overridden (`Emulation.setLocaleOverride` changes ICU/V8 only); neither is Blink's
default font locale, and neither is consulted. `tests/renderer-default-locale.e2e.test.ts`
launches `--lang=ja`, `zh-TW` and `en_US` and checks the authenticated value, the
captured routing, the generic primaries against Chromium's painted faces, and that
removing the authority moves the rendering away from Chromium (macOS: 6.96% →
4.84% for `ja`, 5.52% → 4.87% for `zh-TW`, unchanged for `en-US`).

The bounded native regression records actual painted A faces, Range widths and
fontkit advances for CSS inheritance/unset, authored overrides, variables and
XML-language precedence, retains auto/initial negative cases, and compares old
versus new routes through real capture/render. A CSS-only Bengali script control
moves the actual generic probe result from absent to present; a generated pseudo
keeps DOM language `en` while its explicit CSS locale is `ja`. Matching source,
prior/current PNGs and raw `diffPct` are evidence, not an attribution of every
residual pixel. Linux and Windows ordinary native workflows run the same strict
two-case selection and always retain its platform-specific artifact directory.

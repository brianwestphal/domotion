# Domotion: Cross-platform font path discovery

Requirements for resolving each logical font key to a real on-disk font file
on macOS, Linux, and Windows. Origin: DM-258 (the foundation of the
cross-platform roadmap — DM-259 / DM-260 / DM-261 / DM-262 all build on it).

## Problem

`FONT_PATHS` in `src/render/font-resolution.ts` was a flat table of macOS-only
paths (`/System/Library/Fonts/...`). On Linux and Windows none of those paths
exist, so `getFontInstance` returned null for every primary and fallback font
and the renderer produced `.notdef` tofu (or `<text>` fallback) for everything.
Domotion ships as an npm package and must function on all three platforms, so
font *path discovery* has to be platform-aware.

This doc covers **path discovery only** — mapping each logical key to a font
file that exists on the host. The separate question of *which* logical key
Chromium actually paints for each Unicode block (the fallback-chain
calibration) is platform-specific and tracked per platform:

- Linux fallback-chain calibration — DM-259.
- Windows fallback-chain calibration — DM-260.
- Bundled fallback fonts for headless CI without system fonts — DM-261.

So after this change the *primary* families resolve to a real face on every
platform (no universal tofu), but symbol / CJK / RTL / Indic block coverage on
Linux and Windows is not yet pixel-faithful to Chromium-on-that-platform.

## Design

A single resolver, `resolveFontSpec(key)`, dispatches by `process.platform`:

| Platform | Source | Discovery |
| --- | --- | --- |
| `darwin` | `FONT_PATHS` (unchanged) | Direct lookup; file existence handled downstream by `fontkit.openSync` / the CoreText helper, preserving the family-chain fall-through for fonts that aren't installed (e.g. Source Serif Pro). |
| `linux` | `LINUX_FONT_PATHS` | Canonical `/usr/share/fonts/...` path tried first when it exists; otherwise `fc-match -f '%{file}\t%{postscriptname}' <pattern>` (fontconfig) — robust across Debian / Arch / Fedora layout differences. |
| `win32` | `WIN32_FONT_PATHS` | `%WINDIR%\Fonts\<file>` (stable across Windows 10/11), guarded by an existence check. |

Resolved specs are cached per logical key in `resolvedSpecCache` (the
`fc-match` shell-out is the main cost this avoids repeating). Because
`process.platform` never changes at runtime, a single key→spec cache is
sufficient.

The resolver returns the same `{ path, postscriptName?, extractor? }` shape on
every platform, so everything downstream — the weight/slant variant logic, the
TTC member pick, the CoreText extractor route, `fontkit.openSync` — is
unchanged. `getFontInstance` simply swaps its `FONT_PATHS[effectiveKey]` lookup
for `resolveFontSpec(effectiveKey)`.

### Why `fc-match` on Linux

Hardcoded `/usr/share/fonts/...` paths are brittle: package layouts differ
across distros and the Playwright CI image installs a specific (and evolving)
font set. `fc-match` is how Chromium-on-Linux itself resolves fonts (both go
through fontconfig), it's present wherever Chromium can run, and it *always*
returns a best-match file — so even when the requested family is absent the
resolver gets a real, existing path instead of null. We pass through
`%{postscriptname}` so collection (`.ttc`) files pick the right member.

### Per-platform logical-key mapping

The logical keys are macOS-centric (they're named after the macOS face Chromium
paints). Each platform maps them to its nearest equivalent.

The Linux column below is the **shipped, calibrated** default mapping
(`LINUX_FONT_PATHS` in `src/render/font-resolution.ts`), reverse-engineered from
a Chrome CDP sweep of the Playwright `*-noble` Docker image CI runs against — so
it's Liberation (sans/serif) + WenQuanYi Zen Hei (mono/CJK) + FreeFont +
Loma/IPAGothic for the lang-fallback scripts, **not** the DejaVu/Noto set the
generic `fc-match` substitution would suggest (which is why the originally-drafted
DejaVu/Noto column was wrong). A mainstream desktop-Linux host with the Noto
family installed instead resolves the generic primaries to Noto via the opt-in
**Noto profile overlay** (`LINUX_FONT_PATHS_NOTO`, active when
`linuxFontProfile() === "noto"`); see `docs/42-cross-platform-fallback-calibration.md`.

| Logical key(s) | macOS | Linux — noble image (`LINUX_FONT_PATHS`) | Windows (file) |
| --- | --- | --- | --- |
| `helvetica` (= CSS `sans-serif`) | Helvetica | Liberation Sans | `arial.ttf` |
| `arial` | Arial | Liberation Sans | `arial.ttf` |
| `times` (= CSS `serif`) | Times | Liberation Serif | `times.ttf` (Times New Roman) |
| `times-new-roman` | Times New Roman | Liberation Serif | `times.ttf` |
| `georgia` | Georgia | Liberation Serif | `georgia.ttf` |
| `courier` (= CSS `monospace`) | Courier | WenQuanYi Zen Hei Mono | `cour.ttf` (Courier New) |
| `menlo` / `monaco` / `sf-mono` | Menlo / Monaco / SF Mono | WenQuanYi Zen Hei Mono | `consola.ttf` (Consolas) |
| `sf-pro` (= `system-ui`) | SF Pro | Liberation Sans | `segoeui.ttf` (Segoe UI) |
| `cjk` / `pingfang-*` / `korean` | Hiragino Sans GB / PingFang / Apple SD Gothic | WenQuanYi Zen Hei | `msyh.ttc` (YaHei) / `msjh.ttc` (JhengHei) / `malgun.ttf` |
| `cjk-serif` | Songti SC | WenQuanYi Zen Hei (no separate serif CJK face) | `simsun.ttc` (SimSun) |
| `hiragino-jp` | Hiragino Kaku | IPAGothic (`fonts-japanese-gothic.ttf`) | `YuGothR.ttc` (Yu Gothic) |
| `thai` | Thonburi | Loma (`tlwg/Loma.otf`) | `leeluisl.ttf` (Leelawadee UI Semilight, PS `LeelawadeeUI-Semilight`) |
| `devanagari` | Kohinoor | FreeSans | `Nirmala.ttc` (Nirmala UI, PS `NirmalaUI`) |
| `sf-arabic` | Geeza Pro | FreeSerif | `segoeui.ttf` (Segoe UI) |
| `sf-hebrew` | SF Hebrew | Liberation Sans | `segoeui.ttf` (Segoe UI) |
| `symbols` / `zapf-dingbats` | Apple Symbols / Zapf Dingbats | FreeSans | `seguisym.ttf` (Segoe UI Symbol) |
| `stix-math` | STIX Two Math | FreeSerif | `cambria.ttc` (Cambria Math) |
| `lucida-grande` | Lucida Grande | Liberation Sans | `arial.ttf` |
| `snell` / `apple-chancery` (= `cursive`) | Snell / Apple Chancery | (fontconfig `cursive`) | `comic.ttf` (Comic Sans MS) |
| `papyrus` (= `fantasy`) | Papyrus | (fontconfig `fantasy`) | `impact.ttf` (Impact) |
| `source-serif-pro` | `/Library/Fonts/...` (if installed) | — (unmapped → chain falls through) | — (unmapped → chain falls through) |

Beyond these primaries, the Linux table also carries a generated per-Unicode-block
route table (`UNICODE_FONT_PATHS_LINUX`, the `u-…` keys — 9 fonts covering
326/330 blocks on the bare image, dominated by Unifont) plus the Noto-profile
block routes (`UNICODE_FONT_PATHS_NOTO_LINUX`, the `un-…` keys). Keys with no
per-platform entry resolve to `null`, which makes the family chain walk to the
next candidate — identical to the macOS "font not installed" behavior. The macOS-only `extractor: "native"` flag (which routes to the
CoreText helper) is never set on the Linux / Windows tables; those faces open
through fontkit like any other file.

## Edge cases

- **`fc-match` always matches**: a Linux box missing the requested family still
  gets fontconfig's best substitute, so primaries never tofu. The substitute may
  not be what Chromium picks — that's DM-259's job to calibrate, not this layer's.
- **Collection files**: Noto CJK and the Windows `.ttc` faces need a
  `postscriptName` to select the member. Windows entries hardcode it; Linux
  entries take it from `fc-match`'s `%{postscriptname}`.
- **No regression on macOS**: the `darwin` branch is `FONT_PATHS[key] ?? null`,
  byte-for-byte the old behavior, so the existing painted-output baselines are
  untouched.

## Acceptance criteria

- `npm test` passes on macOS with no regression (the resolver's darwin branch is
  the unchanged lookup). ✅
- On Linux / Windows with the canonical platform fonts, `getFontInstance("helvetica")`
  returns a font (DejaVu Sans / Arial respectively), verified by the
  `resolveFontSpec: cross-platform font path discovery` tests, which run on every
  platform's CI and assert the sans-serif primary resolves to an on-disk file and
  the CSS generics become renderable.
- Per-platform mapping documented here and cross-linked from
  `docs/03-font-family-chain.md`.

## Follow-ups

This doc captures the DM-258 *path-discovery* foundation. The fallback-chain
calibration that built on it has since shipped — see
`docs/42-cross-platform-fallback-calibration.md` for the current per-platform
state:

- Linux fallback chain — **calibrated** against Chromium-on-Linux (the noble-image
  mapping in the table above; matches Chromium's glyph selection within the
  documented ≤1% native-hinting floor).
- Windows fallback chain — **calibrated** against Chromium-on-Windows (≤4% floor).
- Live per-codepoint system-fallback resolvers — **calibrated and default-on** on
  all three platforms (macOS CoreText, Linux fontconfig, Windows DirectWrite; see
  `docs/80-cross-platform-system-fallback-resolver.md`).
- Remaining roadmap (tracked locally): a Noto desktop-Linux profile refinement and
  promoting the Linux/Windows visual gates to required CI checks.

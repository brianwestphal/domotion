# Domotion: Cross-platform font path discovery

Requirements for resolving each logical font key to a real on-disk font file
on macOS, Linux, and Windows. Origin: DM-258 (the foundation of the
cross-platform roadmap — DM-259 / DM-260 / DM-261 / DM-262 all build on it).

## Problem

`FONT_PATHS` in `src/render/text-to-path.ts` was a flat table of macOS-only
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
paints). Each platform maps them to its nearest equivalent. Calibration
(DM-259 / DM-260) may revise which key handles which block, but the *path* each
key resolves to is:

| Logical key(s) | macOS | Linux (fontconfig family) | Windows (file) |
| --- | --- | --- | --- |
| `helvetica` (= CSS `sans-serif`) | Helvetica | DejaVu Sans | `arial.ttf` |
| `arial` | Arial | Liberation Sans | `arial.ttf` |
| `times` (= CSS `serif`) | Times | DejaVu Serif | `times.ttf` (Times New Roman) |
| `times-new-roman` | Times New Roman | Liberation Serif | `times.ttf` |
| `georgia` | Georgia | DejaVu Serif | `georgia.ttf` |
| `courier` (= CSS `monospace`) | Courier | DejaVu Sans Mono | `cour.ttf` (Courier New) |
| `menlo` / `monaco` / `sf-mono` | Menlo / Monaco / SF Mono | DejaVu Sans Mono | `consola.ttf` (Consolas) |
| `sf-pro` (= `system-ui`) | SF Pro | DejaVu Sans | `segoeui.ttf` (Segoe UI) |
| `cjk` / `pingfang-*` | Hiragino Sans GB / PingFang | Noto Sans CJK {SC,TC,HK} | `msyh.ttc` (YaHei) / `msjh.ttc` (JhengHei) |
| `cjk-serif` | Songti SC | Noto Serif CJK SC | `simsun.ttc` (SimSun) |
| `hiragino-jp` | Hiragino Kaku | Noto Sans CJK JP | `YuGothR.ttc` (Yu Gothic) |
| `korean` | Apple SD Gothic Neo | Noto Sans CJK KR | `malgun.ttf` (Malgun Gothic) |
| `thai` | Thonburi | Noto Sans Thai | `LeelaUIsl.ttf` (Leelawadee UI) |
| `devanagari` | Kohinoor | Noto Sans Devanagari | `Nirmala.ttf` (Nirmala UI) |
| `sf-arabic` | Geeza Pro | Noto Sans Arabic | `segoeui.ttf` (Segoe UI) |
| `sf-hebrew` | SF Hebrew | Noto Sans Hebrew | `segoeui.ttf` (Segoe UI) |
| `symbols` / `zapf-dingbats` | Apple Symbols / Zapf Dingbats | Noto Sans Symbols 2 | `seguisym.ttf` (Segoe UI Symbol) |
| `stix-math` | STIX Two Math | STIX Two Math | `cambria.ttc` (Cambria Math) |
| `lucida-grande` | Lucida Grande | DejaVu Sans | `arial.ttf` |
| `snell` / `apple-chancery` (= `cursive`) | Snell / Apple Chancery | URW Chancery L | `comic.ttf` (Comic Sans MS) |
| `papyrus` (= `fantasy`) | Papyrus | (fontconfig `fantasy`) | `impact.ttf` (Impact) |
| `source-serif-pro` | `/Library/Fonts/...` (if installed) | — (unmapped → chain falls through) | — (unmapped → chain falls through) |

Keys with no per-platform entry resolve to `null`, which makes the family chain
walk to the next candidate — identical to the macOS "font not installed"
behavior. The macOS-only CoreText `extractor` flag is never set on the Linux /
Windows tables; those faces open through fontkit like any other file.

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

- DM-259 — calibrate the Linux fallback chain against Chromium-on-Linux painted widths.
- DM-260 — calibrate the Windows fallback chain against Chromium-on-Windows painted widths.
- DM-261 — bundle a small OFL fallback set for headless CI environments missing system fonts.
- DM-262 — wire Linux + Windows visual baselines into CI.

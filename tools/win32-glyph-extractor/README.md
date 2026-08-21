# Windows glyph-extractor (DM-837 / DM-390)

C++17 CLI that extracts SVG glyph outlines and font metadata from any
Windows-installed font using **DirectWrite**. The Domotion render pipeline
consults this helper as a probe-then-fallback path when fontkit can't read a
font's outline tables (e.g. Cambria Math's OpenType-`CFF`/`MATH`, large CJK
`.ttc` collections). It is the Windows analogue of the macOS CoreText helper
(`tools/macos-glyph-extractor`) and the Linux FreeType helper
(`tools/linux-glyph-extractor`).

Because Chromium-on-Windows rasterizes through DirectWrite, a helper that reads
the same files through DirectWrite produces byte-faithful outlines. Its optional
per-glyph `rasterRepresentation` field also reports when Chromium's pinned Skia
would choose COLR, SVG, or PNG paint before requesting that outline.

See [`docs/41-windows-glyph-extraction.md`](../../docs/41-windows-glyph-extraction.md)
for the full design and [`docs/16-coretext-glyph-extraction.md`](../../docs/16-coretext-glyph-extraction.md)
for the shared cross-platform contract.

The helper is built and exercised on real Windows by the `windows-latest`
visual-test jobs; `release-helpers.yml` builds and uploads the release asset.
The macOS development host cannot compile it locally, so the Windows-gated
native API tests remain the build-and-runtime authority.

## Build

```powershell
pwsh tools/win32-glyph-extractor/build.ps1   # → tools/win32-glyph-extractor/domotion-glyph-paths.exe
```

Requires CMake + the Visual Studio Build Tools (MSVC v143) with the Windows SDK
— both preinstalled on GitHub `windows-latest` runners. DirectWrite (`dwrite.lib`)
and the Direct2D headers ship with the Windows SDK. The CRT is statically linked
(`/MT`), so the `.exe` runs on a clean Windows with no VC++ redistributable.

The binary is **not committed to git** — it is published as a GitHub release
asset (`domotion-glyph-paths-win32-x64.exe`) and downloaded on demand by the
Domotion runtime.

## IPC protocol

Reads a single JSON request from stdin (or `--input <path>.json`) and writes a
JSON response to stdout — the exact envelope the macOS/Linux helpers use
([`docs/16`](../../docs/16-coretext-glyph-extraction.md) §IPC protocol).

Outlines are emitted in **font design units, y-up** (DirectWrite's `emSize` is
set to the font's `designUnitsPerEm`, and the Direct2D y-down geometry is negated
to y-up) — identical to fontkit's `glyph.path.commands`, so the renderer's
`scale(fontSize/unitsPerEm, …)` transform consumes helper and fontkit output
interchangeably. DirectWrite elevates TrueType quadratics to cubics, so all
curves are emitted as `C`.

For each `glyphs` result, the helper may also emit
`"rasterRepresentation":"colr"|"svg"|"bitmap"`. The value is decided for the
exact returned gid using pinned Skia's DirectWrite order: translated COLR run,
then SVG/PNG image formats (plus COLRv1 paint-tree support where the SDK/backend
enables it). It is deliberately independent of `d`: Segoe UI Emoji can expose a
monochrome base outline for a gid whose Chromium paint owner is COLR. Ordinary
outline glyphs in that same face omit the field.

Quick smoke test (on Windows):

```powershell
'{"fonts":[{"ref":"f","fontPath":"C:\\Windows\\Fonts\\arial.ttf","size":2048}],"queries":[{"type":"glyphs","fontRef":"f","glyphs":[{"cp":72}]}]}' `
  | .\domotion-glyph-paths.exe
```

### `fallback` query — live system fallback (DM-1403)

`{"queries":[{"type":"fallback","cps":[19968,2309]}]}` resolves each codepoint to
the substitute font DirectWrite would pick (`IDWriteFontFallback::MapCharacters`),
returning `{"type":"fallback","fonts":[{"cp",found,postscriptName,familyName,path}]}`
— the same shape the macOS CoreText helper's `fallback` query returns, so the
renderer's `resolveSystemFallbackFonts` consumes both. The result is accepted only
when `HasCharacter(cp)` is true (non-covering → `found:false`). This backs the
win32 arm of `resolveSystemFallbackKeyForCp` (opt-in behind
`DOMOTION_SYSTEM_FALLBACK`).

Optional fields carry the rest of what Chrome passes `MapCharacters`. Each one
defaults to the value the query used before it existed, so an older caller
degrades to the previous behavior rather than mismatching:

| field | `MapCharacters` argument | default when absent |
| --- | --- | --- |
| `cssWeight` / `italic` / `cssSlant` / `cssStretch` | the style triple | `NORMAL` / `NORMAL` / `NORMAL` |
| `baseFamilyName` | the run's primary family | `nullptr` (pure system fallback) |
| `locale` | the analysis source's locale name | `en-us` |
| `diagnostics` | response-only raw mapped weight/stretch/style/simulation tuple | omitted |

`diagnostics:true` does not change selection. It adds the raw `IDWriteFont`
style tuple needed to compare `MapCharacters` with Blink's subsequent
`UpdateFromSkiaFontStyle` family reopen. Run
`node tools/win32-fallback-probe.mjs` for the bounded U+2100/U+2E00 and
U+A700/U+1DF00 discriminator set.

`locale` is a BCP-47 tag and is the whole Han-unification signal — the caller
derives it the way Blink does (`blinkWinFallbackLocale` on the Node side) rather
than passing a raw CSS `lang`, because DirectWrite discriminates on the script or
region subtag and a bare `zh` resolves to a Japanese face.

```powershell
'{"queries":[{"type":"fallback","cps":[19968,128512,4096]}]}' | .\domotion-glyph-paths.exe
# → Yu Gothic UI (U+4E00), Segoe UI Emoji (U+1F600), Myanmar Text (U+1000)

'{"queries":[{"type":"fallback","cps":[28450],"locale":"zh-Hans"}]}' | .\domotion-glyph-paths.exe
# → Microsoft YaHei UI   (the same query at "zh-Hant" → Microsoft JhengHei UI,
#                         at "ja" → Yu Gothic UI, at "ko" → Malgun Gothic)
```

### Persistent `--serve` mode (DM-1035)

`--serve` switches to a persistent loop: one request envelope **per line** on
stdin, one response **per line** on stdout, looping until EOF, reusing opened
`IDWriteFontFace`s across requests so repeated calls skip the
`DWriteCreateFactory` + `CreateFontFace` cost. This is the path the renderer
(`src/render/glyph-helper.ts`) uses on Windows; the one-shot mode above is the
transparent fallback. stdin/stdout run in binary mode so each serve response is
byte-identical to the one-shot response for the same envelope.

```powershell
@(
  '{"fonts":[{"ref":"f","fontPath":"C:\\Windows\\Fonts\\arial.ttf","size":2048}],"queries":[{"type":"glyphs","fontRef":"f","glyphs":[{"cp":72}]}]}'
  '{"fonts":[{"ref":"f","fontPath":"C:\\Windows\\Fonts\\arial.ttf","size":2048}],"queries":[{"type":"glyphs","fontRef":"f","glyphs":[{"cp":101}]}]}'
) | .\domotion-glyph-paths.exe --serve
```

## Tests

`tests/win32-glyph-extractor.test.ts` (vitest) asserts the helper's outlines
match fontkit command-for-command on Arial `H` (line mapping + the y-flip) and a
Cambria Math glyph. It also requires Segoe UI Emoji U+1F600 to report COLR by
codepoint and by selected gid despite its base outline, with ordinary `#` in the
same face as the negative control. The suite skips unless
`process.platform === "win32"` and the binary is built, so it is inert on
macOS/Linux.

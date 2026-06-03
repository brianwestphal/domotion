# Windows glyph-extractor (DM-837 / DM-390)

C++17 CLI that extracts SVG glyph outlines and font metadata from any
Windows-installed font using **DirectWrite**. The Domotion render pipeline
consults this helper as a probe-then-fallback path when fontkit can't read a
font's outline tables (e.g. Cambria Math's OpenType-`CFF`/`MATH`, large CJK
`.ttc` collections). It is the Windows analogue of the macOS CoreText helper
(`tools/macos-glyph-extractor`) and the Linux FreeType helper
(`tools/linux-glyph-extractor`).

Because Chromium-on-Windows rasterizes through DirectWrite, a helper that reads
the same files through DirectWrite produces byte-faithful outlines.

See [`docs/41-windows-glyph-extraction.md`](../../docs/41-windows-glyph-extraction.md)
for the full design and [`docs/16-coretext-glyph-extraction.md`](../../docs/16-coretext-glyph-extraction.md)
for the shared cross-platform contract.

> **Build status:** this helper is written but, unlike the macOS/Linux ones, it
> has **not yet been compiled or run on real Windows** from this repo — there is
> no local Windows/MSVC environment here (and Docker can't host Windows on the
> Mac dev box). It is validated by CI on a `windows-latest` runner: the
> `glyph-extractor-build` job in `.github/workflows/windows-fidelity.yml`
> (manual dispatch) compiles it and runs the parity test, and the
> `windows-glyph-extractor` job in `release-helpers.yml` builds + uploads the
> release asset. Expect to iterate on the first green run — the most likely
> things to need a tweak are the **y-flip sign** (pinned by the `H` parity test)
> and `.ttc` face-index resolution.

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

Quick smoke test (on Windows):

```powershell
'{"fonts":[{"ref":"f","fontPath":"C:\\Windows\\Fonts\\arial.ttf","size":2048}],"queries":[{"type":"glyphs","fontRef":"f","glyphs":[{"cp":72}]}]}' `
  | .\domotion-glyph-paths.exe
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
Cambria Math glyph. The suite skips unless `process.platform === "win32"` and
the binary is built, so it is inert on macOS/Linux.

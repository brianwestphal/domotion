# Domotion: Windows native glyph-outline extraction (DirectWrite)

Requirements for the **Windows** native glyph-outline extractor — the
DirectWrite analogue of the macOS CoreText helper. Origin: DM-390.

> **Parent contract**: `docs/16-coretext-glyph-extraction.md` defines the
> cross-platform extractor strategy — the probe-then-fallback trigger, the JSON
> IPC envelope, the release-asset distribution + on-demand download, and the
> `text-to-path.ts` integration. **All of that is shared and is NOT restated
> here.** This doc covers only what is Windows/DirectWrite-specific: the C++
> source, the DirectWrite call pipeline, coordinate handling, the build
> toolchain, and Windows code-signing. Read doc 16 first.

## Why a native extractor on Windows

Same rationale as macOS (doc 16 §"Why now"), one platform over: fontkit can't
parse every outline table Chromium-on-Windows paints from. The concrete
Windows forcing functions:

- **Cambria Math** and other OpenType-`CFF`/`MATH` faces where fontkit's
  outline walk is incomplete or where Chromium's DirectWrite rasterization
  diverges from fontkit's.
- **Segoe UI Symbol / Segoe UI Emoji** monochrome layers.
- **Yu Gothic / Microsoft YaHei / Malgun Gothic** CJK faces — large `.ttc`
  collections where matching Chromium's exact painted outline matters for the
  fidelity diff.
- Any future Microsoft face using a table layout fontkit doesn't fully read.

Same engine (DirectWrite) reading the same files Chromium reads ⇒ byte-faithful
outlines, zero bundled-font weight.

## Reuse from doc 16 (unchanged on Windows)

- **IPC envelope** — identical JSON request/response (`fonts[]` declared once
  with a `ref`, `queries[]` of `meta` / `glyphs`, response `d` as an SVG
  path-data string in CSS-pixel space with SVG y-down). The `text-to-path.ts`
  dispatch layer is engine-agnostic; only the asset filename differs.
- **Probe-then-fallback** — fontkit first; the helper is invoked only when
  fontkit yields a null/empty path. Same `(fontFile, glyphId)` in-memory
  resolution cache.
- **Trigger guards** — `process.platform === 'win32'`, helper present in the
  user cache (or downloads on first need), `DOMOTION_DISABLE_HELPER` unset.
- **Distribution** — published as a GitHub release asset
  `domotion-glyph-paths-win32-x64.exe` (and `-arm64` — see open questions),
  downloaded on demand into the user-cache dir
  (`%LOCALAPPDATA%\domotion\<version>\bin\`), reused thereafter. **This
  supersedes the DM-390 ticket line "Pre-built binary committed at
  `vendor/bin/win32/...`"** — doc 16's resolved design decision (2026-05-01) is
  release-asset, not committed-to-git, to keep the npm tarball and git history
  thin. The Windows helper follows that decision.

## Windows implementation: C++ CLI helper

### Helper binary

- **Name**: `domotion-glyph-paths.exe`.
- **Source location**: `tools/win32-glyph-extractor/` (a small CMake or MSBuild
  C++ project). Not committed as a binary.
- **Language/toolchain**: C++17, MSVC (`cl.exe` from the Visual Studio Build
  Tools / Windows SDK) on a `windows-latest` GitHub runner. DirectWrite headers
  (`dwrite.h`, `dwrite_3.h`) and `dwrite.lib` ship with the Windows SDK already
  present on the runner; link `dwrite.lib`, `d2d1.lib` (for the path geometry
  sink helper), and `windowscodecs.lib` if needed.
- **Output**: a single self-contained `.exe`; statically link the CRT
  (`/MT`) so the binary runs on a clean Windows without a VC++ redistributable.

### DirectWrite pipeline

Mirrors doc 16 §"Internal pipeline" with DirectWrite calls:

1. **Factory + font resolution.** `DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, …, &factory)`.
   - When the request gives a `fontPath`: load the file with
     `factory->CreateFontFileReference(path, …)` →
     `factory->CreateFontFaceFromFontFile`-style flow (build an
     `IDWriteFontFace` directly from the file + face index). For `.ttc`
     collections, the face index is derived from the requested `postscriptName`
     by enumerating the collection's faces and matching the informational
     string (`IDWriteFontFace3::GetInformationalStrings(POSTSCRIPT_NAME)`), or
     by using `IDWriteFontSetBuilder` / `IDWriteFontCollection1` lookup.
   - When only a family name is given: `factory->GetSystemFontCollection(&coll)`
     → `coll->FindFamilyName` → pick the face whose weight/style matches the
     request → `IDWriteFont::CreateFontFace`.
2. **Variations.** Apply `wght` / `opsz` / `slnt` via
   `IDWriteFontResource::CreateFontFace` with `DWRITE_FONT_AXIS_VALUE[]`
   (DirectWrite 3) when the face exposes the axes; ignore otherwise (parity
   with the CoreText helper, which no-ops when an axis is absent).
3. **Glyph id resolution.** `fontFace->GetGlyphIndices(codepoints, count, glyphIndices)`.
   A returned index of `0` is `.notdef` → emit an empty path (parity with the
   CoreText "missing glyph → empty `d`" rule).
4. **Outline extraction.** `fontFace->GetGlyphRunOutline(emSize, glyphIndices,
   nullptr /*advances*/, nullptr /*offsets*/, count, isSideways=FALSE,
   isRtl=FALSE, geometrySink)` where `emSize` is the requested CSS-pixel size.
   The custom sink (below) records the path commands.
5. **Advances + bbox.** `fontFace->GetDesignGlyphMetrics(glyphIndices, count,
   metrics)` → scale `advanceWidth` by `emSize / unitsPerEm`. Derive bbox from
   the sink's accumulated min/max, or from `GetDesignGlyphMetrics`'
   `leftSideBearing` / `topSideBearing` / `advanceHeight` scaled to px.
6. **Meta query.** `IDWriteFontMetrics` (via
   `fontFace->GetMetrics(&m)`): `m.designUnitsPerEm`, `m.ascent`, `m.descent`,
   `m.underlinePosition` / `m.underlineThickness`,
   `m.strikethroughPosition` / `m.strikethroughThickness`. These map directly
   onto doc 16's `meta` response fields (note: DirectWrite already exposes
   underline/strikeout in the metrics struct, so unlike the CoreText helper we
   don't need to crack the raw `post` / `OS/2` tables). **Sign note (as built):**
   DirectWrite's `descent` is a positive magnitude below the baseline; fontkit
   and the other helpers report descent as negative, so the helper emits
   `-m.descent`.

### The geometry sink

`IDWriteGeometrySink` is `ID2D1SimplifiedGeometrySink`. Implement a minimal
sink class that translates the callbacks into SVG path-data:

| Sink callback | SVG emitted |
| --- | --- |
| `BeginFigure(startPoint, …)` | `M {x} {y}` |
| `AddLines(points[], n)` | `L {x} {y}` per point |
| `AddBeziers(beziers[], n)` | `C {c1x} {c1y} {c2x} {c2y} {x} {y}` per segment |
| `EndFigure(FIGURE_END_CLOSED)` | `Z` |
| `SetFillMode` / `SetSegmentFlags` | (record fill mode; outlines use nonzero) |

DirectWrite emits **cubic** Béziers only (no quadratics) via `AddBeziers` —
TrueType quadratics are already elevated to cubics by `GetGlyphRunOutline`. So
unlike the CoreText helper (which sees quads and emits `Q`), the Windows helper
emits `C` for all curves. This is fine: the downstream SVG `<path>` consumer
handles both, and the dedup cache keys on the emitted string.

### Coordinate system *(as built — DM-837)*

The renderer consumes outlines in **fontkit's convention: design units, y-up**
(it applies `scale(fontSize/unitsPerEm, -…)` to flip to SVG y-down at draw time).
The macOS and Linux helpers emit that directly because CoreText and FreeType are
natively y-up. **DirectWrite is the exception:** `GetGlyphRunOutline` emits
Direct2D screen-space geometry, which is y-**down**. So this helper **negates y**
on every emitted coordinate to reach the y-up convention — the *opposite* of
"the same flip CoreText applies" (CoreText does no flip). The sign is pinned by
the `H` parity test (`tests/win32-glyph-extractor.test.ts`), which asserts the
cap-height bbox lands above the baseline and matches fontkit; treat the negation
as validated-by-test.

For scale: `emSize` is set to the font's `designUnitsPerEm` (read from
`GetMetrics`), so `GetGlyphRunOutline` emits coordinates in **design units**
(scale = emSize/unitsPerEm = 1), matching fontkit. Advances from
`GetDesignGlyphMetrics` are likewise design units. (The `size` field in the
request is accepted for envelope compatibility but does not rescale the outline.)

Emit all numbers at fixed 3-decimal precision for deterministic, dedup-friendly
output (parity with the other helpers).

### Build script

- `tools/win32-glyph-extractor/build.ps1` (PowerShell) and/or a `CMakeLists.txt`
  that the release workflow invokes on `windows-latest`. Documents the SDK
  version and the `cl.exe` flags (`/std:c++17 /O2 /MT /EHsc`, link
  `dwrite.lib d2d1.lib`).
- A `README.md` in the helper dir documenting how a contributor rebuilds it
  locally (Visual Studio Build Tools + Windows SDK).

## Code signing

The macOS helper is signed with the project's Apple Developer ID + notarized in
CI (DM-391). The Windows analogue needs **Authenticode** signing
(`signtool sign /fd SHA256 …`) to avoid SmartScreen "unknown publisher" friction.
This requires a Windows code-signing certificate (OV or EV) which the project
**may not currently hold** — see open questions. If unavailable initially, ship
the helper unsigned (functional; downloaded by Domotion itself rather than
double-clicked by a user, so SmartScreen impact is limited) and add signing when
a cert is provisioned.

## Validation

- **Helvetica/Arial `H` outline parity**: extract `H` via fontkit and via the
  helper; assert the path commands match within a numeric tolerance — confirms
  the y-flip and the quad→cubic curve mapping. Add to
  `tests/win32-glyph-extractor.test.ts` (runs only on `process.platform === 'win32'`).
- **Cambria Math glyph**: extract a Math-Alpha glyph (e.g. U+1D400 𝐀) and
  confirm a non-empty path where fontkit returned empty.
- **CI**: a `windows-latest` job (extend the existing `windows-fidelity.yml`)
  builds the helper from a clean checkout (validates `build.ps1`) and runs
  `npm run demos:test:html` once the Windows fallback chain (DM-260) is
  calibrated, exercising Segoe UI Symbol / Cambria Math / Yu Gothic through the
  native route.

## Open questions (for follow-up / user input)

1. **Windows code-signing certificate** — does the project have (or want to
   acquire) an Authenticode cert? Determines whether the win32 asset is signed
   in CI or shipped unsigned initially.
2. **arm64** — ship `domotion-glyph-paths-win32-arm64.exe` alongside x64, or x64
   only until there's demand? (GitHub's `windows-latest` is x64; arm64 needs a
   cross-compile or an arm64 runner.)
3. **`.ttc` face-index resolution** — confirm the postscriptName→face-index
   lookup works for the system `.ttc` collections (YaHei `msyh.ttc`, Yu Gothic
   `YuGothR.ttc`) via `IDWriteFontFace3::GetInformationalStrings`, vs. needing
   `IDWriteFontSetBuilder`.

## Out of scope

- GPOS / shaping — fontkit-owned (parity with doc 16).
- The Linux Pango/Cairo extractor — DM-389.
- Windows fallback-chain calibration (which key paints which block) — DM-260.
- Color-emoji vector layers (Segoe UI Emoji COLR layers) — separate ticket.

## Status

- ✅ **Helper written + CI wired** (DM-837): `tools/win32-glyph-extractor/`
  (`src/main.cpp` + `CMakeLists.txt` + `build.ps1` + `README.md`; the JSON
  parser/serializer is shared verbatim with the Linux helper). The release asset
  job (`windows-glyph-extractor` in `release-helpers.yml`, alongside macOS +
  Linux) builds + uploads `domotion-glyph-paths-win32-x64.exe`. A
  release-independent validation job (`glyph-extractor-build` in
  `windows-fidelity.yml`, manual dispatch) compiles it and runs the
  `tests/win32-glyph-extractor.test.ts` fontkit-parity test on the real Windows
  font stack.
- ⚠️ **Not yet compiled/run on real Windows.** Unlike the macOS (local Swift) and
  Linux (Docker) helpers, there is no Windows/MSVC environment on the dev box and
  Docker can't host Windows there — so this is validated only by the
  `windows-latest` CI jobs above. Expect to iterate on the first green run; the
  highest-risk spots are the **y-flip sign** (the bbox parity assertion catches a
  wrong negation), `.ttc` face-index resolution via
  `GetInformationalStrings(POSTSCRIPT_NAME)`, and the DirectWrite-3 variation path.
- ⏳ **Remaining:** Windows Authenticode signing in CI (pending a cert — open
  question 1); arm64 asset (open question 2); the JS-side dispatch that actually
  *invokes* the helper (`src/render/glyph-helper.ts` is still macOS-gated — the same
  generalization tracked for Linux in DM-881 extends to win32).

# Domotion: Linux native glyph-outline extraction (FreeType)

Requirements for the **Linux** native glyph-outline extractor — the analogue of
the macOS CoreText helper (doc 16) and the Windows DirectWrite helper (doc 41).
Origin: DM-389.

> **Parent contract**: `docs/16-coretext-glyph-extraction.md` defines the
> cross-platform extractor strategy — the probe-then-fallback trigger, the JSON
> IPC envelope, the release-asset distribution + on-demand download, and the
> `text-to-path.ts` integration. **All of that is shared and is NOT restated
> here.** This doc covers only what is Linux-specific: the engine choice, the
> outline-walk pipeline, coordinate handling, the build toolchain + portability,
> and distribution. Read doc 16 first; `docs/41` is the close Windows analogue.

## Why a native extractor on Linux

Same rationale as macOS/Windows (doc 16 §"Why now"): fontkit can't extract
every outline Chromium-on-Linux paints from. The concrete Linux forcing
functions found during fallback calibration (DM-259, `docs/42`):

- **GNU FreeFont (FreeSans / FreeSerif / FreeMono)** — the Linux Math-Alpha and
  symbol fallback. The MathML fixtures `mathml-mi-italic-letters` /
  `mathml-mi-greek-italic` render their letters through **upright `FreeSans.ttf`,
  which carries the full Mathematical Alphanumeric block** (U+1D400–1D7FF; e.g.
  𝑎 → gid 6385), and CDP `CSS.getPlatformFontsForNode` confirms Chromium paints
  them with FreeSans too. fontkit's `glyphForCodePoint` returns those real gids
  for the upright face, so a FreeType walk extracts them fine — the extractor is
  **not** needed for Math-Alpha. (Correction, DM-876: an earlier DM-838 probe
  reported FreeSans lacking U+1D4xx, but it had opened the **`FreeSansOblique`**
  face — only the oblique face lacks the block; the upright `.ttf` has all of it.
  DM-838's `mathAlphaToBase` decomposition is therefore a guarded fallback that
  does not engage on this image.) The CJK / other fallback faces below — where
  fontkit's outline walk genuinely diverges — remain
  the extractor's real motivation.
- **Noto CJK / Noto Sans** and other large faces where fontkit's outline walk
  diverges from what Chromium's FreeType-backed rasterizer produces.

Chromium on Linux rasterizes glyph outlines through **FreeType** (via Skia),
with **fontconfig** only for family→file matching. So a helper that reads the
same files through FreeType produces byte-faithful outlines — the same
"same engine reading the same files" guarantee CoreText/DirectWrite give on
macOS/Windows.

## Engine choice: FreeType directly, not Pango/Cairo

The DM-389 ticket sketched a Pango + Cairo + FreeType pipeline
(`FcFontMatch` → `pango_font_map_load_font` → `cairo_glyph_path`). **This doc
narrows that to FreeType alone for the outline walk**, with fontconfig only when
a family name (not a file path) must be resolved:

- We already have the **glyph's font file + size + glyph id / codepoint** from
  the capture side and doc 16's envelope — we do *not* need text layout, line
  breaking, or shaping (that's fontkit/HarfBuzz's job upstream). Pango and Cairo
  exist to do layout + rasterization; we only need outline decomposition.
- Cairo's `cairo_glyph_path` itself decomposes via FreeType internally. Calling
  FreeType's `FT_Outline_Decompose` directly skips two heavy static
  dependencies (Cairo, Pango, GLib) with no fidelity loss, and produces a much
  smaller, more portable static binary.
- FreeType is the layer Chromium-on-Linux actually uses for outlines, so this is
  the most faithful match.

Pango/Cairo remain a valid fallback if a face ever needs Cairo-only handling,
but the lean FreeType path is the design baseline.

## Reuse from doc 16 (unchanged on Linux)

- **IPC envelope** — identical JSON request/response (`fonts[]` with a `ref`,
  `queries[]` of `meta` / `glyphs`, response `d` as an SVG path-data string in
  CSS-pixel space, SVG y-down). The `text-to-path.ts` dispatch layer is
  engine-agnostic; only the asset filename differs.
- **Probe-then-fallback** — fontkit first; the helper is invoked only when
  fontkit yields a null/empty path for a codepoint the font *does* contain (a
  CJK / CFF outline fontkit's walk can't reproduce — not the DM-838 case, where
  the font lacks the glyph entirely). Same `(fontFile, glyphId)` resolution cache.
- **Trigger guards** — `process.platform === 'linux'`, helper present in the
  user cache (or downloads on first need), `DOMOTION_DISABLE_HELPER` unset.
- **Distribution** — published as a GitHub release asset (see below), downloaded
  on demand into the user-cache dir, reused thereafter. Not committed to git —
  this supersedes the DM-389 ticket line "Pre-built static binary committed at
  `vendor/bin/linux/...`", following doc 16's resolved decision (release asset,
  not in-tree) to keep the npm tarball + git history thin.

## Linux implementation: C/C++ CLI helper

### Helper binary

- **Name**: `domotion-glyph-paths` (no extension).
- **Source location**: `tools/linux-glyph-extractor/` (a small CMake C/C++
  project). Not committed as a binary.
- **Language/toolchain**: C++17, `gcc`/`clang`. Link FreeType (`libfreetype`)
  and, when family-name resolution is needed, fontconfig (`libfontconfig`).
- **Output**: a single self-contained binary. See "Portability" — FreeType
  (and optionally fontconfig) statically linked, built against an old glibc so
  the asset runs across distros.

### FreeType pipeline

Mirrors doc 16 §"Internal pipeline" with FreeType calls:

1. **Library + face resolution.** `FT_Init_FreeType(&lib)`.
   - When the request gives a `fontPath`: `FT_New_Face(lib, path, faceIndex, &face)`.
     For `.ttc` collections the `faceIndex` is derived from the requested
     `postscriptName` by enumerating faces (`FT_Get_Postscript_Name` over the
     `num_faces` reported when opening with `faceIndex = -1`).
   - When only a family name is given: resolve to a file via fontconfig
     (`FcFontMatch` on a pattern of family + weight + slant), then `FT_New_Face`
     on the matched file. (Most requests carry a `fontPath` already, so this
     branch is rare.)
2. **Size.** *(As built — DM-872)* The outline is loaded with `FT_LOAD_NO_SCALE`
   (step 5), which returns coordinates in raw **font design units** regardless
   of size, so no `FT_Set_Pixel_Sizes` call is needed. This is exactly fontkit's
   convention (its `glyph.path.commands` are unscaled design units); the renderer
   applies `scale(fontSize/unitsPerEm, …)` downstream. The `size` field in the
   request is accepted for envelope compatibility but does not affect the
   outline. (The macOS helper instead opens at `size = unitsPerEm` to approximate
   design units; `NO_SCALE` gives them exactly, with no 26.6 rounding.)
3. **Variations.** Apply `wght` / `opsz` / `slnt` via
   `FT_Set_Var_Design_Coordinates` when the face is an MM/variable font
   (`FT_Get_MM_Var`); no-op otherwise (parity with the CoreText/DirectWrite
   helpers).
4. **Glyph id resolution.** `FT_Get_Char_Index(face, codepoint)` (cmap lookup).
   Index `0` is `.notdef` → emit an empty path (parity with the "missing glyph →
   empty `d`" rule). (Note, corrected DM-876: upright `FreeSans.ttf` DOES carry
   the Math-Alpha block, so `FT_Get_Char_Index(0x1D44E)` returns a real gid there
   — the extractor would handle Math-Alpha fine. The DM-838 "FreeSans lacks
   U+1D4xx" claim came from probing the `FreeSansOblique` face by mistake.)
5. **Outline load + decompose.** `FT_Load_Glyph(face, glyphIndex,
   FT_LOAD_NO_SCALE | FT_LOAD_NO_BITMAP | FT_LOAD_NO_HINTING)` →
   `FT_Outline_Decompose(&face->glyph->outline, &funcs, &ctx)` with an
   `FT_Outline_Funcs` whose callbacks emit SVG path-data (below). `NO_SCALE`
   makes the outline points exact design-unit integers (no 26.6 conversion).
6. **Advances + bbox.** With `NO_SCALE`, `face->glyph->advance.x` is already in
   design units (no `>> 6`). bbox from `FT_Outline_Get_CBox` (control box, design
   units) — note this is unused by the current renderer, which reads only id /
   advance / path.
7. **Meta query.** `face->units_per_EM`, `face->ascender`, `face->descender`,
   `face->underline_position` / `face->underline_thickness`. Strikeout from the
   `OS/2` table via `FT_Get_Sfnt_Table(face, FT_SFNT_OS2)` →
   `os2->yStrikeoutPosition` / `os2->yStrikeoutSize`. These map onto doc 16's
   `meta` response fields.

### The outline decomposer

`FT_Outline_Decompose` takes an `FT_Outline_Funcs` with four callbacks:

| FreeType callback | SVG emitted |
| --- | --- |
| `move_to(to)` | `M {x} {y}` |
| `line_to(to)` | `L {x} {y}` |
| `conic_to(ctrl, to)` | `Q {cx} {cy} {x} {y}` (TrueType quadratics) |
| `cubic_to(c1, c2, to)` | `C {c1x} {c1y} {c2x} {c2y} {x} {y}` (CFF cubics) |
| (end of each contour) | `Z` |

Unlike DirectWrite (which elevates everything to cubics), FreeType preserves the
native curve kind — `conic_to` for TrueType quads, `cubic_to` for CFF. Emit `Q`
and `C` respectively (the downstream SVG `<path>` consumer + dedup cache handle
both, same as the CoreText helper which also emits `Q`). Under `FT_LOAD_NO_SCALE`
the coordinates are exact design-unit integers — no 26.6 conversion.

FreeType traces the explicit closing edge back to the contour start as the final
segment; SVG `Z` already closes a subpath with a straight line to the start, so
that trailing `L <start>` is redundant. fontkit and the CoreText helper both
omit it, so the Linux helper drops it too (buffer the contour, pop a trailing
line-to-start, then emit `Z`) — keeping the emitted path command-for-command
identical to fontkit's `glyph.path.commands`.

### Coordinate system

**Emit y-UP, do NOT negate.** *(Corrected — DM-872.)* FreeType outline y points
up (font convention); fontkit's `glyph.path.commands` are also y-up; the
renderer flips to SVG y-down at draw time via its `scale(sc, -sc)` transform. So
the helper must emit FreeType's native y-up coordinates verbatim — negating
would double-flip and fail the `H` parity test. (This supersedes an earlier
draft of this section that said "negate y"; that section itself flagged that the
flip direction "must be validated by the `H` parity test, not assumed" — and the
test, now in `tests/linux-glyph-extractor.test.ts`, confirms y-up by asserting
the cap-height bbox is positive and matches fontkit. The macOS CoreText helper
emits y-up for the same reason.)

The only intentional divergence from fontkit: the implied on-curve midpoint
TrueType inserts between two consecutive off-curve points is computed by
`FT_Outline_Decompose` with integer division (truncating the `.5`), while
fontkit uses an exact float midpoint — so a single coordinate may differ by ≤ 0.5
design units (~0.004 px at 16 px). Since Chromium also rasterizes through
FreeType, the truncated value is the Chromium-faithful one. The parity test's
coordinate tolerance reflects this floor.

Emit all numbers at fixed 3-decimal precision for deterministic, dedup-friendly
output (parity with the other helpers; with `NO_SCALE` they are almost always
integers).

### Build script & portability *(as built — DM-872)*

- `tools/linux-glyph-extractor/CMakeLists.txt` + `build.sh` (CMake + pkg-config
  for FreeType), plus a `Dockerfile` that reproduces the release build on
  `ubuntu:22.04`, and a `README.md`.
- **FreeType is linked dynamically, not statically** (resolving open question 1
  below): the helper only ever runs in an environment that also runs Domotion's
  Playwright Chromium, and Chromium-on-Linux requires system FreeType
  (`libfreetype6` ships via `npx playwright install-deps`). So `libfreetype.so.6`
  is guaranteed present, its SONAME is ABI-stable, and a static build would need
  `libfreetype.a` (not shipped by mainstream distros) for no real gain. glibc
  stays dynamic; the `ubuntu:22.04` build floor (glibc 2.35) covers all
  currently supported distros and matches the release runner.

## Distribution

Per doc 16: release asset `domotion-glyph-paths-linux-x64`, built on an
`ubuntu-22.04` GitHub runner (a `linux-glyph-extractor` job in
`.github/workflows/release-helpers.yml`, alongside the macOS job), uploaded with
a SHA-256 sidecar, downloaded on demand into the Linux user-cache dir
(`$XDG_DATA_HOME/domotion/<version>/bin/`, default `~/.local/share/...`), `chmod +x`,
reused thereafter. Extends DM-393's engine-agnostic acquisition logic. (arm64 is
not yet built — see open questions.)

## Validation

- **Liberation Sans `H` outline parity** *(implemented)*: extract `H` via
  fontkit and via the helper; assert the command sequence matches and
  coordinates match within tolerance — confirms y-up and the line mapping. In
  `tests/linux-glyph-extractor.test.ts` (runs only on `process.platform === 'linux'`
  with the binary built; skips otherwise). Validated via `npm run
  test:linux-docker`. (DejaVu Sans is not in the Playwright Linux image, so
  Liberation Sans is the canonical line-parity oracle.)
- **FreeSans Math-Alpha parity** *(implemented)*: extract U+1D44E 𝑎 from upright
  `FreeSans.ttf` via the helper and via fontkit and assert the outlines match —
  the upright face carries the Math-Alpha block (gid 6385 for 𝑎), so both return
  a real glyph (corrected DM-876; the earlier "empty path" claim was the
  `FreeSansOblique` face, which lacks the block). This is positive coverage, not
  an empty-regression guard.
- **CI**: a Linux job (the `test-linux.yml` from DM-262, or the Docker harness
  `npm run test:linux-docker`) builds the helper from a clean checkout and runs
  `npm run demos:test:html`, exercising the FreeSans / Noto fallback ranges
  through the native route once the Linux fallback chain (DM-259) is calibrated.

## Open questions

1. **glibc floor / static strategy** — *RESOLVED (DM-872): dynamic FreeType,
   glibc floor = `ubuntu:22.04` (2.35).* No static/musl build — `libfreetype.so.6`
   is guaranteed present alongside Chromium (see Build § / CMakeLists rationale),
   so a static link buys nothing. Revisit only if a need arises to run the helper
   on a glibc older than 2.35 or without Chromium present.
2. **fontconfig dependency** — *RESOLVED (DM-872): dropped.* The helper requires
   a concrete `fontPath` and does not link fontconfig — the capture side already
   resolves families to files via the platform font-path map (DM-258). A
   family-name-only request fails loudly rather than guessing.
3. **arm64** — still open. The release builds `linux-x64` only (GitHub
   `ubuntu-*` runners are x64). `domotion-glyph-paths-linux-arm64` can be added
   when there's demand (the source is arch-agnostic; it builds + passes parity on
   arm64, verified locally on Apple-Silicon Docker).

## Out of scope

- GPOS / shaping — fontkit-owned (parity with doc 16).
- The Windows DirectWrite extractor — DM-390 / DM-837 (`docs/41`).
- Linux fallback-chain calibration (which key paints which block) — DM-259.
- Color-emoji vector layers (Noto Color Emoji `CBDT`/`COLR`) — separate ticket.

## Status

- ✅ **Helper implemented + built + tested** (DM-872): `tools/linux-glyph-extractor/`
  (`src/main.cpp` + `CMakeLists.txt` + `build.sh` + `Dockerfile` + `README.md`),
  parity tests in `tests/linux-glyph-extractor.test.ts`, and the
  `linux-glyph-extractor` release job in `release-helpers.yml`. Built and
  validated in the Playwright Linux container (Liberation `H` + FreeSans 𝑎 parity
  with fontkit, byte-faithful).
- ✅ **JS-side resolution wired** (DM-881, piece A): `src/render/coretext.ts` is
  no longer macOS-gated — it resolves the helper binary platform-aware
  (`darwin`/`linux`/`win32` → the in-tree `tools/<platform>-glyph-extractor/`
  binary, two levels up from the module), with `DOMOTION_HELPER_PATH` overriding
  on every platform. The engine-agnostic `createCoretextFont` wrapper spawns the
  Linux FreeType binary and consumes its design-unit, y-up output unchanged. A
  Linux-gated dispatch test in `src/render/coretext.test.ts` extracts an outline
  through the wrapper end-to-end (green in the `test:linux-docker` container).
- ⏳ **Remaining — the probe-then-fallback *trigger* (separate follow-up).** The
  renderer can now *invoke* the Linux helper, but nothing routes through it on
  Linux yet: the helper is reached only via the static `extractor: "coretext"`
  flag, set on no Linux `FONT_PATHS` entry. The doc-16 "fontkit-empty path →
  consult the helper for any font" trigger is unbuilt; it pairs with the Linux
  fallback-chain calibration (DM-259) that decides which fonts route through it.
- ⏳ **On-demand acquisition** for published consumers (download release asset →
  user cache → SHA-verify → chmod) — the missing DM-393 layer, filed as DM-886.
- ⏳ **arm64 asset** — open (see Open questions §3).

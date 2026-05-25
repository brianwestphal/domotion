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
  symbol fallback. `mathml-mi-italic-letters` and `mathml-mi-greek-italic`
  currently render as `<text>` with **0 glyph paths** because fontkit's
  `glyphForCodePoint` returns `.notdef` for the Mathematical Alphanumeric range
  (U+1D400–1D7FF) on FreeSans, even though Chromium paints those glyphs (verified
  via CDP `CSS.getPlatformFontsForNode`). This is the open bug **DM-838** — and a
  Linux-container probe (this session) **resolved it: a native FreeType walk does
  NOT fix it.** FreeSans's cmap does not cover U+1D400–1D7FF at all
  (`characterSet` excludes them; `glyphForCodePoint` and `FT_Get_Char_Index`
  alike return `.notdef`); Chromium paints the math letters by *synthesizing*
  from the base Latin/Greek letters (the matched face is `FreeSansOblique`,
  already italic). So DM-838's fix is a capture/render-side Math-Alpha→base-letter
  decomposition (tracked separately), **not** this extractor. The CJK / other
  fallback faces below — where fontkit's outline walk genuinely diverges — remain
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
2. **Size.** `FT_Set_Char_Size` / `FT_Set_Pixel_Sizes` to the requested CSS-pixel
   `emSize` (so the outline is pre-scaled, parity with the other helpers).
3. **Variations.** Apply `wght` / `opsz` / `slnt` via
   `FT_Set_Var_Design_Coordinates` when the face is an MM/variable font
   (`FT_Get_MM_Var`); no-op otherwise (parity with the CoreText/DirectWrite
   helpers).
4. **Glyph id resolution.** `FT_Get_Char_Index(face, codepoint)` (cmap lookup).
   Index `0` is `.notdef` → emit an empty path (parity with the "missing glyph →
   empty `d`" rule). (Note: this does NOT recover the DM-838 Math-Alpha case —
   FreeSans genuinely lacks U+1D4xx, so `FT_Get_Char_Index` returns `.notdef`
   just like fontkit; that's a capture/render-side fix, see "Why".)
5. **Outline load + decompose.** `FT_Load_Glyph(face, glyphIndex,
   FT_LOAD_NO_BITMAP | FT_LOAD_NO_HINTING)` → `FT_Outline_Decompose(&face->glyph->outline, &funcs, &ctx)`
   with an `FT_Outline_Funcs` whose callbacks emit SVG path-data (below).
6. **Advances + bbox.** `face->glyph->advance.x >> 6` (26.6 fixed → px) for the
   advance; bbox from the decomposer's accumulated min/max or `FT_Glyph_Get_CBox`.
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
both, same as the CoreText helper which also emits `Q`). Coordinates from
`FT_Outline_Decompose` are in 26.6 fixed point at the set pixel size — convert
to float px (`v / 64.0`).

### Coordinate system

FreeType outline y points **up** (font convention), origin at the baseline; SVG
wants y **down**. **Negate y** on every emitted coordinate — the same y-flip the
CoreText helper applies (doc 16 §"Internal pipeline" step 3). (Note: had we gone
through `cairo_glyph_path` instead, Cairo's user space is already y-down and no
flip would be needed — a reason the flip direction must be **validated by the
Helvetica-`H` parity test**, not assumed.)

Emit all numbers at fixed 3-decimal precision for deterministic, dedup-friendly
output (parity with the other helpers).

### Build script & portability

- `tools/linux-glyph-extractor/CMakeLists.txt` + a `build.sh`, plus a
  **Docker-based build** (e.g. a `manylinux2014` or old-Ubuntu image) so the
  released binary links against an old glibc and runs across distros. Statically
  link FreeType (and fontconfig if retained) to avoid runtime `.so` version
  skew; the binary still dynamically links glibc, hence the old-glibc build base.
- A `README.md` in the helper dir documenting the local + Docker rebuild.
- Consider a `musl`/Alpine static build for a fully-static binary if glibc
  portability proves fragile (open question).

## Distribution

Per doc 16: release asset `domotion-glyph-paths-linux-x64` (and `-arm64` — see
open questions), built on an `ubuntu-*` GitHub runner (x64) in the Docker
portability image, uploaded, downloaded on demand into the Linux user-cache dir
(`$XDG_DATA_HOME/domotion/<version>/bin/`, default `~/.local/share/...`), `chmod +x`,
reused thereafter. Extends DM-393's engine-agnostic acquisition logic.

## Validation

- **DejaVu Sans / Liberation `H` outline parity**: extract `H` via fontkit and
  via the helper; assert the path commands match within a numeric tolerance —
  confirms the y-flip and the quad/cubic mapping. Add to
  `tests/linux-glyph-extractor.test.ts` (runs only on `process.platform === 'linux'`).
- **FreeSans Math-Alpha (regression guard, NOT a DM-838 fix)**: extracting
  U+1D44E 𝑎 from FreeSans returns an **empty** path — FreeSans lacks the
  U+1D400–1D7FF range (confirmed this session). Kept only to document that the
  extractor does not cover this; DM-838's fix is the capture/render-side
  Math-Alpha→base-letter decomposition, out of scope here.
- **CI**: a Linux job (the `test-linux.yml` from DM-262, or the Docker harness
  `npm run test:linux-docker`) builds the helper from a clean checkout and runs
  `npm run demos:test:html`, exercising the FreeSans / Noto fallback ranges
  through the native route once the Linux fallback chain (DM-259) is calibrated.

## Open questions (for follow-up / user input)

1. **glibc floor / static strategy** — build against `manylinux2014` (glibc 2.17)
   for broad compatibility, or ship a fully-static musl/Alpine binary? Affects
   the build image and whether fontconfig can be static.
2. **fontconfig dependency** — keep fontconfig for family→file resolution, or
   require callers to always pass a `fontPath` (the capture side resolves
   families already via the platform font-path map, DM-258) and drop the
   fontconfig link entirely for a leaner binary?
3. **arm64** — ship `domotion-glyph-paths-linux-arm64` alongside x64, or x64 only
   until there's demand?

## Out of scope

- GPOS / shaping — fontkit-owned (parity with doc 16).
- The Windows DirectWrite extractor — DM-390 / DM-837 (`docs/41`).
- Linux fallback-chain calibration (which key paints which block) — DM-259.
- Color-emoji vector layers (Noto Color Emoji `CBDT`/`COLR`) — separate ticket.

## Follow-ups to file

- Implement the C/C++ helper (`tools/linux-glyph-extractor/`) + CMake/build.sh +
  Docker build image. **Blocked on a Linux build environment** (the C++ helper
  can't be built/tested on macOS; the Docker harness can validate it).
- Wire the linux asset into the release workflow (build on `ubuntu-*`, upload
  `domotion-glyph-paths-linux-x64`) — extends DM-393's engine-agnostic
  acquisition logic.
- `tests/linux-glyph-extractor.test.ts` parity tests (DejaVu/Liberation `H`;
  a FreeSans Math-Alpha case documenting the extractor returns empty there —
  DM-838 is fixed capture-side, not by this helper).

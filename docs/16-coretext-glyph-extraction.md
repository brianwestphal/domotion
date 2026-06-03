# Domotion: native glyph-outline extraction (CoreText / Pango / DirectWrite)

Requirements for extracting vector glyph outlines via the host platform's native font engine instead of fontkit, so Domotion can render any font Chromium can paint — including fonts whose outlines are stored in proprietary tables fontkit doesn't parse. Origin: DM-385 (macOS / CoreText), with cross-platform analogues to be filed for Linux (Pango/Cairo) and Windows (DirectWrite).

> **Cross-platform note**: This doc describes a per-platform native-extractor strategy that is the preferred answer on every supported platform. macOS lands first (DM-385) because PingFang is the immediate forcing function (DM-382 / DM-364). Linux + Windows analogues are tracked separately. Bundling OFL fonts (DM-384) is a fallback only for platforms that ship before their native extractor lands.

## Why now

DM-382 surfaced that PingFang (the macOS Chinese system font Chrome paints unmarked Han through) stores its glyph outlines in `hvgl`, an Apple-private table with no public spec. fontkit reads the cmap and metadata but `glyphForCodePoint` returns null because there is no `glyf` / `CFF` / `CFF2` table to walk. That blocked every PingFang-targeted route in the fallback chain. The same class of problem applies — or is likely to apply — to:

- **PingFang SC / TC / HK / MO / JP** — the unmarked-Han forcing function on macOS.
- **SF Pro / SF Compact** variable widths beyond the axes fontkit projects.
- **SF Symbols**, **Apple Color Emoji** vector layers, **STIX Two Math**, **system math fonts**.
- Anything Apple ships in the future inside `hvgl` or successor formats.

Bundling metric-compatible OFL substitutes (DM-384) was the original Plan A. It was rejected because:

- ~10 MB per CJK regional variant — bundling SC/TC/HK/JP pushes the npm package toward 40 MB.
- Substitute drift — glyph outlines, advances, and ink boundaries do not exactly match Chrome's CoreText paint, so visual diffs persist.
- It only solves CJK; Apple-private formats outside `hvgl` (math, symbols) still slip through.

The native extractor sidesteps all three: zero packaged-font weight on macOS, byte-identical outlines to Chrome's paint, and any font CoreText can rasterize becomes accessible.

## Goals

- Extract per-glyph outline path data and font metadata from any font installed on the host platform, regardless of whether fontkit parses its outline table.
- Match Chromium's painted outlines exactly on the host platform — same engine reading the same files.
- Stay invisible to non-macOS targets in the macOS-first phase: when the helper is absent, fall through to fontkit so existing fixtures keep passing.
- Generalize the pattern: each platform gets a sibling helper using its native font engine.

## Resolved design decisions (2026-05-01)

These are the answers to the open-questions block on DM-385 — locked in, the rest of this doc reflects them.

1. **Distribution**: pre-built signed binary published as a **GitHub release asset** per platform/arch, downloaded on demand by a Domotion postinstall step (or first-render lazy fetch) into a user-cache location. Not committed to git, not bundled in the npm tarball — keeps the package thin, keeps git history clean.
2. **Codesigning**: signed with the project's Apple Developer ID and notarized as part of the GitHub Actions release workflow. We already sign other artifacts; reuse the same CI signing infra.
3. **Triggering**: **probe-then-fallback** — every glyph extraction tries fontkit first; if fontkit returns no outline (`glyphForCodePoint` null OR an empty path), the helper takes over. An in-memory cache keyed on `(fontFile, glyphId)` records the resolution decision so each glyph is probed once per render session.
4. **Helper scope**: works for **any font** CoreText can open — not restricted to a proprietary-outline allowlist. Only invoked when the probe says fontkit can't handle the font. The helper is also the route for any font metadata fontkit can't surface, not just outline geometry.
5. **Decoration metrics**: fontkit when it can read them; helper when fontkit can't. The helper exposes a `meta` request type returning `unitsPerEm`, ascent, descent, `post.underlinePosition` / `underlineThickness`, `OS/2.yStrikeoutPosition` / `yStrikeoutSize`. Caller prefers fontkit's values when available, falls back to the helper's.
6. **Spawn model**: `spawnSync` per call, but the helper accepts an optional `--input <path>.json` for bulk requests so the caller can batch all glyphs needed across a render session into a single invocation. Stdin remains supported for the simple one-shot case.
7. **Initial routing scope**: SC-only in the first PR (covers DM-364 / DM-382). TC / HK / MO / JP follow once SC lands clean — separate ticket.

## Non-goals

- **Shaping / GPOS positioning.** fontkit's `font.layout()` continues to drive run-based shaping (Arabic init/medi/fina, Devanagari clusters, Thai mark-on-base, CJK GPOS). The native extractor only emits per-glyph outline geometry; it doesn't produce positioned runs.
- **Color-bitmap emoji rasterization.** Already handled by the Playwright screenshot path (DM-369).
- **Variation-axis discovery.** The extractor accepts `wght` / `opsz` / `slnt` as inputs; it does not introspect available axes. fontkit owns axis discovery for fonts it parses.

## macOS implementation: Swift CLI helper (DM-385)

### Helper binary

- **Name**: `domotion-glyph-paths`.
- **Source location**: `tools/macos-glyph-extractor/` (Swift Package). Not committed as a binary.
- **Build**: `tools/macos-glyph-extractor/build.sh` produces a universal arm64 + x86_64 binary using `swift build -c release` per arch and `lipo -create` to fuse them.
- **Codesigning**: signed (hardened runtime) and notarized in the GitHub Actions release workflow with the project's Apple Developer ID.
- **Distribution**: published as a GitHub release asset (e.g. `domotion-glyph-paths-darwin-universal-vX.Y.Z`). The Domotion package fetches the binary into the user-cache directory (`~/Library/Caches/domotion/<version>/bin/`) on first need and reuses the cached copy thereafter.
- **Size**: ~few hundred KB; downloaded once per Domotion version, not per project.

### IPC protocol

The helper accepts a single request as JSON, either inline on stdin or via `--input <path.json>` for bulk requests too large to pipe ergonomically.

**Request envelope** — supports two operations, batched in any combination:

```json
{
  "fonts": [
    { "ref": "f1", "postscriptName": "PingFangSC-Medium", "fontPath": "/System/Library/Fonts/PingFang.ttc",
      "size": 22, "variations": { "wght": 500, "opsz": 22, "slnt": 0 } }
  ],
  "queries": [
    { "type": "meta", "fontRef": "f1" },
    { "type": "glyphs", "fontRef": "f1",
      "glyphs": [ { "cp": 27721 }, { "cp": 28450 }, { "id": 1234 } ] }
  ]
}
```

- Fonts are declared once with a caller-assigned `ref` and reused by query entries — avoids reopening the same font for every query and keeps batched requests compact.
- `postscriptName` is the CoreText name. `fontPath` is optional; when present the helper opens that file via `CTFontDescriptor` with the URL attribute, otherwise it resolves by postscriptName via `CTFontCreateWithName`.
- `size` is in CSS pixels. CoreText takes points; the helper converts internally.
- `variations` is optional and applied via `CTFontDescriptorCreateCopyWithVariation` when the font exposes the axes.
- A `glyphs` query takes an array of either Unicode codepoint (`cp`) or pre-resolved glyph id (`id`) entries. `cp` is resolved with `CTFontGetGlyphsForCharacters`; missing-glyph (id 0) entries return empty path data. This is a one-glyph-per-codepoint mapping with **no shaping** — no ligatures, no reordering, no mark positioning, no dotted-circle insertion.
- A `meta` query returns the font-level metrics (see response below).
- A `shape` query (`{ "type": "shape", "fontRef": "f1", "text": "…" }`) runs **CoreText line shaping** (`CTLine`) over the string and returns the shaped glyph stream — ids, per-glyph advance and GPOS offset, the UTF-16 source-cluster index, and the outline. This is what makes complex scripts round-trip: an orphaned Brahmic combining mark gets its dotted circle (U+25CC) inserted, conjuncts ligate and reorder, and marks position over their base. Used for the per-Unicode-block font routes whose scripts use a complex shaper (Javanese, Marchen, Telugu, Devanagari, Balinese, …) — fontkit's Universal Shaping Engine is broken for these (it mis-stacks marks and throws on some clusters), so CoreText, the engine Chrome also shapes through on macOS, is the source of truth. Each shaped glyph: `{ "id", "cluster", "ax", "ay", "dx", "dy", "d" }` where `ax`/`ay` are the advance, `dx`/`dy` the offset from the glyph's pen origin, and `cluster` the UTF-16 index into `text`. Outlines are read from each run's OWN CoreText font (`CTRunGetAttributes`) so a sub-substitution still draws the correct glyph. The renderer calls this only when the font covers every source codepoint — an UNCOVERED codepoint must stay on the `glyphs` path so the primary font's real `.notdef` reaches the page (CTLine would substitute a different font's tofu, regressing Sutton SignWriting and the no-font Brahmic blocks; DM-1028).

- **Synthetic dotted circle for UNCOVERED orphaned marks (DM-1026).** The `shape` path above only inserts a dotted circle for marks the font COVERS. For the "no font" Brahmic blocks (Soyombo, Zanabazar, Devanagari-Extended, …) the marks are uncovered — they stay on the `.notdef` path — yet Chrome's HarfBuzz STILL inserts a U+25CC before each orphaned mark and paints it from a fallback font, so a vowel-sign cell paints "◌ + .notdef tofu" (~51 px), not a bare tofu. `insertSyntheticDottedCircles` (in `text-to-path.ts`, run once at the `renderTextAsPath` funnel before run-splitting) reproduces this: it prepends a real U+25CC to each combining mark that is (a) Unicode category M, (b) in a complex-shaper block (`usesComplexShaperDottedCircle` — a positive list of Brahmic / Indic / SE-Asian ranges that DELIBERATELY EXCLUDES the generic combining-mark blocks 0300–036F / 1AB0 / 1DC0 / 20D0, which the default shaper paints with NO dotted circle), (c) uncovered by the whole font chain, and (d) orphaned (no base in its cluster — a base letter or an already-inserted ◌ satisfies the cluster, so consecutive orphaned marks share one ◌). The ◌ itself is covered, so it routes and renders through the normal pipeline; only the INSERTION is synthetic. Its advance is read from the PRIMARY font when that covers U+25CC (Chrome does the same — Arial Unicode MS gives ◌ a 0.6 em advance, not the fallback chain's full-width 1 em), so the displaced tofu lands where Chrome paints it. Empirically: Soyombo 1.20 % → 0.22 %, Zanabazar 0.80 % → 0 %, Dogra 0.52 % → 0.04 %, with the covered Indic blocks (Devanagari, Tibetan, Khmer, Balinese) and the generic combining-mark blocks byte-identical (gates (b)/(c) keep them untouched).

**Response** (stdout, JSON, indices align with the request's `queries` array):

```json
{
  "results": [
    {
      "type": "meta",
      "unitsPerEm": 1000,
      "ascent": 880,
      "descent": -220,
      "underlinePosition": -100,
      "underlineThickness": 50,
      "strikeoutPosition": 350,
      "strikeoutThickness": 50
    },
    {
      "type": "glyphs",
      "glyphs": [
        { "id": 1234, "advance": 22.0,
          "bbox": { "x": 0.5, "y": -3.2, "w": 21.0, "h": 24.5 },
          "d": "M 0.5 -3.2 L 21.5 -3.2 Z" }
      ]
    }
  ]
}
```

- `bbox` and `d` are in CSS-pixel space at the requested `size`, with the SVG-standard y-axis (positive y down). The helper applies the y-flip from CoreText's flipped-y coordinate system before emitting paths.
- `d` is a single SVG path-data string. Empty for missing glyphs.
- Decoration metrics (`underlinePosition` / `underlineThickness` / `strikeoutPosition` / `strikeoutThickness`) come from `post` and `OS/2`; expressed in font units. `unitsPerEm` lets callers convert to em-fraction or pixels at any size.

Exit code 0 on success; non-zero with a JSON error object on stderr otherwise. CLI flags:

- `--input <path>` — read the request envelope from the given file instead of stdin.
- `--version` / `--help` — standard.

### Internal pipeline (Swift)

1. Open each declared font once: prefer `fontPath` via `CTFontDescriptorCreateWithAttributes([kCTFontURLAttribute: ...])` then `CTFontCreateWithFontDescriptor`. Otherwise `CTFontCreateWithName(name, sizePt, nil)`.
2. Apply variations via `CTFontDescriptorCreateCopyWithVariation` when present.
3. For `glyphs` queries:
   - Resolve glyph ids via `CTFontGetGlyphsForCharacters`.
   - For each glyph, `CTFontCreatePathForGlyph(font, glyph, nil)` → `CGPath`.
   - `cgPath.applyWithBlock` walks the elements:
     - `.moveToPoint(x, y)` → `M {x} {-y}`
     - `.addLineToPoint(x, y)` → `L {x} {-y}`
     - `.addQuadCurveToPoint(cx, cy, x, y)` → `Q {cx} {-cy} {x} {-y}`
     - `.addCurveToPoint(c1x, c1y, c2x, c2y, x, y)` → `C {c1x} {-c1y} {c2x} {-c2y} {x} {-y}`
     - `.closeSubpath` → `Z`
   - `CTFontGetAdvancesForGlyphs(.horizontal, ...)` for advance widths.
   - `CTFontGetBoundingRectsForGlyphs(.horizontalOrientation, ...)` for bbox; flip y to SVG convention.
4. For `meta` queries: read `unitsPerEm`, ascent, descent from CoreText; reach into the `post` and `OS/2` tables via `CTFontCopyTable` for underline/strikeout metrics.

Numbers are emitted with a fixed precision (3 decimal places) to keep the output deterministic and dedup-friendly downstream.

### Distribution and acquisition

- The Swift source lives in repo at `tools/macos-glyph-extractor/`.
- Release workflow (GitHub Actions) builds the universal binary, signs + notarizes it, and uploads it as a release asset under a stable URL pattern (e.g. `https://github.com/<owner>/domotion/releases/download/v<X.Y.Z>/domotion-glyph-paths-darwin-universal`).
- Domotion locates the helper at `~/Library/Caches/domotion/<package-version>/bin/domotion-glyph-paths`. If absent on first need, it downloads the release asset, verifies its signature (`codesign --verify --strict`), `chmod +x`, and caches it.
- Download is keyed on Domotion's published `version` from `package.json`, so a `npm install` of a newer Domotion triggers a fresh fetch. Older versions reuse their cache.
- `--no-network` / `DOMOTION_DISABLE_HELPER=1` env var skips the download and forces the fontkit fallback path — useful for sandboxed CI.
- A README section in `tools/macos-glyph-extractor/` documents how to rebuild from source for contributors.

## Domotion integration (`src/text-to-path.ts`)

Render-side only — no capture changes.

### Probe-then-fallback resolution

For every glyph extraction, the renderer:

1. Tries fontkit first (current code path: `getFontInstance(...).glyphForCodePoint` or `.getGlyph`).
2. Inspects the returned glyph: if fontkit yielded `null`, OR a glyph whose `.path.commands` array is empty (the PingFang case — fontkit reads cmap, returns a glyph object, but the path is empty because there is no `glyf` / `CFF` table), the resolution is recorded as **needs-helper**.
3. The helper is invoked (lazily, batched per render session) for every needs-helper entry; the returned outline replaces the fontkit-empty path in the glyph cache.
4. An in-memory map `(fontFile, glyphId) → "fontkit" | "helper" | "missing"` records the resolution so each glyph is probed exactly once per Node-process lifetime. A second render in the same process hits the cache and skips the probe entirely.

### `FONT_PATHS` and font-key changes

- New keys for PingFang families: `pingfang-sc`, `pingfang-sc-bold`, plus `pingfang-tc` / `pingfang-tc-bold`, `pingfang-hk` / `pingfang-hk-bold`, `pingfang-mo` / `pingfang-mo-bold` for the regional variants (DM-394). All point at `PingFang.ttc` with the appropriate postscriptName and `extractor: "coretext"`.
- There is no `pingfang-jp` entry — Apple's `PingFang.ttc` has no `PingFangJP-Regular` postscriptName on macOS (verified by probing all four `PingFang*-Regular` names; only SC / TC / HK / MO resolve to PingFang metrics — JP falls back to Helvetica). Japanese Han text routes through `hiragino-jp` (HiraKakuProN) instead.
- `fallbackFontChain(codepoint, primaryKey, lang?)`: CJK Unified Ideographs (U+4E00..U+9FFF), Ext A (U+3400..U+4DBF), and CJK Compatibility Ideographs (U+F900..U+FAFF) gain a locale-aware primary fallback for sans-serif primary:
  - `lang` ∈ `zh-TW` / `zh-Hant` / `zh-Hant-TW` → `pingfang-tc`, then `pingfang-sc`, then `cjk`.
  - `lang` ∈ `zh-HK` / `zh-Hant-HK` → `pingfang-hk`, then `pingfang-sc`, then `cjk`.
  - `lang` ∈ `zh-MO` → `pingfang-mo`, then `pingfang-sc`, then `cjk`.
  - `lang` ∈ `ja` / `ja-*` → `hiragino-jp`, then `cjk`.
  - `lang` ∈ `zh-CN` / `zh-Hans` / `zh-SG` / unset / non-Chinese → `pingfang-sc`, then `cjk`.
  - Region subtags win over script subtags in mixed tags (`zh-Hant-HK` → HK).
  - The locale matcher is exposed as `pingfangKeyForLang(lang)` for unit tests and reuse.
- The `lang` argument is the element's computed BCP-47 tag, captured per-element in `CAPTURE_SCRIPT` by walking `el.lang` through ancestor `[lang]` attributes to `<html lang>`. Stored on `CapturedElement.styles.lang` and threaded through `text-renderer.ts` → `renderTextAsPath` → `textToPathMarkup` → `fallbackFontChain`. DM-394.
- No `extractor` field on the rest of `FONT_PATHS` — the probe-then-fallback model determines the extractor at glyph-resolution time, not at the font-key level.

### Glyph wrapper

The fontkit `Font` API the renderer consumes (`glyphForCodePoint`, `layout`, `getGlyph`, `unitsPerEm`, advance widths, decoration metrics) is wrapped in a `ResolvedFont` adapter that:

- Delegates `unitsPerEm`, decoration metrics, and shaping (`layout`) to fontkit when fontkit can read the relevant tables (it can for PingFang's `post`/`OS/2`/`hmtx`/`cmap` even without outlines).
- Routes `getGlyph(id).path` through the helper batch when fontkit's path is empty.
- Falls back to fontkit for everything else.

### Bulk-request batching

- Each render session (one capture or one rendered SVG) accumulates a single helper request per font, batching across all glyphs encountered.
- The accumulated request is written to a temp JSON file under `os.tmpdir()/domotion-glyph-req-<pid>-<n>.json` and the helper is invoked as `domotion-glyph-paths --input <file>`. The temp file is deleted after the response is parsed.
- Stdin-piped requests remain supported but are reserved for tiny ad-hoc invocations (probe scripts, unit tests).

### Trigger guards

The helper is consulted only when:

- `process.platform` has a helper binary for it — `darwin`, `linux`, or `win32`. Resolution is platform-aware as of DM-881: each platform maps to its in-tree `tools/<platform>-glyph-extractor/` binary, and `DOMOTION_HELPER_PATH` overrides on every platform. (Before DM-881 the gate was hardcoded to `darwin`, and the in-tree path was even mis-resolved after the `src/render/` reorg, so only an explicit `DOMOTION_HELPER_PATH` reached a binary.)
- A binary exists at the resolved path (an in-tree dev build, the `DOMOTION_HELPER_PATH` target, or — for published consumers — the on-demand download into the user cache, implemented in DM-886 / `src/render/helper-acquire.ts`; see docs/50).
- `DOMOTION_DISABLE_HELPER` is not set.

If any guard fails, the renderer treats every fontkit-empty path as **missing** (renders the .notdef tofu) — no behavior change from today's pre-DM-385 baseline.

### Glyph-def caching

`ensureGlyphDef`'s cache key (`${fontKey}-${weight}-${fontSize}-${slant}-${glyphId}`) is unchanged — helper-derived paths dedupe through the same `<defs>` / `<use>` mechanism as fontkit-derived paths.

## Validation

- `02-text-ruby` (DM-364 / DM-382): expected to drop the residual ~0.43 % diff on the unmarked-Han route once `pingfang-sc` is wired through CoreText.
- Helvetica `H` outline parity check: extract via both fontkit and the helper, compare path commands within a numeric tolerance to confirm the y-flip and curve mapping are correct. Add to unit tests as `tests/coretext-extractor.test.ts`.
- New ad-hoc tool: `scripts/probe-coretext-glyphs.mjs` — invokes the helper with a small input, prints per-glyph summaries for human inspection.
- Per-platform CI: macOS GitHub runner builds the helper on a clean checkout (validates the build script) and runs `npm run demos:test:html` to exercise the routing.

## Cross-platform analogues

The same shape applies on Linux and Windows, swapping in the platform's native font engine. These land as separate tickets following DM-385.

| Platform | Engine | API entry | Release asset name |
|---|---|---|---|
| macOS | CoreText | `CTFontCreatePathForGlyph` | `domotion-glyph-paths-darwin-universal` |
| Linux | Pango/Cairo | `cairo_glyph_path` | `domotion-glyph-paths-linux-x64` (and `-arm64`) |
| Windows | DirectWrite | `IDWriteFontFace::GetGlyphRunOutline` | `domotion-glyph-paths-win32-x64.exe` (and `-arm64`) |

The IPC protocol is identical across platforms so `text-to-path.ts` only needs one dispatch layer. The acquisition logic (cache path, download URL pattern, integrity verification) is shared too — only the asset filename differs by platform/arch.

## Out of scope

- GPOS / shaping — fontkit-owned.
- Linux / Windows extractor implementations — separate tickets (DM-389 / DM-390).
- Color emoji vector layers — uses a different CoreText API and merits its own ticket.
- Persistent helper subprocess — deferred until spawn cost is measured against real workloads (DM-392).

## Follow-ups filed

- **DM-387** — implement the Swift helper (`tools/macos-glyph-extractor/`).
- **DM-388** — wire probe-then-fallback into `src/text-to-path.ts`.
- **DM-389** — Linux native glyph extractor (Pango/Cairo).
- **DM-390** — Windows native glyph extractor (DirectWrite).
- **DM-391** — codesign / notarize the macOS helper binary (rolled into DM-387's release workflow).
- **DM-392** — persistent-subprocess optimization for the helper (deferred until measured).
- **DM-393** — GitHub Actions release workflow + Domotion-side on-demand download.
- **DM-394** — extend PingFang routing to TC / HK / MO / JP after SC lands clean.

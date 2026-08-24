# Pinned Chromium SFNS validation hook

These files are the reproducible, test-only Chromium/Skia validation overlay.
They apply only to Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3` with Skia
`62efacd37737505732dbe3d8daa62abd679626a1` and depot_tools
`612d70c7ccb01d4a405e822ad0505206de636d7e`.

- `chromium-build.patch` adds a false-by-default private GN argument.
- `skia-hook.patch` adds four observation calls at raw-record construction,
  macOS record filtering, direct-mask phase packing, and the post-conversion
  macOS glyph buffer.
- `blink-v2-hook.patch` records each selected HarfBuzz glyph's direct logical
  advance and offset at both `ShapeResult::ForEachGlyphImpl` and the
  paint-owned `ShapeResultView::ForEachGlyphImpl`, before bloberization; no
  neighboring origin is used to reconstruct either value.
- `skia-v2-hook.patch` records the complete filtered-record gamma LUT and all
  three preblend buffers while Skia's gamma-cache mutex is held.
- `SkDomotionSfnsValidation.h` implements the environment- and SHA-gated hook.
- `node-isolation.sb` prevents Chromium's TypeScript tools from walking above
  the isolated checkout into this repository's unrelated `node_modules`. The
  build driver supplies its path parameter. This preserves Chromium's pinned,
  filtered GCS dependency bundle and does not affect the built runtime.

The v2 hook writes nothing unless its ABI, observation envelope, exact
7,909,644-byte source-SFNS digest, and the deterministic pinned-OTS stream
(`7,806,016` bytes, SHA-256 `48eedcec…acff4`) all match. Blink authenticates and
routes the source bytes; its mandatory OTS pass constructs Skia's typeface from
the second stream, so retaining both identities prevents either boundary from
being mistaken for the other. Normal Chromium builds leave the GN argument
false and compile no hook code.

The source checkout must retain Chromium's filtered `third_party/node` GCS
bundle. Do not replace it with `npm ci`: that adds `@types/estree`, which the
pinned bundle deliberately filters and which is incompatible with Chromium's
pinned TSESTree declarations. The build driver refuses that altered layout.

After provisioning the exact source graph and Xcode Metal component, build and
collect with:

```bash
npm run fonts:sfns-pinned-chromium:build
npm run fonts:sfns-pinned-chromium:collect
npm run fonts:sfns-pinned-chromium:validate
```

Collection starts a separate browser process per observation with both
Playwright `headless: true` and an explicit `--headless=new` flag. It also uses
`--disable-gpu` to exercise the CPU bitmap-mask path, `--enable-lcd-text` to
exercise Chromium's source-owned macOS headless LCD route, and `--no-sandbox`
so the local test-only renderer can write its authenticated trace directory.
The surface/mask-format control alone replaces the LCD switch with
`--disable-lcd-text`, proving the unknown-pixel-geometry/A8 route. It never
opens a visible browser window and does not change production rendering or any
visual tolerance.

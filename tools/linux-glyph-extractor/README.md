# Linux glyph-extractor (DM-872 / DM-389)

C++17 CLI that extracts SVG glyph outlines and font metadata from any Linux
system font using **FreeType** (`FT_Outline_Decompose` directly — no
Pango/Cairo). The Domotion render pipeline consults this helper as a
probe-then-fallback path when fontkit can't read a font's outline tables. It is
the Linux analogue of the macOS CoreText helper (`tools/macos-glyph-extractor`)
and the Windows DirectWrite helper.

Because Chromium-on-Linux rasterizes through FreeType, a helper that reads the
same files through FreeType produces byte-faithful outlines — the same
"same engine reading the same files" guarantee CoreText gives on macOS.

See [`docs/45-linux-glyph-extraction.md`](../../docs/45-linux-glyph-extraction.md)
for the full design and [`docs/16-coretext-glyph-extraction.md`](../../docs/16-coretext-glyph-extraction.md)
for the shared cross-platform contract.

## Build

```bash
./build.sh                 # → ./domotion-glyph-paths
```

Requires `cmake`, a C++17 compiler, and FreeType dev headers:

| Distro | Install |
| --- | --- |
| Debian/Ubuntu | `sudo apt-get install -y build-essential cmake libfreetype-dev pkg-config` |
| Fedora | `sudo dnf install -y gcc-c++ cmake freetype-devel pkgconf-pkg-config` |
| Arch | `sudo pacman -S --needed base-devel cmake freetype2 pkgconf` |

The binary links `libfreetype.so.6` **dynamically**. That is safe by
construction: the helper only runs in an environment that also runs Domotion's
Playwright Chromium, and Chromium-on-Linux requires system FreeType
(`libfreetype6` is part of `npx playwright install-deps`). So the shared library
is always present, and its SONAME is ABI-stable. A static build would need
`libfreetype.a` (not shipped by mainstream distros) for no real portability
gain.

### Reproducible / portability build (Docker)

The release workflow builds on an `ubuntu-22.04` runner (glibc 2.35 floor). To
reproduce that build locally without a FreeType toolchain on the host:

```bash
docker build -t domotion-linux-glyph-build .
cid=$(docker create domotion-linux-glyph-build) \
  && docker cp "$cid":/out/domotion-glyph-paths . \
  && docker rm "$cid"
```

The binary is **not committed to git** — it is published as a GitHub release
asset (`domotion-glyph-paths-linux-x64`) and downloaded on demand by the
Domotion runtime. For local development, build it once and Domotion's
helper-resolution logic finds the cached path.

## IPC protocol

Reads a single JSON request from stdin (or `--input <path>.json`) and writes a
JSON response to stdout — the exact envelope the macOS/Windows helpers use
([`docs/16`](../../docs/16-coretext-glyph-extraction.md) §IPC protocol).

Outlines are emitted in **font design units, y-up**, via `FT_LOAD_NO_SCALE` —
identical to fontkit's `glyph.path.commands`, so the renderer's
`scale(fontSize/unitsPerEm, …)` transform consumes helper output and fontkit
output interchangeably. (Do **not** negate y: the renderer flips to SVG y-down
at draw time.)

Quick smoke test:

```bash
echo '{"fonts":[{"ref":"f","fontPath":"/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf","size":1000}],"queries":[{"type":"glyphs","fontRef":"f","glyphs":[{"cp":72}]}]}' \
  | ./domotion-glyph-paths
```

## Tests

`tests/linux-glyph-extractor.test.ts` (vitest) asserts the helper's outlines
match fontkit command-for-command on Liberation Sans `H` (line mapping + y-up)
and FreeSans `𝑎` U+1D44E (the Math-Alphanumeric block the upright `FreeSans.ttf`
carries). The suite skips unless `process.platform === "linux"` and the binary
is built, so it is inert on macOS/Windows. Run it on a Mac via the Docker
harness: `npm run test:linux-docker -- tests/linux-glyph-extractor.test.ts`
(after building the binary inside the container).

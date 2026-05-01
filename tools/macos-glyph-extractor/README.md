# macOS glyph-extractor (DM-385 / DM-387)

Swift CLI that extracts SVG glyph outlines and metadata from any macOS-installed font using CoreText. The Domotion render pipeline consults this helper as a probe-then-fallback path when fontkit can't read a font's outline tables — e.g. PingFang, whose outlines live in Apple's proprietary `hvgl` table.

See [`docs/16-coretext-glyph-extraction.md`](../../docs/16-coretext-glyph-extraction.md) for the full design.

## Build

```bash
./build.sh
```

Produces a universal arm64 + x86_64 binary at `./domotion-glyph-paths`. Requires the Swift toolchain (Xcode CLI tools or full Xcode).

The binary is **not committed to git** — it is published as a GitHub release asset (`domotion-glyph-paths-darwin-universal`) and downloaded on demand by the Domotion runtime (DM-393). For local development, build it once and Domotion's helper-resolution logic will find the cached path.

## Codesigning + notarization

The release workflow signs and notarizes when the following env vars are set (typically via GitHub Actions secrets — DM-391):

```
APPLE_DEVELOPER_ID="Developer ID Application: <name> (<team-id>)"
APPLE_ID="..."
APPLE_TEAM_ID="..."
APPLE_APP_SPECIFIC_PASSWORD="..."
```

When `APPLE_DEVELOPER_ID` is unset, `build.sh` skips signing — local dev builds work without Apple credentials.

## IPC protocol

Reads a single JSON request from stdin or `--input <path>.json` and writes a JSON response to stdout. Schema in [`docs/16-coretext-glyph-extraction.md`](../../docs/16-coretext-glyph-extraction.md) §IPC protocol.

Quick smoke test:

```bash
echo '{"fonts":[{"ref":"f","postscriptName":"Helvetica","size":100}],"queries":[{"type":"glyphs","fontRef":"f","glyphs":[{"cp":72}]}]}' \
  | ./domotion-glyph-paths
```

For interactive inspection, `node scripts/probe-coretext-glyphs.mjs` (from the repo root) drives the helper with sensible defaults and pretty-prints the response.

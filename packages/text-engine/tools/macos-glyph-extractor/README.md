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

`build.sh` signs (hardened runtime + timestamp) and notarizes (`xcrun notarytool submit --wait`) when the following env vars are set:

```
APPLE_DEVELOPER_ID="Developer ID Application: <name> (<team-id>)"
APPLE_ID="..."
APPLE_TEAM_ID="..."
APPLE_APP_SPECIFIC_PASSWORD="..."
```

When `APPLE_DEVELOPER_ID` is unset, `build.sh` skips signing — local dev builds work without Apple credentials.

In CI this is driven by [`.github/workflows/release-helpers.yml`](../../.github/workflows/release-helpers.yml), which runs on every `v*` tag: it imports the Developer ID Application certificate into a throwaway keychain, runs `build.sh` with the four credentials above, and attaches the signed/notarized universal binary (plus a SHA-256 sidecar) to the release as `domotion-glyph-paths-darwin-universal`. The certificate is supplied to CI as two additional secrets the env vars above don't cover, because a fresh runner has an empty keychain:

```
APPLE_CERT_P12_BASE64   # base64 of the exported Developer ID Application .p12 (cert + private key)
APPLE_CERT_PASSWORD     # the .p12 export password
```

A bare CLI Mach-O cannot be stapled (only `.app` / `.pkg` / `.dmg` can), so the notarization ticket lives server-side and the runtime verifies the signature with `codesign --verify --strict` before caching.

## IPC protocol

Reads a single JSON request from stdin or `--input <path>.json` and writes a JSON response to stdout. Schema in [`docs/16-coretext-glyph-extraction.md`](../../docs/16-coretext-glyph-extraction.md) §IPC protocol.

Quick smoke test:

```bash
echo '{"fonts":[{"ref":"f","postscriptName":"Helvetica","size":100}],"queries":[{"type":"glyphs","fontRef":"f","glyphs":[{"cp":72}]}]}' \
  | ./domotion-glyph-paths
```

For interactive inspection, `node scripts/probe-coretext-glyphs.mjs` (from the repo root) drives the helper with sensible defaults and pretty-prints the response.

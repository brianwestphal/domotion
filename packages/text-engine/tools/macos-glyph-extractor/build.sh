#!/usr/bin/env bash
# Build the universal arm64 + x86_64 macOS binary for `domotion-glyph-paths`.
# Output: ./domotion-glyph-paths (universal Mach-O).
#
# Codesigning + notarization happen in CI (DM-391), driven by these env vars:
#   APPLE_DEVELOPER_ID="Developer ID Application: <name> (<team-id>)"
#   APPLE_ID="..."
#   APPLE_TEAM_ID="..."
#   APPLE_APP_SPECIFIC_PASSWORD="..."
# When APPLE_DEVELOPER_ID is unset, signing is skipped — fine for local dev.

set -euo pipefail

cd "$(dirname "$0")"

swift build -c release --arch arm64
swift build -c release --arch x86_64

ARM64_BIN=".build/arm64-apple-macosx/release/DomotionGlyphPaths"
X86_64_BIN=".build/x86_64-apple-macosx/release/DomotionGlyphPaths"

lipo -create \
    -output domotion-glyph-paths \
    "$ARM64_BIN" \
    "$X86_64_BIN"

if [[ -n "${APPLE_DEVELOPER_ID:-}" ]]; then
    codesign --force --options runtime --timestamp \
        --sign "$APPLE_DEVELOPER_ID" \
        domotion-glyph-paths

    if [[ -n "${APPLE_ID:-}" && -n "${APPLE_TEAM_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]]; then
        # notarytool requires a zip; submit, wait, then we don't staple a CLI binary
        # (stapling only applies to .app bundles, .pkg, and .dmg).
        ZIP="domotion-glyph-paths.zip"
        ditto -c -k --keepParent domotion-glyph-paths "$ZIP"
        xcrun notarytool submit "$ZIP" \
            --apple-id "$APPLE_ID" \
            --team-id "$APPLE_TEAM_ID" \
            --password "$APPLE_APP_SPECIFIC_PASSWORD" \
            --wait
        rm -f "$ZIP"
    fi
fi

file domotion-glyph-paths

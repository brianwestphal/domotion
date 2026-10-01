#!/usr/bin/env bash
# Build `domotion-glyph-paths` for macOS. The default is a universal arm64 +
# x86_64 Mach-O; `--arch arm64|x86_64` builds one architecture for CI.
#
# Codesigning + notarization happen in CI (DM-391), driven by these env vars:
#   APPLE_DEVELOPER_ID="Developer ID Application: <name> (<team-id>)"
#   APPLE_ID="..."
#   APPLE_TEAM_ID="..."
#   APPLE_APP_SPECIFIC_PASSWORD="..."
# When APPLE_DEVELOPER_ID is unset, signing is skipped — fine for local dev.

set -euo pipefail

cd "$(dirname "$0")"

ARCH="${2:-}"
if [[ $# -ne 0 && ( $# -ne 2 || "$1" != "--arch" || ( "$ARCH" != "arm64" && "$ARCH" != "x86_64" ) ) ]]; then
    echo "usage: $0 [--arch arm64|x86_64]" >&2
    exit 2
fi

STAGING="$(mktemp -d "${TMPDIR:-/tmp}/domotion-glyph-paths.XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT

build_arch() {
    local arch="$1"
    local bin_dir
    swift build -c release --arch "$arch"
    # SwiftPM has emitted both .build/<triple>/release and
    # .build/out/Products/Release. Ask the active toolchain, then stage the
    # result before another architecture build can overwrite a shared path.
    bin_dir="$(swift build -c release --arch "$arch" --show-bin-path)"
    if [[ ! -f "$bin_dir/DomotionGlyphPaths" ]]; then
        echo "SwiftPM did not produce DomotionGlyphPaths in $bin_dir" >&2
        exit 1
    fi
    cp "$bin_dir/DomotionGlyphPaths" "$STAGING/$arch"
}

if [[ -n "$ARCH" ]]; then
    build_arch "$ARCH"
    cp "$STAGING/$ARCH" domotion-glyph-paths
else
    build_arch arm64
    build_arch x86_64
    lipo -create \
        -output domotion-glyph-paths \
        "$STAGING/arm64" \
        "$STAGING/x86_64"
fi

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

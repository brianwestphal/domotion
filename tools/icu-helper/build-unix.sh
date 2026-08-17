#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ICU_SOURCE="$ROOT/external/chromium/third_party/icu/source"
BUILD_ROOT="${RUNNER_TEMP:-/tmp}/domotion-icu-build"
INSTALL_ROOT="$BUILD_ROOT/install"

rm -rf "$BUILD_ROOT"
mkdir -p "$BUILD_ROOT/build"
cd "$BUILD_ROOT/build"

case "$(uname -s)" in
  Darwin) CONFIGURE_TARGET=MacOSX ;;
  Linux) CONFIGURE_TARGET=Linux/gcc ;;
  *) echo "unsupported host" >&2; exit 2 ;;
esac

"$ICU_SOURCE/runConfigureICU" "$CONFIGURE_TARGET" \
  --prefix="$INSTALL_ROOT" --enable-static --disable-shared \
  --disable-tests --disable-samples --disable-extras --disable-tools
make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)"
make install

cmake -S "$ROOT/tools/icu-helper" -B "$BUILD_ROOT/helper" \
  -DCMAKE_BUILD_TYPE=Release -DDOMOTION_ICU_ROOT="$INSTALL_ROOT"
cmake --build "$BUILD_ROOT/helper" --config Release --parallel
cp "$BUILD_ROOT/helper/domotion-icu" "$ROOT/tools/icu-helper/domotion-icu"

#!/usr/bin/env bash
# Build the Linux FreeType glyph extractor locally.
#
#   ./build.sh
#
# Requires: cmake, a C++17 compiler, and FreeType dev headers
#   Debian/Ubuntu: sudo apt-get install -y build-essential cmake libfreetype-dev pkg-config
#   Fedora:        sudo dnf install -y gcc-c++ cmake freetype-devel pkgconf-pkg-config
#   Arch:          sudo pacman -S --needed base-devel cmake freetype2 pkgconf
#
# Links libfreetype.so.6 dynamically — always present alongside Chromium (the
# only environment Domotion runs in). See CMakeLists.txt / docs/45.
#
# Output: ./domotion-glyph-paths
set -euo pipefail
cd "$(dirname "$0")"

cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j

cp -f build/domotion-glyph-paths ./domotion-glyph-paths
echo "Built ./domotion-glyph-paths"

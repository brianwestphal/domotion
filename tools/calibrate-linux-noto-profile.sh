#!/usr/bin/env bash
# DM-1404 — (re)calibrate the desktop-Linux **Noto profile** font routing.
#
# WHY
#   The bare LINUX_FONT_PATHS / linuxFallbackChain calibration is pinned to the
#   Playwright `*-noble` image, whose fallback fonts are WenQuanYi Zen Hei /
#   FreeFont / IPAGothic / Loma — NOT the mainstream desktop-Linux Noto family
#   most users (Ubuntu/Fedora) actually have. This produces the SECOND profile:
#   what Chromium-on-a-Noto-desktop paints per Unicode block.
#
# WHAT IT DOES (inside the same noble container CI uses)
#   1. Strips the noble-image-only fallback fonts so they don't out-prioritize
#      Noto in fontconfig (the contamination that makes a naive `apt install
#      noto` on noble STILL paint CJK with WenQuanYi — see DM-1404 notes).
#   2. Installs the mainstream Noto set (fonts-noto-core / -cjk / -extra / emoji).
#   3. Runs the per-block CDP sweep (tools/probe-983-sweep.mjs) → Chromium's
#      painted family per block, and resolves each family to its on-disk file via
#      fc-match (tools/probe-983-resolve-families.mjs, run in-container).
#   4. Writes tests/output/{unicode-fonts,family-to-path}.noto-linux.json
#      (gitignored regeneration artifacts).
#
#   Then, ON THE HOST, run the generator to emit the committed routing table:
#     node tools/probe-983-genroutes-noto-linux.mjs
#       -> src/render/unicode-font-routing.noto-linux.generated.ts
#
# REQUIREMENTS: Docker. The unicode block fixtures (../html-test/unicode).
# USAGE: bash tools/calibrate-linux-noto-profile.sh

set -euo pipefail
cd "$(dirname "$0")/.."

PW_VERSION=$(node -p "require('./node_modules/@playwright/test/package.json').version" 2>/dev/null \
  || node -p "require('./package-lock.json').packages['node_modules/@playwright/test'].version")
IMAGE="mcr.microsoft.com/playwright:v${PW_VERSION}-noble"
UNICODE_DIR="$(cd ../html-test/unicode && pwd)"
mkdir -p tests/output

echo ">>> Image: ${IMAGE}"
docker pull "${IMAGE}" >/dev/null

docker run --rm --ipc=host --init \
  -v "$(pwd):/work" \
  -v "${UNICODE_DIR}:/unicode:ro" \
  -v domotion-linux-node-modules:/work/node_modules \
  -v domotion-linux-npm-cache:/tmp/.npm \
  -w /work \
  -e HOME=/tmp -e CI=true -e npm_config_cache=/tmp/.npm \
  -e HTML_TEST_DIR=/unicode \
  -e UNICODE_FONTS_OUT=/work/tests/output/unicode-fonts.noto-linux.json \
  -e SWEEP_IN=/work/tests/output/unicode-fonts.noto-linux.json \
  -e FAM2PATH_OUT=/work/tests/output/family-to-path.noto-linux.json \
  "${IMAGE}" \
  bash -lc '
    set -e
    echo "=== strip noble-only fallback fonts ===" ;
    apt-get remove -y -qq fonts-wqy-zenhei fonts-freefont-ttf fonts-tlwg-loma-otf fonts-unifont fonts-ipafont-gothic fonts-ipafont-mincho >/dev/null 2>&1 || true ;
    echo "=== install mainstream Noto ===" ;
    apt-get update -qq >/dev/null 2>&1 ;
    apt-get install -y -qq fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji fonts-noto-extra >/dev/null 2>&1 ;
    fc-cache -f >/dev/null 2>&1 ;
    echo "=== sanity: fontconfig CJK/script picks ===" ;
    for cp in 4e00 0e01 0905 0671; do printf "U+%s -> " "$cp"; fc-match -f "%{family}\n" "sans-serif:charset=$cp"; done ;
    npm ci --no-audit --no-fund --prefer-offline >/dev/null 2>&1 ;
    echo "=== per-block CDP sweep ===" ;
    node tools/probe-983-sweep.mjs >/dev/null 2>&1 ;
    echo "=== resolve families -> on-disk paths ===" ;
    node tools/probe-983-resolve-families.mjs ;
  '

echo
echo ">>> Sweep written to tests/output/{unicode-fonts,family-to-path}.noto-linux.json"
echo ">>> Now regenerate the committed routing table on the host:"
echo ">>>   node tools/probe-983-genroutes-noto-linux.mjs"

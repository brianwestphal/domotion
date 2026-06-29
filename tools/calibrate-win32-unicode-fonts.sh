#!/usr/bin/env bash
# DM-1423 — (re)calibrate the desktop-Windows-11 per-Unicode-block font routing
# (src/render/unicode-font-routing.win32.generated.ts) on a REAL desktop Win11
# host, NOT from the Server-based `windows-latest` CI runner.
#
# WHY DESKTOP, NOT CI
#   `windows-latest` is Windows **Server**, whose default font set is narrower
#   than desktop Windows 11 — it omits Yu Gothic, SimSun-ExtB/G, Microsoft Yi
#   Baiti, Javanese/Myanmar Text, and other supplemental faces the committed
#   table routes to. Regenerating from the Server artifact would silently drop
#   those routes. So the sweep must run on a desktop Win11 host — the Parallels
#   "Windows 11" VM (Apple-Silicon / Windows-on-ARM).
#
# CRITICAL: PIN THE CHROMIUM VERSION TO THE REPO'S PLAYWRIGHT
#   The table records which face Chromium picks per block, so it must be swept
#   with the SAME Chromium the renderer + visual suite are calibrated against —
#   i.e. the chromium revision bundled by the repo's pinned @playwright/test
#   (currently 1.59.1 → chromium-1217). A newer/older Chromium drifts the
#   routing for recent Unicode blocks: a 1.60.0 / chromium-1223 sweep moved
#   `latin-extended-f` (U+10780) and `latin-extended-g` (U+1DF00) from
#   Calibri / Sans Serif Collection to Arial — a Chromium-version nuance, NOT a
#   desktop-vs-Server difference, and the WRONG answer for the pinned Chromium.
#   Install the matching version in the VM before sweeping (see steps).
#
# THIS SCRIPT prints the runbook + drives the host-side regen once the VM has
# produced a fresh sweep JSON at tools/scratch/out/unicode-fonts.win32.fresh.json.
# The in-VM sweep is run manually because the Playwright install under
# `prlctl exec` (which runs as nt authority\system) needs care — see below.

set -euo pipefail
cd "$(dirname "$0")/.."

PW_VERSION=$(node -p "require('./node_modules/@playwright/test/package.json').version")
VM='Windows 11'
REPO_WIN='\\Mac\Home\Documents\domotion'
UNICODE_WIN='\\Mac\Home\Documents\html-test\unicode'
FRESH="tools/scratch/out/unicode-fonts.win32.fresh.json"

cat <<EOF
=== DM-1423 desktop-Win11 win32 font-routing regen ===
Repo pins @playwright/test ${PW_VERSION}.

STEP 1 (in the VM) — set up a probe dir with the PINNED Playwright + its Chromium
(INCLUDING the headless shell — chromium.launch() uses chrome-headless-shell):

  prlctl exec "${VM}" cmd /c "mkdir C:\\win32probe & cd /d C:\\win32probe & ^
    npm.cmd init -y & ^
    npm.cmd install @playwright/test@${PW_VERSION} fontkit & ^
    npx.cmd playwright install chromium chromium-headless-shell"

  Verify both exist (rev must match the repo's playwright-core/browsers.json):
    %LOCALAPPDATA%\\ms-playwright\\chromium-<rev>\\...\\chrome.exe
    %LOCALAPPDATA%\\ms-playwright\\chromium_headless_shell-<rev>\\...\\chrome-headless-shell.exe
  GOTCHA: under \`prlctl exec\` (nt authority\\system) the browsers install to the
  SYSTEM profile (C:\\Windows\\system32\\config\\systemprofile\\AppData\\Local\\
  ms-playwright). If the headless shell is reported "missing" at launch, run
  \`npx playwright install --force chromium-headless-shell\` and confirm the .exe
  actually lands; do NOT proceed with only the full chromium installed.

STEP 2 (in the VM) — run the canonical sweep against the desktop font set:

  prlctl exec "${VM}" cmd /c "copy /Y ${REPO_WIN}\\tools\\probe-983-sweep.mjs C:\\win32probe\\sweep.mjs & ^
    cd /d C:\\win32probe & set HTML_TEST_DIR=${UNICODE_WIN}& ^
    set UNICODE_FONTS_OUT=${REPO_WIN}\\${FRESH//\//\\}& node sweep.mjs"

STEP 3 (host) — regenerate + review. Re-run this script with --regen:
  node tools/probe-983-genroutes-win32.mjs reads tests/output/unicode-fonts.win32.json
  and rewrites src/render/unicode-font-routing.win32.generated.ts.
EOF

if [ "${1:-}" = "--regen" ]; then
  [ -s "$FRESH" ] || { echo ">>> $FRESH not found — run STEP 2 first."; exit 1; }
  cp "$FRESH" tests/output/unicode-fonts.win32.json
  node tools/probe-983-genroutes-win32.mjs
  echo ">>> Review: git diff src/render/unicode-font-routing.win32.generated.ts"
  echo ">>> Commit only if the diff reflects a real desktop font-set change, NOT a Chromium-version nuance (confirm the sweep used the pinned chromium rev)."
fi

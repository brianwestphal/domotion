#!/usr/bin/env bash
# Set up a macOS checkout with the same primary-host dependencies as CI.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ $# -gt 1 || ( $# -eq 1 && "$1" != --check ) ]]; then
  echo "usage: $0 [--check]" >&2
  exit 2
fi
check_only=false
if [[ ${1:-} == --check ]]; then check_only=true; fi

if [[ $(uname -s) != Darwin ]]; then
  echo 'prep-macos-dev must run on macOS.' >&2
  exit 1
fi

if ! xcode-select -p >/dev/null 2>&1 || ! xcrun --find swift >/dev/null 2>&1; then
  echo 'Install the Xcode Command Line Tools, then rerun this command.' >&2
  if [[ $check_only == false ]]; then xcode-select --install || true; fi
  exit 1
fi

if command -v brew >/dev/null 2>&1; then
  brew_cmd=$(command -v brew)
elif [[ -x /opt/homebrew/bin/brew ]]; then
  brew_cmd=/opt/homebrew/bin/brew
  eval "$("$brew_cmd" shellenv)"
elif [[ -x /usr/local/bin/brew ]]; then
  brew_cmd=/usr/local/bin/brew
  eval "$("$brew_cmd" shellenv)"
else
  echo 'Install Homebrew from https://brew.sh, then rerun this command.' >&2
  exit 1
fi

node_ready=false
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
  if (( node_major >= 22 )); then node_ready=true; fi
fi

if [[ $check_only == true ]]; then
  if [[ $node_ready == false ]]; then
    echo 'Node.js 22+ and npm are required. Run make prep-macos-dev to install them.' >&2
    exit 1
  fi
  if ! command -v ffmpeg >/dev/null 2>&1; then
    echo 'ffmpeg is required for video export. Run make prep-macos-dev to install it.' >&2
    exit 1
  fi
  echo "macOS tools ready: $(node --version), npm $(npm --version), Swift, ffmpeg."
  exit 0
fi

if [[ $node_ready == false ]]; then
  "$brew_cmd" install node@22
  node_bin="$("$brew_cmd" --prefix node@22)/bin"
  export PATH="$node_bin:$PATH"
  profile="${ZDOTDIR:-$HOME}/.zprofile"
  profile_line="export PATH=\"$node_bin:\$PATH\""
  if [[ ! -f $profile ]] || ! grep -Fqx "$profile_line" "$profile"; then
    printf '\n# Domotion development (Homebrew Node.js 22)\n%s\n' "$profile_line" >> "$profile"
    echo "Added Homebrew Node.js 22 to $profile. Open a new shell after setup."
  fi
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  "$brew_cmd" install ffmpeg
fi

echo 'Installing locked npm dependencies...'
npm ci
echo 'Materializing pinned upstream source files used by the test suite...'
npm run sources:materialize
echo 'Installing Playwright Chromium...'
npx playwright install chromium
echo 'Building the native macOS glyph helper for this machine...'
bash packages/text-engine/tools/macos-glyph-extractor/build.sh --arch "$(uname -m)"
echo 'Checking TypeScript and production build...'
npm run typecheck
npm run build
echo 'Domotion macOS development setup is ready.'

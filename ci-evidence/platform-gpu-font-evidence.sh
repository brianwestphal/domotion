#!/usr/bin/env bash
set -uo pipefail
echo "=== renderer switch (scoped to own browser)"
for i in 1 2 3 4 5; do node ci-evidence/probe-renderer-switch.mjs raw; node ci-evidence/probe-renderer-switch.mjs barrier; done
echo "=== e2e"
npm run build:text-engine >/dev/null && npm run build:capture-script >/dev/null && \
  npx vitest run --config vitest.e2e.config.ts \
    src/capture/gpu-startup-barrier.e2e.test.ts tests/font-family-animation-provenance.e2e.test.ts
rc=$?
echo "e2e exit $rc"
exit $rc

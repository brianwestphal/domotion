#!/usr/bin/env bash
# Platform evidence for the GPU-startup barrier and the animated font-family
# paint proof. Runs the probes, then the two e2e files.
set -uo pipefail
echo "=== standard-vs-concrete paint"
node ci-evidence/probe-standard-vs-concrete.mjs
echo "=== gpu startup raw (no barrier)"
node ci-evidence/probe-gpu-startup.mjs 10 raw
echo "=== gpu startup raw + --disable-software-compositing-fallback"
node ci-evidence/probe-gpu-startup.mjs 3 raw --disable-software-compositing-fallback
echo "=== gpu startup barrier"
node ci-evidence/probe-gpu-startup.mjs 10 barrier
echo "=== renderer switch"
for i in 1 2; do node ci-evidence/probe-renderer-switch.mjs raw; node ci-evidence/probe-renderer-switch.mjs barrier; done
echo "=== e2e"
npm run build:text-engine >/dev/null && npm run build:capture-script >/dev/null && \
  npx vitest run --config vitest.e2e.config.ts \
    src/capture/gpu-startup-barrier.e2e.test.ts tests/font-family-animation-provenance.e2e.test.ts
rc=$?
echo "e2e exit $rc"
exit $rc

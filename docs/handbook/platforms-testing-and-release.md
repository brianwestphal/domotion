---
id: "handbook/platforms-testing-and-release"
title: "Platforms, testing, and release handbook"
kind: "contract"
status: "current"
owners: ["platform-release"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2596"]
code: [".github/workflows/","tests/feature-coverage.ts","tools/parity-program.json","scripts/ci-run-fast-visuals.mjs"]
aliases: ["docs/handbook/platforms-testing-and-release.md"]
---

# Platforms, testing, and release handbook

## Contract

1. macOS, Linux, and Windows are first-class production platforms. The release
   artifact matrix may use either CPU architecture when the product contract is
   OS-level; evidence that depends on an architecture, font inventory, browser,
   helper, or renderer must fingerprint it explicitly.
2. Correctness is staged: source ownership, exact logical/intermediate records,
   negative activation and mutation controls, transition coverage, then visual
   integration. A screenshot percentage cannot overrule a logical mismatch.
3. Unit/line coverage is necessary but not sufficient. Stateful behavior needs
   multi-step transition tests, and every supported behavior maps to an entry in
   the feature/semantic/activation inventories.
4. Evidence is comparable only under authenticated source pins, binaries,
   helpers, browser/profile, fonts/preferences, corpus, and platform identity.
   Missing or mixed evidence withholds a verdict; it does not widen tolerance.
5. CI demos and release artifacts must be retained by platform. Optional
   evidence workflows remain optional until their exact contract is ratified.

## Verified implementation map

| Area | Requirements | Code and tests |
| --- | --- | --- |
| Feature coverage | [Behavior coverage](../83-feature-coverage.md), [semantic inventory](../136-semantic-coverage-inventory.md), [activation ledger](../137-specialized-path-activation-ledger.md) | `tests/feature-coverage.ts`, coverage check scripts |
| Parity stages | [Parity program](../129-chromium-parity-verification-program.md), [demo evidence](../140-demo-review-stage-evidence.md), [composed corpus](../183-composed-metamorphic-parity-corpus.md) | `tools/parity-program.json`, evidence collectors/gates |
| Platform calibration | [Fallback calibration](../42-cross-platform-fallback-calibration.md), macOS/Linux/Windows family oracles [109](../109-family-match-conformance.md), [110](../110-family-match-conformance-linux.md), [111](../111-family-match-conformance-windows.md) | native helpers and platform workflows |
| Release | [Visual CI](../66-ci-visual-tests.md), [release parity gate](../138-parity-release-gate.md), [Linux arm64](../196-linux-arm64-release-parity.md) | GitHub workflows, release/check scripts, retained artifacts |

The macOS-only SFNS exact terminal-mask comparison remains blocked evidence,
not a Windows or production-platform requirement.

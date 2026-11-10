---
id: "handbook/platforms-testing-and-release"
title: "Platforms, testing, and release handbook"
kind: "contract"
status: "current"
owners: ["platform-release"]
platforms: ["macos", "linux", "windows"]
tickets:
  [
    "DM-2596",
    "DM-2604",
    "DM-2635",
    "DM-2636",
    "DM-2664",
    "DM-0MAZSK",
    "DM-8P5PHJ",
    "DM-S9S3WG",
    "DM-34WC46",
    "DM-95ECD3",
    "DM-6TJDZ5",
    "DM-GQNPEN",
    "DM-PCT7GR",
    "DM-K85TST",
  ]
code:
  [
    ".github/workflows/",
    "scripts/materialize-source-authorities.mjs",
    "scripts/install-windows-profile-fixture-fonts.ps1",
    "scripts/run-e2e-tests.mjs",
    "scripts/e2e-native-logs.mjs",
    "tests/e2e-native-logs.test.ts",
    "tests/e2e-native-log-workflow.test.ts",
    "src/capture/debug-bundle.ts",
    "tests/animate-debug.e2e.test.ts",
    "tests/capture-debug-api.e2e.test.ts",
    "tests/e2e-lanes.ts",
    "tests/output-directory.mjs",
    "tests/output-directory.test.ts",
    "tests/real-world.tsx",
    "tests/real-world-webgl-preflight.ts",
    "tests/real-world-webgl-frame-geometry.ts",
    "tests/real-world-webgl-geometry.ts",
    "tests/real-world-webgl-projective-preflight.e2e.test.ts",
    "tests/review-server.tsx",
    "tools/compare-real-world-results.mjs",
    "tests/feature-coverage.ts",
    "tests/release-helpers-workflow.test.ts",
    "tests/release-workflow.test.ts",
    "tools/helper-release-consumer.ts",
    "tests/helper-release-consumer.test.ts",
    "tools/parity-program.json",
    "scripts/ci-run-fast-visuals.mjs",
    "vitest.e2e.config.ts",
  ]
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
5. CI demos, including the Unicode corpus, and release artifacts must be
   retained by platform so macOS, Linux, and Windows can be visually reviewed.
   Individual variations are traced through the relevant logical and native
   stages when observed.
6. Optional cross-collector evidence may remain diagnostic when it does not
   represent the product path end to end. In particular, byte equality between
   the standalone-Skia and instrumented-Chromium SFNS terminal-mask collectors
   is not a release-readiness requirement.
7. Release validation is reproducible from a clean tag checkout. It materializes
   every referenced upstream authority at the repository's immutable Chromium,
   Chromium-pinned Skia/ICU, HarfBuzz, and html-test revisions; installs the
   headless Playwright browser before browser-backed tests; and builds the
   primary-host native helper before the complete suite. Linux and Windows
   native assertions remain in their calibrated platform workflows rather than
   borrowing a bare runner's incidental fonts.
8. Native helper publication is downstream of GitHub Release creation. Staged
   binaries and checksums are retained before one fan-in upload, making an
   attach retry independent of expensive native rebuild/sign/notarize work.
9. The complete browser E2E gate is resource-partitioned rather than timeout-
   inflated: ordinary files run with bounded two-fork concurrency, while the
   measured heavy raster/oracle files run serially. A targeted file selection
   runs once in the safe serial lane, and every lane keeps the production
   persistent native-helper lifecycle enabled.
10. Real-world WebGL preflight includes visible canvas surfaces within current
    same-origin, cross-origin, and nested frame content boxes. It maps them to
    main-document screenshot coordinates without scrolling or pausing rAF,
    retaining the shared eight-surface, 512 px side, three-second discovery,
    and ten-second capture budgets. Browser-owned content quads authenticate
    rotated, skewed, reflected and supported projective owners; local-root
    homographies compose OOPIF coordinates, and convex ancestor clips are
    intersected before choosing a bounded screenshot rectangle. Unknown
    camera/clip authority is skipped; detached or unqueryable frames fail
    (DM-T64MNZ, DM-6TJDZ5; `tests/real-world-webgl-preflight.ts`). Successful
    capture requests alone do not authenticate paint in fully hidden
    cross-origin frames (DM-PCT7GR).

11. Real-world post-screenshot WebGL freeze observes Page-related dedicated
    worker startup and context-owned SharedWorker live calls, with bounded
    debugger commands and explicit restoration/disposal. New SharedWorkers can
    execute imports before Playwright's independent debugger resume is owned;
    cached native calls escape interception. Those targets report failures,
    and DM-S9S3WG remains blocked on DM-34WC46 for strict bootstrap coverage.
    Other BrowserContexts are resumed without patching.

## Offscreen frame projection

Browser-owned content quads and local-root homographies retain convex frame
clips before screenshot bounds. Unknown cameras and fully hidden cross-origin
presentation keep separate limits. [The CI testing record](../66-ci-visual-tests.md#offscreen-frame-projection)
retains source authority, lifecycle, native evidence and dispatch details.

## Visual output roots

`DOMOTION_OUTPUT_DIR` selects the visual suites' output root. An unset or empty
value keeps the script-anchored `tests/output` default; an absolute value is
retained, and a relative value resolves against the invocation's current
working directory. The real-world suite writes its PNG/SVG artifacts and
partially merged `results.json` under `<output-root>/real-world/`. A filtered
run reads and merges only that selected manifest, preserving other entries in
that root without reading or overwriting the canonical host manifest.

The demos review server follows the same root. A nonempty `REVIEW_OUTPUT_DIR`
takes precedence for its local source. CI review caches default to
`<output-root>/review/ci-<os>/`; a nonempty `REVIEW_CI_BASE` retains its explicit
precedence for those caches. The real-world comparison tool also reads the
selected root by default, while explicit result-path arguments take precedence.
Changing output roots does not relocate or rewrite HAR inputs in
`tests/cache/real-world/`, and it does not change rasterization or thresholds.

This shared path contract prevents an alternate baseline or Linux container
run from overwriting the host's visual evidence (DM-8P5PHJ). Use the manifest's
`generatedAt` and its actual output path when comparing runs.

## Verified implementation map

| Area                 | Requirements                                                                                                                                                                                                                                           | Code and tests                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Feature coverage     | [Behavior coverage](../83-feature-coverage.md), [semantic inventory](../136-semantic-coverage-inventory.md), [activation ledger](../137-specialized-path-activation-ledger.md)                                                                         | `tests/feature-coverage.ts`, coverage check scripts                                                                                 |
| Parity stages        | [Parity program](../129-chromium-parity-verification-program.md), [demo evidence](../140-demo-review-stage-evidence.md), [composed corpus](../183-composed-metamorphic-parity-corpus.md)                                                               | `tools/parity-program.json`, evidence collectors/gates                                                                              |
| Platform calibration | [Fallback calibration](../42-cross-platform-fallback-calibration.md), macOS/Linux/Windows family oracles [109](../109-family-match-conformance.md), [110](../110-family-match-conformance-linux.md), [111](../111-family-match-conformance-windows.md) | native helpers and platform workflows                                                                                               |
| Release              | [Visual CI](../66-ci-visual-tests.md), [release parity gate](../138-parity-release-gate.md), [Linux arm64](../196-linux-arm64-release-parity.md), [helper acquisition](../50-glyph-helper-acquisition.md)                                              | clean-checkout source materializer, primary-host validation, deterministic helper fan-in, release/check scripts, retained artifacts |
| Reproduction bundles | [Single capture](../55-debug-mode-capture.md), [animation frames](../237-animate-debug-reproduction-bundles.md), [programmatic capture](../238-programmatic-debug-capture-bundles.md)                                                                  | CLI filesystem helpers, in-memory capture artifacts, and headless E2E coverage                                                      |

The macOS-only SFNS exact terminal-mask comparison remains retained partial
evidence. It is not a Windows, production-platform, or release requirement;
visual SFNS variations are investigated individually when they appear.

## Native browser failure evidence (DM-95ECD3)

The macOS browser gate opts into `DOMOTION_E2E_NATIVE_LOG_DIR=tests/output/native-browser-logs`.
The E2E runner keeps its normal regular two-worker and heavy one-worker lanes;
filtered invocations remain one serial lane. With no opt-in, its original
synchronous inherited-stream execution is unchanged. Diagnostics use only
Playwright's public [`DEBUG=pw:browser`](https://playwright.dev/docs/ci#debugging-browser-launches)
namespace; they add no Chromium backend flags or retry rules and use no private
Playwright API or shared debug-file output.

Each opted-in lane forwards filtered live stderr and saves a bounded prefix
and suffix plus JSON metadata. Retention is limited to 8 MiB of filtered bytes
per lane (plus a short omission marker); incomplete lines are limited to 64 KiB.
Raw launch-command lines, sensitive header/environment dumps and oversized
lines are omitted before either new forwarding or retention. Metadata records
omitted-line counts, input versus filtered byte counts, the filtered-stream
SHA-256, truncation, timestamps, child status/signal and diagnostic failure.
It stores no executable arguments or environment values. A truncated file is
not complete native evidence, and missing diagnostic output is not proof that
no native error occurred.

The original nonzero child status wins over a secondary artifact failure;
spawn errors and signal termination remain failures. Catchable POSIX parent cancellation is
forwarded to the owned child, bounded cleanup finalizes available diagnostics,
and the runner restores the parent's signal result. [Node emulates kill signals
on Windows as unconditional termination](https://nodejs.org/api/process.html#signal-events);
that and uncatchable termination can leave incomplete diagnostic files. A successful child with
failed diagnostic output fails the opted-in gate rather than claiming complete
retention. Logs are observability, not an alternate success sentinel.

The existing always-upload macOS artifact includes both native lane logs and
`webgl-startup-e2e/`, where DM-C3HJHY saves the original context's phase states,
browser revision/GPU facts and a later source PNG when the strict iframe fixture
fails. Those are problem artifacts, not replacement references. A local normal
two-worker probe retained native stderr from the actual C3 controls and
neighboring files without exposing launch lines; it did not reproduce the
intermittent reset or establish a driver/backend cause. C3 remains unattributed
until a real loss witness can be correlated with native messages. Linux and
Windows artifact paths and launch behavior are unchanged.

## Published helper consumer validation

After a same-version helper refresh completes, dispatch
`helper-release-consumers.yml` on the desired consumer source ref. Supply the
existing release `tag` and the full helper `source_sha` recorded by the producer.
This workflow downloads published assets through the production acquisition APIs
into a private, newly created cache. It does not rebuild a native helper or
change a release, tag, npm package, or global cache.

The acquisition tool verifies the provenance sidecar, repository, exact source,
package version, complete five-asset inventory and fetched binary checksum. It
refuses inherited helper overrides. macOS also verifies the signature and
requires positive CoreText cap/x-height fields before running the normally
guarded SVG-root controls. An independently downloaded ICU companion must pass
its actual query probe.

The manual workflow runs macOS, Linux x64/arm64 and Windows x64/arm64 consumers.
Each then runs its platform's native Chromium image-unit/line-spacing controls;
Windows includes the discriminating bitmap/GDI case, and Linux includes the
hinted VDMX controls. Browser result validation requires actual passed assertions,
consistent counts and zero skipped/todo controls. Acquisition receipts alone
are not parity evidence: retain them together with each platform's browser JSON
and diagnostic PNGs. These focused checks do not replace broader release
validation or certify unrelated font-selection and shaping behavior.

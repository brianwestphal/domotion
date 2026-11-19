# Child-process bounds in unit tests

Several unit tests spawn short child processes: a `tsx` start of a tool that
must reject its arguments before doing work, a `node --import tsx` CLI round
trip, the E2E runner with a fake Vitest, or a Node writer feeding a diagnostic
stream. Under host load these failed at fixed wall-clock deadlines and passed
alone. This document records how the failures were attributed and how the
bounds are now derived. The verified-cleanup suite has its own progress
watchdog, described in [`tool-cleanup-tests.md`](tool-cleanup-tests.md).

## Attribution

Measured on a 15-core macOS host (Node 26) with 30 extra busy processes, while
a full `vitest run` executed (load average 40-105). A temporary probe test,
run inside that suite, timed each kind of child with `/usr/bin/time -l`, six
rounds each:

| child                                                     | CPU (user + sys) | wall in the loaded suite | wall / CPU |
| --------------------------------------------------------- | ---------------- | ------------------------ | ---------- |
| `tsx tools/<oracle>.ts --unknown`                         | 0.90-1.26 s      | up to 35.9 s             | up to 35x  |
| `tsx tools/crop-regions.ts --unknown`                     | 0.33-0.34 s      | up to 15.9 s             | up to 47x  |
| `node --import tsx tools/helper-availability-contract.ts` | 0.42-0.47 s      | up to 11.7 s             | up to 27x  |
| `node -e` writing 110 KB to stderr                        | 0.07-0.08 s      | up to 4.4 s              | up to 55x  |
| `node -e ""`                                              | 0.07-0.08 s      | up to 4.0 s              | up to 50x  |

The E2E runner chain (runner plus two fake Vitest lanes) used 0.28 s of CPU.
CPU time and major page faults stayed at their idle values; only wall time
grew, and every child exited with its normal status. The slowdown is a
reduced share of a core, not a stalled step. The same commands run from a
shell outside the suite took 1.2-2 times their CPU time at the same load. The
loaded suite gave them far less CPU because it competed with its own workers,
and because the pueue-launched suite ran at a lower Mach priority (20) than the
busy processes (31). The ratio
therefore depends on how the host is loaded, which is why a fixed idle-sized
deadline failed.

In three loaded full runs the original tests failed as follows:

- `tests/tool-oracle-cli-migration.test.ts` and
  `tests/tool-ac-cli-migration.test.ts`: Vitest's 30 s test timeout around
  `spawnSync` calls with no timeout of their own (up to 64.5 s for two
  spawns). A blocking `spawnSync` keeps Vitest from interrupting the test, so
  the timeout was reported only after the child had already exited normally.
  A genuinely hung child would have blocked the worker indefinitely.
- `tests/helper-availability-report.test.ts`: the same 30 s timeout over three
  CLI spawns (34.8 s).
- `tests/e2e-native-logs.test.ts`: the 10 s `spawnSync` timeout on the runner
  chain (killed at 10.2 s), and the 2 s post-close forwarding bound in the
  backpressure test, which is not attributed (see the last section).
- `tests/real-world-browser-diagnostics.test.ts`: the 2 s `finalize()` bound
  in both stream tests (see below).

## Bounds derived from CPU work

`tests/bounded-child.ts` runs these children asynchronously and stops one that
exceeds its budget (SIGTERM, then SIGKILL after 5 s), reporting `ETIMEDOUT`
with the child's status, signal, duration, budget and captured output. The
test worker's event loop stays live, so a hung child is stopped and reported
instead of blocking the worker.

Each budget is `LOAD_ALLOWANCE` (100) times the child's measured CPU work,
with a 30 s floor for the smallest children, whose fixed startup costs scale
worst. A child that itself starts further processes in sequence also gets
`PROCESS_START_ALLOWANCE_MS` (10 s) for each of them (see the third round
below); the process count is shown where it applies:

| caller                                               | CPU work used | budget per child |
| ---------------------------------------------------- | ------------- | ---------------- |
| tsx tool rejection (A-C and paint-oracle migrations) | 1.3 s         | 130 s            |
| helper-availability CLI                              | 0.5 s         | 50 s             |
| E2E runner chain, including the signal fixture       | 0.3 s         | 30 s (floor)     |
| Studio CLI help (umbrella and standalone)            | 1.2 s         | 120 s            |
| evidence-tool rejection (tsx bin)                    | 1.1 s         | 110 s            |
| real-world suite with no matching fixture            | 1.0 s         | 100 s            |
| glyph-tool import or rejection                       | 0.9 s         | 90 s             |
| real-world comparison tool (plain Node)              | 0.1 s         | 30 s (floor)     |
| font-conformance oracle rejection (`--import tsx`)   | 1.0 s         | 100 s            |
| changelog CLI over an empty range (13 processes)     | 0.3 s         | 150 s            |
| nested Vitest coverage run (CLI plus one worker)     | 0.9 s         | 100 s            |
| filtered html-test harness (`--import tsx`)          | 1.2 s         | 120 s            |
| shard merge script (plain Node)                      | 0.1 s         | 30 s (floor)     |
| source-drift producer (plus 3 revision lookups)      | 0.3 s         | 60 s             |
| source-drift comparator (`--import tsx` loader)      | 0.3 s         | 30 s (floor)     |
| fixture repository command (`git`)                   | under 0.05 s  | 30 s (floor)     |
| embedded release-workflow script (`node -e`, 2 proc) | 0.1 s         | 30 s (floor)     |

That leaves about 3.6 times headroom over the worst measured tsx ratio
(130 s against 35.9 s) and about 2 times over the worst ratio of the
smallest children, whose budgets sit on the floor (30 s for 0.28 s of CPU,
against 55 times CPU at worst). Each test's Vitest
timeout is the sum of its children's budgets plus the kill grace, so the
child's own diagnostic failure arrives before Vitest's generic timeout.
`tests/bounded-child.test.ts` pins the derivation, the stop of a child that
never finishes, the SIGKILL escalation on POSIX and the output limit.

## Second round: five more files with the same cause

Five more files failed in loaded full runs without having been attributed:
`tests/studio-cli-help.test.ts`, `tests/tool-cli-gl-migration.test.ts`,
`tests/tool-evidence-cli-migration.test.ts`, `tests/output-directory.test.ts`
and `src/capture/script/vertical-orientation.generated.test.ts`. They were
measured the same way, on the same host with 30 busy processes: alone and
unloaded, then inside a pueue-launched full `vitest run` (load average
43-77), with a temporary probe test timing each child kind with
`/usr/bin/time -l`, three rounds each.

| child or work                                      | CPU unloaded | CPU in the loaded suite | wall in the loaded suite |
| -------------------------------------------------- | ------------ | ----------------------- | ------------------------ |
| `node --import tsx src/cli/index.ts studio --help` | 0.80-0.86 s  | 1.15-1.17 s             | up to 29.4 s (25x)       |
| `node --import tsx` glyph-tool import or `--bogus` | 0.62-0.67 s  | 0.85-0.89 s             | up to 24.4 s (28x)       |
| `tsx tools/animated-culling-geometry-oracle.ts`    | 0.72-0.79 s  | 0.98-1.00 s             | up to 28.8 s (29x)       |
| `tsx tools/build-stage-evidence.ts --unknown`      | 0.20-0.23 s  | 0.29-0.32 s             | up to 11.2 s (39x)       |
| `tests/real-world.tsx --only <no match>`           | 0.65 s       | 0.87-0.89 s             | up to 23.1 s (26x)       |
| `node tools/compare-real-world-results.mjs`        | 0.05 s       | 0.08-0.09 s             | up to 2.5 s (32x)        |
| one per-scalar `expect` sweep (in-process)         | 1.63-1.67 s  | 1.78-1.85 s             | up to 29.7 s (16x)       |

CPU grew by about a third under load (cache and scheduler effects), but no
child stalled: every one exited with its normal status, and wall time grew
16-39 times. In a loaded full run of the original tests, every one of these
files failed:

- Studio help, glyph tools, evidence tools: Vitest's 30 s test timeout
  around blocking `spawnSync` calls without a timeout of their own (Studio
  32.7-66.3 s, glyph tools 48.4-69.2 s for two or three spawns, the culling
  oracle 64.4 s for two). As before, the timeout was only reported after the
  children had exited.
- `output-directory`: the 20 s `spawnSync` timeout on the real-world child
  (`ETIMEDOUT` at 20.3 s, for 0.9 s of CPU). The comparison child's 10 s
  timeout held in that run (the test took 5.2 s) but sat only four times
  above its loaded wall time.
- `vertical-orientation.generated`: no child at all. Each of the two sweep
  tests checked all 1,114,112 scalars with one `expect` call per scalar, which
  was about 1.6 s of CPU, while the same comparison without `expect` used
  0.04 s. Loaded, each test took 50.9 s and 56.3 s against the 30 s test
  timeout.

The four child-process files now use `runBoundedChild` with budgets from the
loaded CPU maxima (table above). The vertical-orientation sweeps still compare
every scalar, but collect mismatches (the first 32, as `U+XXXX expected
<bool>`) and assert the list is empty once, so the test does the work it
checks instead of 1.1 million assertion calls. In a second loaded full run all
22 tests in the five files passed: the child tests took 26-70 s within their
budgets, and the sweeps took 0.5-0.7 s. That run used budgets sized from the
unloaded CPU (80-110 s); they were then raised to the loaded maxima shown in
the budget table.

## Third round: per-process start latency, and an in-process helper sweep

Seven more files failed in a loaded full run: `src/index.exports.test.ts`,
`tests/changelog-analysis.test.ts`, `tests/coverage-map.test.ts`,
`tests/release-helpers-workflow.test.ts`, `tests/font-conformance-cli.test.ts`,
`tests/font-conformance.test.ts`, `tests/shard-completeness.test.ts` and
`tests/source-drift-report-cli.test.ts`. They were measured as in the second
round (same host, 30 busy processes, pueue-launched full `vitest run`, load
average 43-77): each child kind alone and unloaded, then three rounds inside
the loaded suite with `/usr/bin/time -l`. In-process work was timed with
`process.cpuUsage()`, and the compatibility-ideograph sweep as a nested
filtered Vitest run minus the same run with no matching test.

| child or work                                      | CPU unloaded | CPU in the loaded suite | wall in the loaded suite |
| -------------------------------------------------- | ------------ | ----------------------- | ------------------------ |
| `font-conformance.ts` argument rejection (tsx)     | 0.65-0.67 s  | 0.93-1.00 s             | up to 17.8 s (18x)       |
| `html-test-suite.tsx --only` (empty stride, tsx)   | 0.67-0.71 s  | 0.91-1.11 s             | up to 16.7 s (15x)       |
| nested `vitest run --coverage` fixture (via `npx`) | 0.54-0.55 s  | 0.77-0.83 s             | up to 21.4 s (26x)       |
| `changelog-analysis.mjs` over HEAD..HEAD           | 0.18 s       | 0.27-0.28 s             | up to 16.3 s (58x)       |
| `source-drift-evidence.ts` (tsx loader)            | 0.14-0.15 s  | 0.21-0.22 s             | up to 5.8 s (26x)        |
| `compare-roll-evidence.ts` (tsx loader)            | 0.12-0.15 s  | 0.18-0.21 s             | up to 3.3 s (16x)        |
| embedded release resolve script (`node -e`)        | 0.07 s       | 0.09 s                  | up to 2.6 s (29x)        |
| `merge-shard-results.mjs`                          | 0.07 s       | 0.08-0.09 s             | up to 1.6 s (18x)        |
| one `git commit` in a fixture repository           | under 0.01 s | under 0.01 s            | up to 1.5 s              |
| `ts.createProgram(src/index.ts)` plus exports      | 0.74-1.47 s  | 1.00-1.93 s             | up to 47.8 s (25x)       |
| compatibility-ideograph sweep, one-shot helper     | 1.7 s        | 2.6-2.7 s               | 158-380 s (nested run)   |

Every child exited with its normal status. Two findings go beyond the second
round's CPU model.

**Process starts cost wall time independent of CPU.** In the suite itself,
`changelog-analysis` took 52.9 s for one CLI child with 0.28 s of CPU (190
times its CPU): the CLI starts Node and then about 12 git queries in
sequence, and each start waited about 4 s to be scheduled. The release
workflow test started about 20 such children and took 60 s, and the
source-drift test, 9 repository commands plus 3 tsx tools, took 51 s. A
budget from CPU work alone, even with the 30 s floor, under-counts these, so
`budgetForCpuWork(cpuMs, processes)` adds `PROCESS_START_ALLOWANCE_MS` (10 s,
about twice the worst start latency observed for a small process) for every
process after the first. One-process budgets are unchanged.

**The compatibility-ideograph sweep was dominated by helper spawns.** The
unit config sets `DOMOTION_HELPER_NO_SERVE=1`, so each of its roughly 140
native-helper requests was a separate process. The helpers' CPU summed to
0.1-0.3 s, but in the loaded suite the test took 250 s against the 30 s
timeout, about 1.8 s per spawn. The test now clears that variable for its own
body, so its requests go through one persistent `--serve` child, and closes
the helper again (`clearGlyphHelperCache()`) before restoring the variable,
the same explicit lifecycle the E2E setup uses per file. The transport switch
is answer-neutral, which `helper-serve-switch.test.ts` pins. Unloaded the test
went from 1.6 s to 0.5-0.6 s.

Changes:

- `font-conformance-cli`, `changelog-analysis`, `coverage-map`,
  `shard-completeness`, `source-drift-report-cli` and
  `release-helpers-workflow` run every child through `runBoundedChild`
  (budgets in the table above), and each test's timeout is the sum of its
  children's budgets. Tests whose fixtures run git (`release-helpers-workflow`,
  `source-drift-report-cli`) bound each repository command too. The coverage
  test runs the Vitest CLI directly under Node rather than through `npx`, so
  it needs no shell on Windows.
- `index.exports`: no child. The checker program is in-process CPU work, so
  that test's timeout is 100 times its loaded CPU (200 s).
- `font-conformance` compatibility sweep: the persistent helper channel as
  described above, and a timeout of 100 times its loaded CPU (270 s).

In a second loaded full run all of these passed: `index.exports` took 46.9 s,
the compatibility sweep 44.1 s, the html-test harness test 51.2 s, the
changelog CLI 40.8 s, the source-drift test 46.9 s, the slowest release
workflow test 35.0 s and the oracle preflight test 40.8 s, each within its
derived bound. `tests/ci-font-conformance-shard.test.ts` and
`tests/font-conformance-synthetic-stacks.test.ts` passed in both runs (at most
22.8 s and 13.5 s) and were not changed.

## A bound that was timing the wrong interval

`captureOwnedBrowserDiagnostics().finalize()` waits up to 2 s for the owned
browser's stderr to close. Production calls it only after stopping the
browser, so the bound covers the post-exit drain. Two tests called it right
after spawning their writer, so the bound also timed the writer's whole Node
startup (up to 4.4 s loaded). They now wait for the child's `exit` (not
`close`) first, so the drain bound still runs as it does in production. The
never-closing-stream test still pins the bound itself. The production bound is
unchanged.

## Not attributed: the native-log forwarding flush

`runWithNativeLog()` waits up to 2 s after the child closes for forwarded
output to flush, and the backpressure test asserts that this bound does not
expire. It failed in two of the three loaded full runs (test durations 4.6 s
and 7.5 s). Instrumenting the fixture showed that every one of its 100 line
writes had already completed when the post-close flush write was issued: the
stream is paused until `drain`, so the child cannot close while forwarding is
queued. The bound therefore times a single write completion. Completing the
fixture's writes on `setImmediate` instead of a 1 ms timer did not help; the
test failed again in a fourth loaded run (6.0 s). The interval contains no
load-scaled fixture work, so the expiry indicates that the test worker got no
event-loop turn for about 2 s, which is plausible for a deprioritized process
at that load but was not directly observed. No test
change makes that interval independent of scheduling; doing so would mean
changing the production bound (for example making it injectable, or measuring
flush progress instead of wall time). That is a production decision, so the
test is unchanged.

No retry, concurrency change or production timeout change was made.

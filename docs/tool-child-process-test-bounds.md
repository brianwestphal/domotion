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
  backpressure test (see the last section).
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

## Fourth round: helper spawns, a sampler and two timing assertions

Six more files failed in loaded full runs (30 busy processes on 15 cores,
load average 43-77): `tests/shaping-default-ignorable-logical.test.ts`,
`tests/tool-cli-migration.test.ts`, `tests/tool-check-cli-migration.test.ts`,
`src/verified-worktree-cleanup.test.ts`,
`tests/real-world-browser-diagnostics.test.ts` (the real `sample` test) and
`src/capture/install-chromium.test.ts` (the wedged-installer test). Two more
passed with thin margins: `tests/ci-font-conformance-shard.test.ts` and
`tests/font-conformance-synthetic-stacks.test.ts`. They were measured as in
the earlier rounds: alone and unloaded, then inside a pueue-launched full
`vitest run` with the same 30 busy processes (load average 63-80), with a
temporary probe test timing each child kind with `/usr/bin/time -l`, three
rounds each. The verified-cleanup child was timed the same way inside its
own test, with its overall cap raised for the measurement.

| child or work                                        | CPU unloaded             | CPU in the loaded suite | wall in the loaded suite |
| ---------------------------------------------------- | ------------------------ | ----------------------- | ------------------------ |
| `tsx tools/compare-roll-evidence.ts`                 | 0.22-0.25 s              | 0.29-0.32 s             | up to 11.8 s (37x)       |
| `tsx tools/check-semantic-coverage.ts`               | 0.23-0.26 s              | 0.31-0.33 s             | up to 12.1 s (37x)       |
| the roll comparison, timed inside its test           | 0.35-0.36 s              | 0.32-0.33 s             | up to 12.1 s (37x)       |
| the semantic inventory, timed inside its test        | 0.41 s                   | 0.37 s                  | 35.7 s (97x)             |
| shard script, single attempt (stubbed sweep)         | 0.01 s                   | 0.01-0.02 s             | up to 4.6 s              |
| shard script, three drifted attempts (stubbed sweep) | 0.03-0.04 s              | 0.04-0.05 s             | up to 7.2 s              |
| `node -e ""` (the installer stand-in)                | 0.06-0.07 s              | 0.07-0.08 s             | up to 3.1 s (39x)        |
| the six shaping rows, one-shot helper (tsx)          | 1.22-1.24 s              | 1.66-1.69 s             | 72-77 s                  |
| the six shaping rows, persistent helper (tsx)        | 1.05-1.11 s              | 1.44-1.60 s             | 28-41 s                  |
| `/usr/bin/sample <node pid> 1`                       | 0.13-0.17 s (1.2 s wall) | 0.17-0.20 s             | 13-22 s                  |
| synthetic corpus checks, one `expect` per stack      | 0.27-0.33 s              | 0.33-0.37 s             | 3.7-9.2 s                |
| the same checks, collected and asserted once         | 0.04-0.06 s              | 0.04-0.07 s             | 0.6-1.2 s                |
| verified-cleanup child tree (about 2,720 git calls)  | 23.8 s (26.8 s wall)     | 38.8 s                  | 1,101 s (28x)            |

Every child exited with its normal status. Inside the same loaded run the
unchanged tests behaved as follows: the first shaping row failed at 33.5 s,
the two `tsx` CLI tests took 23.4 s and 20.8 s, the real `sample` test 19.4 s
under its 25 s bound, the slowest shard test 7.7 s (the file 72.9 s), the
slowest synthetic test 8.3 s, and the verified-cleanup child 1,101 s. The
installer test passed in that run.

Findings by file:

- **Shaping rows.** The six rows made 31 one-shot glyph-helper processes (and
  four ICU helper processes), so most of their loaded wall time was process
  starts, as in the third round's compatibility sweep. The file now takes the
  persistent helper for its whole scope through `usePersistentGlyphHelper()`
  (`tests/persistent-glyph-helper.ts`, which closes it when the file ends;
  both persistent-channel tests use that module, and a policy test rejects a
  hand-written toggle of `DOMOTION_HELPER_NO_SERVE`); a spawn trace of the file shows
  one `--serve` helper in place of the 31 one-shot runs. The remaining
  in-process work is CPU-bound, so each test's timeout is 100 times the
  loaded CPU of all six rows (170 s).
- **Roll comparison and semantic inventory.** Blocking `spawnSync` calls of
  the `tsx` CLI under Vitest's 30 s timeout, three in one test, as in the
  first round. Each now runs through `runBoundedChild`. Timed inside the
  tests themselves (Vitest sets a different environment from the probe), each
  run used 0.32-0.41 s of CPU idle or loaded. The roll comparison took up to
  12.1 s a run in the loaded suite (37 times its CPU), but the semantic
  inventory took 35.7 s for 0.37 s of CPU (97 times), matching the 36 s
  failure. The difference is not CPU: the inventory checks 894 repository
  paths with one awaited `access()` call after another, and each round trip
  through the thread pool waits for the main thread to be scheduled again,
  about 40 ms each under that load. Its budget therefore adds 100 ms (2.5
  times that) per path to the CPU-derived budget, with the path count read
  from `tools/semantic-coverage.json`, so it grows with the inventory.
- **Shard script.** Under 0.05 s of CPU but 8-20 short processes per run
  (bash, `mkdir`, the stubbed recorders and sweep, and on the macOS path
  `cat`, `mv` and up to three attempts), so its budget counts process starts.
  Every run goes through `runBoundedChild`, and each test's timeout sums its
  runs' budgets.
- **Synthetic corpus.** No child: three checks over all 50,544 stacks made
  one `expect` call per stack (about 200,000 in total). They now collect the
  stacks that break the rule (the first 32) and assert once, as the
  vertical-orientation sweeps do since the second round.
- **The real `sample` test.** `sample <pid> 1` waits out a one-second
  sampling window even idle (1.2 s of wall time for 0.13-0.17 s of CPU, and
  2.2 s with a cold symbolication cache, which every CI VM has). Inside the
  loaded suite it took 13-22 s for 0.2 s of CPU in the probe, 19.4 s in the
  unchanged test, and 62.1-84.0 s in the later loaded runs below: up to 400
  times its CPU, far past the allowance, while still finishing normally. One loaded sample
  held only 17 stack samples against 824-832 idle, so the sampling window was
  not what grew; the time went to waiting to be scheduled. Its budget is
  therefore 100 times its cold idle wall time (220 s) rather than its CPU.
  What the test checks is unchanged: a real sampler run is recorded as
  `captured`, with a scrubbed call graph. The bound's expiry is still pinned
  by the test whose sampler never settles.
- **The wedged installer.** The test asserted more than five 10 ms timer
  ticks during the 300 ms kill deadline. What it means to check is that the
  installer wait is asynchronous: the old untimed `spawnSync` blocked a
  library caller's event loop. Counting ticks measured the worker's share of
  a core instead, and a loaded worker saw exactly five (`expected 5 > 5`).
  The test now queues a `setImmediate` right after the call and requires the
  call to still be pending when it runs, then requires the rejection that
  names the deadline. Replacing the wait with a blocking `spawnSync`
  (temporarily, as a negative control) fails the new check: the call has
  already settled when the event loop next turns.
- **Verified cleanup.** The 300 s overall cap failed a healthy child: it
  completed in 1,101 s with exit 0, and its longest silence between progress
  records was 7.3 s against the 60 s stall bound. The cap is now 100 times
  the child tree's loaded CPU (3,900 s); the stall watchdog remains the hang
  check ([`tool-cleanup-tests.md`](tool-cleanup-tests.md)). Its roughly 2,720
  git starts are not counted separately: their cost is inside the measured
  CPU, and the loaded wall time was 28 times that CPU, within the allowance.

| caller                                                 | work used                                 | budget        |
| ------------------------------------------------------ | ----------------------------------------- | ------------- |
| roll comparison (`tsx` CLI)                            | 0.36 s CPU, 2 processes                   | 46 s per run  |
| semantic inventory (`tsx` CLI)                         | 0.4 s CPU, 2 processes, 894 awaited paths | 139 s         |
| shard script, single attempt                           | 0.05 s CPU, 8 processes                   | 75 s per run  |
| shard script, up to three attempts                     | 0.05 s CPU, 20 processes                  | 195 s per run |
| macOS `sample` in the real sampler test                | 2.2 s cold idle wall time                 | 220 s         |
| stalled scout child around that sample                 | 0.08 s CPU                                | 30 s (floor)  |
| shaping rows, per test (in-process, persistent helper) | 1.7 s CPU                                 | 170 s         |
| verified-cleanup overall cap                           | 39 s CPU                                  | 3,900 s       |

In two more loaded full runs with these changes, all eight files passed. The
second run used earlier budgets (120 s for `sample`, 43 s per `tsx` CLI run),
and the third the final ones except the two `tsx` CLI budgets, set to 120 s
while their in-test timing was taken:

| test                             | second run | third run |
| -------------------------------- | ---------- | --------- |
| first shaping row                | 9.6 s      | 8.5 s     |
| roll comparison (three CLI runs) | 24.5 s     | 29.7 s    |
| semantic inventory CLI           | 23.8 s     | 35.7 s    |
| real `sample` test               | 62.1 s     | 84.0 s    |
| verified-cleanup child           | 928 s      | 1,174 s   |
| slowest shard test               | 11.7 s     | 13.2 s    |
| slowest synthetic-corpus test    | 8.0 s      | 6.3 s     |

The slowest synthetic-corpus test is now "is byte-identical across
regenerations", which builds and serializes the corpus four times (0.28 s of
CPU idle) rather than looping over `expect`, and is unchanged. The thinnest
remaining margin is the real `sample` test, at 2.6 times its 84 s maximum.

Other tests failed in these loaded runs and are not attributed here:
`tests/e2e-native-logs.test.ts` (the forwarding flush described below),
`tests/family-match-transient-report.test.ts` in all three runs (the CLI
test exited 2 at 121.7-123.1 s, just past its 120 s `spawnSync` timeout, and
in the third run the `--max-families 0` rejection test also reached the 30 s
test timeout), and, in the third run only,
`tests/variable-axis-fixture.test.ts` ("keeps production TypeScript free of
literal NUL bytes", 50.8 s) and
`tests/vertical-decoration-browser-oracle.test.ts` (its 60 s timeout).

## Fifth round: a 45-process CLI, a browser oracle and a sequential tool

Measured as before. The unloaded numbers were taken while other work held the
host's load average near 24, so they are not truly idle. The loaded numbers
come from a full `npx vitest run` with 30 busy processes (load average
61-73). The last column is the real test in that loaded run, with these
changes applied.

| work                                     | CPU unloaded | wall unloaded | CPU loaded  | wall loaded | test, loaded            |
| ---------------------------------------- | ------------ | ------------- | ----------- | ----------- | ----------------------- |
| family-match CLI, 40 families            | 2.1 s        | 2.9-4.7 s     | 2.2-2.3 s   | 29-128.5 s  | 110.1 s                 |
| `--max-families=0` rejection             | 0.90-0.96 s  | 0.9-1.3 s     | 0.91-0.96 s | 8.8-21.8 s  | 19.1-27.2 s each        |
| vertical decoration oracle (browser)     | 1.5-1.7 s    | 1.6-2.1 s     | 1.5-1.6 s   | 12.2-54.8 s | 23.2 s                  |
| NUL scan, 980 files                      | 36-71 ms     | 36-86 ms      | 38-48 ms    | 0.19-1.4 s  | 0.65 s                  |
| synthetic corpus, built 6 times          | 0.47-0.62 s  | 0.39-0.49 s   | 0.50-0.55 s | 3.4-10.3 s  | 3.8 s (2 builds)        |
| semantic inventory CLI, after the change | 0.36 s       | 0.54 s        | not sampled | not sampled | 7.0 s (was 23.8-35.7 s) |

Findings by file:

- **Family-match transient report.** The CLI starts about 45 processes (Node,
  one one-shot glyph-helper run per family for 40 families, and Chromium's
  processes), so its loaded wall time reached 128.5 s and crossed the old
  120 s `spawnSync` timeout. The "exit 2 with empty stderr" was that timeout:
  Playwright's SIGTERM handler closed the browser, and the CLI's main routine
  then exited with its generic error status. Both tests now run through
  `runBoundedChild`; the rejection tests also assert the child was not killed
  by its budget. The four rejection runs took 19-27 s each loaded, which
  explains the earlier 30 s test timeout.
- **Vertical decoration oracle.** One tsx start plus a browser reached 54.8 s
  for 1.6 s of CPU against a fixed 60 s timeout. Its timeout is now derived
  from that work.
- **Synthetic stacks, byte-identical regenerations.** The test built the
  50,544-stack corpus six times. It now builds two independent corpora and
  makes the same three assertions on them. The corpus builder has no
  memoization, so the determinism check means the same thing.
- **Semantic inventory.** `tools/semantic-coverage.ts` awaited about 900
  `access()` calls one after another, so a loaded host spent about 40 ms
  rescheduling after each. It now checks every in-repository path
  concurrently before validating the rows; the validation loop and the order
  of its errors are unchanged (pinned by a new test in
  `tests/semantic-coverage.test.ts`), and paths that escape the repository
  are still never checked. The per-path term in its CLI budget modeled the
  sequential awaits and is removed. The remaining 50 s budget rests on one
  loaded sample (7.0 s).
- **NUL scan.** Not reproduced. In the loaded suite the scan took 0.65 s and
  every read came from the page cache. The one 50.8 s timeout is not
  attributed; a cold page cache with each blocking read waiting to be
  rescheduled would fit (980 reads at about 50 ms), but that was not
  observed. The test is unchanged.

| child                                     | CPU work | processes | budget |
| ----------------------------------------- | -------- | --------- | ------ |
| family-match transient-report CLI         | 2.2 s    | 45        | 660 s  |
| family-match `--max-families` rejection   | 1.0 s    | 1         | 100 s  |
| vertical decoration oracle (test timeout) | 1.7 s    | 6         | 220 s  |
| semantic-coverage inventory CLI           | 0.4 s    | 2         | 50 s   |

## A bound that was timing the wrong interval

`captureOwnedBrowserDiagnostics().finalize()` waits up to 2 s for the owned
browser's stderr to close. Production calls it only after stopping the
browser, so the bound covers the post-exit drain. Two tests called it right
after spawning their writer, so the bound also timed the writer's whole Node
startup (up to 4.4 s loaded). They now wait for the child's `exit` (not
`close`) first, so the drain bound still runs as it does in production. The
never-closing-stream test still pins the bound itself. The production bound is
unchanged.

## The native-log forwarding flush

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
change makes that interval independent of scheduling, so the bound is now an
injectable `flushTimeoutMs` option whose default stays 2 s for the CI wrapper.
The backpressure test, which is about forwarding and retention rather than the
deadline, passes a load-scaled bound (`budgetForCpuWork`). A separate test pins
the deadline itself with a destination that never completes the final flush
write and a 50 ms bound.

No retry, concurrency change or production timeout change was made.

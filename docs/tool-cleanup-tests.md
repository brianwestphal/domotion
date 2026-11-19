# Verified-cleanup test ownership and fixture cost

`src/verified-worktree-cleanup.test.ts` runs the real Node test file
`scripts/verified-worktree-cleanup.test.mjs` under a progress watchdog: the
child fails as `ESTALLED` if its progress trace is silent for 60 seconds (unless
the trace has reported its own truncation), and as `ETIMEDOUT` after 3,900
seconds overall (100 times the child tree's loaded CPU time; see the last
section), with a 4 MiB output limit (`ENOBUFS`). Windows retains its
portable-selection filter; POSIX hosts execute every Git fixture and refusal.
The production cleanup adapter, exact-tree receipts, ownership checks and
deletion refusals are unchanged by DM-GRZJPV.

Three pristine histories cover ordinary, legacy-layout and cherry-picked
integration. Each is prepared once per test process, before any linked
worktree registration exists. Each case copies its own project and bare remote
with `fs.cpSync`, then creates real native linked source/validation worktrees
and performs its own exact-tree gate. Objects, refs, index and remote remain
independent; there are no shared object hardlinks, alternates or cached gate
receipts. Hooks and origin paths are rebound to the case's private directories.
The independence regression checks object inode/link counts, worktree
registrations, origin paths and isolated mutations. Case and seed directories
are removed through their owning Node test hooks, including failed setup.

The wrapper enables `DOMOTION_CLEANUP_TEST_PROGRESS=1` only for its child.
Synchronous stderr records contain a bounded case name, command counter,
allowlisted operation and paired start/return timing. They omit arguments,
paths, source bodies and environment values. Every admitted return includes its
duration/status, even when fast; a missing return is an observation gap, not
proof of a native hang. Copy/teardown and the adapter's already-reached gate
phases bracket work outside native calls. The child emits its own PID/parent,
runtime and monotonic elapsed time; the wrapper retains its actual supervisor
PID, elapsed/wall-clock bounds, status/signal/error and captured byte counts.
The process-exit marker means its callback ran, not that descendant or stdio
closure was independently authenticated.

`scripts/cleanup-test-progress.mjs` admits at most 4,096 native pairs and uses a
2 MiB byte budget, reserving 2 KiB for one truncation notice and completion/exit
summaries. After the normal byte cap, it does no normal encoding, clock read or
write; omitted counters remain visible in the reserved summaries. Case phases
remain admitted after the native-command limit while normal byte space remains.
Summary byte counts explicitly precede their own record. Diagnostic write
failure cannot throw over the underlying assertion. All output remains subject
to the wrapper 4 MiB limit, which fails on overflow. The Node
supervisor forwards synchronous records even when ordinary TAP is buffered.

DM-BEMV41 records a recurrence on source `8a599821` after the warm-fixture
optimization: the last observed start was native command 2,673 in the replaced
generated-inode refusal case. The old format omitted fast returns and elapsed
time, so it cannot distinguish accumulated work, an active native call, file
work or teardown. An unchanged narrow control passed in 19.66 seconds. That
does not attribute the full-lane deadline to PJ, Node or scheduling. The new
phase evidence preserved all 75 cases, platform selection, the then-current 90/95-second bounds,
30-second default native-command bound and every production authorization check;
the cause remains unresolved until an actual trace supports attribution.

An unchanged macOS Node 22.21.0 observation executed 74 cases (73 passed and one
platform skip), making 3,436 native commands in approximately 36 seconds. About
35 seconds were inside native commands; none exceeded 71 ms. The Node 26
focused wrapper took 34.67 seconds before preparation reuse and 21.78 seconds
after it. These are local measurements, not hosted-run performance guarantees.
The changed Node 22 suite executed 75 cases (74 passed and the same platform
skip), including the new independence control, with 2,720 native commands in
20.27 seconds. Its progress/TAP output was 236,436 bytes within the existing
output limit. Every original case and assertion remains selected.
The historical Node 22 CI failures retained only `TAP version 13` at the
90-second timeout. Normal synchronous execution also buffered TAP results, so
that header cannot locate a stalled first fixture or establish host contention.

A bounded Node 22 synthetic timeout cleaned its test child in both supervisor
and direct-file modes. The existing `--test` supervisor is retained; no orphan
or supervisor cause is claimed. Node's documented
[test execution model](https://github.com/nodejs/node/blob/v22.21.0/doc/api/test.md#test-runner-execution-model)
explains the separate child, and its
[test module contract](https://github.com/nodejs/node/blob/v22.21.0/doc/api/test.md#test-runner)
defines exit failure semantics. Exact hosted attribution still requires a
source-qualified recurrence with the new stage evidence. No retry, global
concurrency, environment dump or production-security bypass is added.

## Attribution: host load, not a hang (DM-BEMV41)

The recurring wrapper timeout was a fixed 90-second wall-clock deadline
measuring host load. Under 30 busy-loop processes on a 15-core macOS host (load
about 35), the unchanged 75-case child took 94 seconds against about 19 seconds
idle. Its trace showed the slowdown spread evenly: each of the 2,720 native
Git calls had a median near 33 ms, the slowest was a 106 ms `push`, and the
calls summed to the full wall time. Local full-suite recurrences under similar
load matched this (the same file passed alone in 65 seconds).

A hang is now defined by what the child stops doing rather than by elapsed
time. The `--test` supervisor forwards progress records live; idle, the longest
gap between them was 153 ms, so the 60-second silence bound has wide headroom.
The watchdog sends SIGTERM, as `spawnSync`'s timeout did, so the supervisor
still cleans up its test-file child. Under the same 30-process load, the
wrapper passed in 110 seconds. Two controls pin the watchdog: a child that goes
silent is stopped as `ESTALLED`, and one that reports trace truncation is left
to finish. The production adapter, the 30-second native-command bound, all 75
cases and the Windows selection are unchanged.

## The overall cap was also load-scaled

The 300-second overall cap that replaced the 90-second deadline was still a
fixed wall-clock bound over the same work, and it failed both loaded full
`vitest run` passes (30 busy processes on 15 cores, load average 43-77). With
the cap raised for measurement, the child completed in 1,101 seconds inside
such a run with exit status 0. Its longest gap between progress records was
7.3 seconds, so the stall watchdog had at least eight times headroom
throughout. Its process tree (the `--test` supervisor, the test file and every
Git call) used 24 seconds of CPU idle, with 27 seconds of wall time, and 39
seconds inside the loaded run. Wall time grew 28 times its CPU time, the same
reduced share of a core recorded for the child-process tests in
[`tool-child-process-test-bounds.md`](tool-child-process-test-bounds.md).

The cap is therefore derived from CPU work like those bounds: 100 times the
loaded 39 seconds, 3,900 seconds. The progress watchdog remains the hang
check. The cap only stops a child that keeps reporting progress without
finishing, or one whose trace has reported truncation, after which the
silence check stands down by design.

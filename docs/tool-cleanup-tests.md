# Verified-cleanup test ownership and fixture cost

`src/verified-worktree-cleanup.test.ts` runs the real Node test file
`scripts/verified-worktree-cleanup.test.mjs` with the existing 90-second child
bound, 95-second Vitest bound and 4 MiB output limit. Windows retains its
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
to the unchanged wrapper 4 MiB limit, which fails on overflow. The Node
supervisor forwards synchronous records even when ordinary TAP is buffered.

DM-BEMV41 records a recurrence on source `8a599821` after the warm-fixture
optimization: the last observed start was native command 2,673 in the replaced
generated-inode refusal case. The old format omitted fast returns and elapsed
time, so it cannot distinguish accumulated work, an active native call, file
work or teardown. An unchanged narrow control passed in 19.66 seconds. That
does not attribute the full-lane deadline to PJ, Node or scheduling. The new
phase evidence preserves all 75 cases, platform selection, 90/95-second bounds,
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
source-qualified recurrence with the new stage evidence. No retry, timeout,
global concurrency, environment dump or production-security bypass is added.

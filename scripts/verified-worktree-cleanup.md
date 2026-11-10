# Verified Domotion worker-worktree cleanup

`verified-worktree-cleanup.mjs` supports DM tickets and both reviewed native
subagent worktrees (`domotion-hs-<suffix>`, branch `hs/dm-<suffix>`) and direct
`.claude/worktrees/dm-<suffix>` worktrees. It is a local maintenance tool, not a
renderer or package-install requirement. It uses the installed `hotsheet-cli`,
Git, authenticated `gh`, and `lsof`; missing capabilities refuse cleanup.
macOS and Linux can supply the `lsof` idle witness. Windows without that witness
refuses removal; this does not change Windows rendering or native validation.

The default action is **read-only inspection**. There is no force, skip-CI,
skip-gate, or layout-bypass option. Only the integrator executes cleanup, after
the worker has handed off, released its claim, and retired its session. This
implementation was tested against disposable repositories; its development
does not authorize deleting any retained real worker checkout.

## Prepare authority

1. Synchronize the selected ticket store using the normal Hot Sheet workflow.
   Confirm `hotsheet-cli checkout resolve <main>` binds that exact canonical
   store to the code checkout. The adapter qualifies the DM slug by project,
   connection, and ticket ULID; it never assumes `.hotsheet2/store` exists.
2. Review the source commit against its integrated shipping commit, including
   conflict resolutions. Confirm the worker session has ended, all references
   and private artifacts are accounted for, and the ticket is completed,
   verified, or archived. The selected store's exact ticket claim must be
   absent or demonstrably expired. Unknown expiry refuses cleanup.
3. Add a regular note to that ticket with the following fenced JSON. Supply
   actual full SHAs, canonical paths, and the qualified ticket returned by the
   binding. Use the same explicit Hot Sheet actor ID as `reviewer`. This is an
   integrator attestation of code review and session retirement, not a claim
   that an empty coordinator summary proves ownership.

````markdown
```domotion-cleanup-review
{
  "version": 1,
  "qualified_ticket": "@domotion-project-id/connection-id:TICKET_ULID",
  "source_worktree": "/private/tmp/domotion-hs-abc123",
  "source_branch": "hs/dm-abc123",
  "source_commit": "FULL_40_CHARACTER_SOURCE_SHA",
  "shipping_commit": "FULL_40_CHARACTER_SHIPPING_SHA",
  "reviewer": "integrator-actor-id",
  "worker_retired": true,
  "integration_verified": true,
  "stashes": [],
  "native_evidence": []
}
```
````

`stashes` is the explicit full-SHA inventory from the handoff, including safety
stashes already applied but intentionally retained. Use `[]` only after checking
that this handoff has none. Global stash entries are never applied, dropped, or
rewritten. `native_evidence` lists required platform run URLs/artifact references;
an empty list states that no additional native run applies to this ticket. The
adapter retains these references without substituting them for CI or pretending
to adjudicate platform fidelity.

Registered coordinator pools must be quiescent: all assignments Done, no recovery,
and no live workers. Unknown schemas or missing authority fields refuse. Legacy
native subagents use the exact reviewed retirement attestation above, the exact
store claim, and the idle handle witness. In particular, a provider reporting
`queue_observed: false`/`claim_verification: false` with empty `live_claims` does
not establish an unclaimed ticket.
Inspection checks the CLI's non-opening `coordination capabilities` command and
reads existing schema 3–5 state directly, including raw worker lease expiries.
It never invokes `coordination status`/`setup`, creates a pool, upgrades its schema,
or relies on the status summary that can omit workers holding active assignments.
Newer schema contracts require explicit adapter support before cleanup.

## Produce exact gate evidence

Use an existing clean, registered **isolated** validation checkout at the full shipping SHA
with the normal dependencies, pinned source authorities, browser and native
helper prerequisites. It shares the main checkout's Git common directory. Do
not stash, reset, or normalize the user's dirty main checkout for this purpose.
The gate command runs fixed `npm run build`, `typecheck`, `lint`, and `test`
commands, in that order. Each must exit successfully while HEAD, all other
tracked files and untracked source state remain unchanged. The narrowly bounded
generated-comment contract below is recorded explicitly. No user-supplied command or handwritten
"passed" marker can substitute for this receipt. Existing receipts from other
tools do not qualify. An adapter source change invalidates earlier receipts.

The full gate takes minutes, so use pueue with the repository's normal approval
and bounded-wait rules:

```sh
pueue add -p -l dm-cleanup-exact-gate -- node scripts/verified-worktree-cleanup.mjs --gate --project /path/to/main --validation /path/to/clean-validation --shipping FULL_SHIPPING_SHA
pueue-wait-cond TASK_ID --timeout 30m --fail-on-error
pueue log TASK_ID -l 40
```

The private receipt binds the tool version, commit, tree and four successful
commands under the shared Git common directory. It does not replace visual or
platform checks required by the ticket. Progress identifies each gate without
printing its contents; private per-command stdout/stderr logs are retained in
`domotion-cleanup-gates/logs/<tree>/<run>/` for failed-gate diagnosis.
An exclusive tree lock prevents concurrent gate writers, and a rerun immediately
invalidates previous success. A failed rerun cannot reuse an older green receipt.
An interrupted gate's remaining lock refuses cleanup until the integrator reviews
the actual process and private logs; do not delete a lock to bypass running work.

### Explicit generated-comment contract

Current capture generation includes two esbuild source-path comments whose
prefixes depend on checkout/dependency layout (tracked independently by
**DM-WREGPJ**). The integrator authorized this specific gate contract; it is not
a general normalization rule. The validation checkout must differ from the main
checkout and start completely pristine. Its regular, single-link, tracked
`src/capture/script.generated.ts` is fingerprinted before any gate. The main
checkout's original user-dirty artifact is never eligible.

After each command, the only permitted dirty entry is that artifact with exactly
both known path comments changed: `packages/text-engine/dist/capture/script/emoji-detect.js`
and `packages/text-engine/dist/font-family-stack.js`. Each occurs exactly once.
The complete wrapper/header, canonical JSON string encoding, every other decoded
program byte and the two line positions must remain identical. A one-line change,
another comment, functional change, alternate JSON escaping, symlink, replacement
inode, permission change, or any other tracked/untracked mutation refuses.

Only after all four gates succeed does the tool retain the changed bytes in its
private evidence directory and restore the exact pristine bytes through the
verified original file descriptor. Identity/content checks before restoration
and a final clean-tree check reject observed races; keep this owned validation
checkout exclusive until the operation finishes. Failures leave the artifact and
private evidence available for investigation. It never restores from main or
discards arbitrary generated changes.

The completed per-run record is created once with exclusive creation under
`domotion-cleanup-gates/records/<tree>/<run>.json`. It records each command's raw
before/after hashes, normalized program hash and exact allowed-line witnesses.
The current receipt points to that immutable record by its hash; inspection must
verify both. New attempts invalidate the current receipt without overwriting
earlier completed records. Pre-gate and accepted post-gate bytes remain private
alongside command logs, including when later validation refuses cleanup.

## Inspect, then explicitly execute

```sh
node scripts/verified-worktree-cleanup.mjs --project /path/to/main --store /path/to/domotion.hs2 --ticket DM-ABC123 --worktree /private/tmp/domotion-hs-abc123 --shipping FULL_SHIPPING_SHA --review-note REVIEW_NOTE_ULID
```

Inspection writes nothing. `ready` means the current evidence qualifies, not
that removal has happened. For actual cleanup, repeat the same command with
`--execute`. Large inventories and preservation copies also belong in pueue.
Do not execute while another session is using or starting in that checkout.

Both actions require the exact registered, canonical, non-main linked checkout,
matching branch and HEAD, no lock/prune/detached state, a clean source tree, and
an unambiguous idle `lsof +D` result (exit 1 with empty stdout and stderr). A
missing tool, permission warning, timeout, live handle or uncertain process state
refuses removal. Paths aliased through symlinks refuse; use the canonical path.
Assume-unchanged/skip-worktree index flags and submodule checkouts also refuse;
ordinary `git status` alone could hide unique tracked edits behind those flags.

The adapter reads fresh `origin/main` with `ls-remote` without silently fetching or
pushing. It binds every GitHub CLI/API query to the fetch origin returned by
`git remote get-url origin`, using explicit repository and host flags, and checks
the run response's repository identity. Ambient `GH_REPO`, `GH_HOST`, or CLI
repository defaults cannot substitute another repository's CI. Supported origins
are GitHub.com HTTPS and Git SSH URLs; local remotes, other hosts, credentials,
query/fragment suffixes and unproved URL forms refuse cleanup.
The shipping SHA must be its ancestor and available locally. The latest
covering main `CI` run must be successful. Both `push` and `workflow_dispatch` on
main qualify, since `ci.yml` runs the same gate for both. Feature-ref dispatches,
focused native workflows, and a prior green hidden by a newer covering pending
or failed run do not qualify. The run's actual API workflow path, commit and event
must match; its unchanged shipping `ci.yml` determines every expected job and
matrix expansion, all of which must have succeeded. Unsupported workflow/job
contracts refuse instead of assuming a smaller gate is equivalent.

## Private preservation and recovery

Execution inventories every Git-ignored owned regular file and symlink. It does
not follow symlinks into shared dependencies or other checkouts. It refuses
special files, hard-linked regular files, nested repositories reported as
directories, or symlink-parent ambiguity. Unique untracked non-ignored files are
dirty state and refuse. The inventory and byte hashes must remain identical when
all live checks are repeated immediately before removal.

Before removal, ignored bytes (including HARs and evidence) are copied and
hash-verified under the Git common directory's
`domotion-worktree-cleanup/<identity>/preserved/`. Directories are private (0700),
copied regular files are 0600, and the private manifest retains original modes
and symlink targets for restoration to the original location. These bytes never
enter Git objects or a remote. Source commits are retained locally under
`refs/domotion/cleanup-source/<identity>`, and explicit stash commits under
`refs/domotion/cleanup-stash/<sha>`. Never mirror-push these private local refs.
Backups have no automatic expiry; removal may reclaim little space when owned
ignored data needs retaining.

All verification refusals preserve the checkout and branch. A failed late recheck
may leave an additional private backup/archive, which must also be retained. Once
the durable intent is written, Git removal or branch compare-and-swap failures
are reported as **interrupted**, not successful or harmless refusals. A branch
that advanced cannot be deleted by this operation. A single Git ref transaction
verifies source/stash archives while compare-and-swap deletes that exact branch;
a missing archive also retains the branch. There is no force removal.

An interruption retains `intent.json`, `preservation.json`, source/stash archive
refs, and copied ignored data. Inspect actual worktree registration, branch SHA,
intent, and manifest before any recovery; do not retry by deleting the evidence
directory or bypassing checks. If Git removed the checkout but branch deletion
failed, keep the branch and archives until the integrator reviews its current
identity and reconstructs any required checkout from the archived source. This
tool deliberately refuses automatic replay of an existing intent. It does not
clean up preservation records, stashes, archive refs, or other worker trees.

Run the disposable real-Git regression suite with:

```sh
node --test scripts/verified-worktree-cleanup.test.mjs
```

The normal unit gate also runs that suite through
`src/verified-worktree-cleanup.test.ts`. Tests inject only external authority,
idle, and npm results; Git registration, merges/cherry-picks, removal, archive
refs, private-file copies and preservation assertions use real temporary repos.
No production test option can select a fake verifier. Workflow/adapter guidance
must be updated by the integrator after this supported command is integrated;
existing shared guidance and provider adapters are outside this ticket's worker
edit boundary. Typed follow-up **DM-PA6GV1** owns the exact installed-command
mismatch (missing review-note and explicit execution flags), canonical guidance
and adapter metadata wiring while preserving their existing user edits.

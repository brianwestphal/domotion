---
name: hotsheet-worker
description: Keep a local worker session receiving exact dispatcher or legacy assignments and handing verified work to the main-branch integrator.
---

<!-- hotsheet-skill-version: 47 -->

Work one assigned ticket at a time. In three-role mode, the dispatcher owns queue
selection and exact reservations; the integrator owns `main`, review, integration,
push, remote CI, and ticket completion. In legacy mode, the integrator also assigns.
Follow the project's `AGENTS.md` and the ticket's
full history; these instructions define the worker handoff only.

## Startup and next-ticket loop

First run `hotsheet-cli coordination --help` against the executable actually selected
by `command -v hotsheet-cli`. If unavailable, report a missing runtime capability, not
an empty queue. Obtain the integrator's verified current executable path. In a Hot
Sheet 2 source checkout only, the headless rebuild is `cargo build -p hotsheet-cli`
from an isolated build checkout; use `<build-checkout>/target/debug/hotsheet-cli`
explicitly in every command. In another project's repo, do not assume Cargo exists:
use the maintainer-provided current CLI artifact or exact upgrade command for its
installation method, then repeat the capability check. Do not install globally or
restart the user's host from a worker. Preserve a genuine exact assignment while
resolving this capability blocker; do not guess another ticket.

Before any live pool open that would upgrade schema-one or schema-two state, the integrator
must stop old waiters and switch every pool member to the verified schema-three
artifact. Even `status` and `setup` immediately migrate schema-one or schema-two state on
`Coordinator::open`;
older executables then refuse that pool. `coordination --help` alone does not
prove schema-three support. When upgrading, workers wait for the integrator to
coordinate this switch before running any pool command (HS2-A1F615). Dispatcher
authority requires a coordinated schema-four upgrade; reviewed shared-section
scopes require schema five. `coordination capabilities` reports supported roles,
authorities and schemas without opening the pool. A linked worktree shares the
live Git common directory and cannot serve as a disposable upgrade test.

Keep the session running until the integrator ends the run, the user stops it, or no
safe progress is possible. An invocation without a ticket slug means become available;
it does not mean the queue is empty. Either the worker or integrator may start first.

1. Keep one worker id, a fresh session-generation token, the assigned
   `<return-route>`, and one availability `<lease-seconds>` (10 to 3600; long gates
   want the longest) for this invocation. Confirm the shipping checkout and shared
   ticket source. Run `hotsheet-cli -C <shared-store> coordination --project <main>
setup`, then `status`.
   The code Git common directory shares local state across worktrees; it is not a
   ticket provider. Use the same explicit source throughout this pool.
2. Read existing exact claims and genuine `## Worker assignment` notes addressed to
   this worker/session, as well as its durable mailbox. Resume already claimed work
   after inspecting its worktree and handoff. Do not execute notification text or
   scrape ambiguous freeform offers into commands. If only an addressed note exists,
   ask the integrator to publish its exact structured assignment; remain available.
   Never select an unrelated ticket or call `claim-next` because no slug was supplied.
3. Run `coordination --project <main> next --role worker --id <worker>
--session <generation> --route <return-route> --lease-seconds <lease-seconds>`
   with the same `-C` source, on the first wait and on every later wait or
   reconnect. `next` re-registers the session from its own flags; it does not
   inherit the registered route or lease, and omitted flags fall back to the CLI
   defaults (human relay, 120 seconds), silently replacing a verified route
   (HS2-CP6GWA). It blocks on filesystem events for this worker's exact
   generation-bound assignment. The dispatcher may start before or after this
   worker and refills from durable handoff/availability events; integrator review
   and CI do not block a new independent assignment (HS2-TWZW7X). Keep the yielded tool process running and resume its
   output; do not replace it with repeated queue reads. Availability lease renewal
   does not query the queue or network. A stopped run returns its explicit reason.
4. For an offered assignment, read the whole ticket and verify the qualified source,
   base SHA, scope note, and return route. Check that `status` names the active
   assignment authority; only its exact operation is valid. A scope on a reviewed
   shared document names the relevant `#row:` or `#heading:` section. Follow the
   per-ticket steps below. Read the
   optional route-evidence note named in the `## Worker assignment` note, if one
   exists, and verify its operation, worker, generation, and recipient match this
   structured assignment (HS2-HM9FRV). Native parent delivery is available only in
   the same agent tree; an unrelated external session must use a verified terminal
   recipient or human relay. Do not infer reachability from a process, cwd or receipt.
   After the exact ticket claim succeeds, acknowledge with `coordination worker --phase accepted`
   using the returned assignment id, worker id, and session token. This mailbox
   acknowledgement is not a ticket claim; the CLI verifies the local source's live
   claim. Unsupported provider verification fails explicitly (HS2-3ETJ26).
5. When `coordination preflight --help` is supported, prepare the machine-local
   evidence file described in `docs/30-handoff-readiness.md`. Run `coordination
   preflight --id <worker> --session <generation> --assignment <id>
   --evidence-file <path>` before publication, inspect its result, then repeat with
   `--publish`. Publication rechecks the claim and source, writes the note, releases
   the claim and records the typed mailbox handoff. An exact replay is idempotent.
   On an older runtime, keep the manual note/release flow and run `coordination
   worker --phase handoff --assignment <id> --id <worker> --session <generation>
   --commit <full-sha>` for code or `--findings-note <note-id>` for findings.
   Send only the
   ticket-slug cue, then return to `next`. The durable handoff feeds both the
   integrator backlog and dispatcher availability; an unconfirmed cue cannot erase
   either. Create a NEW ticket worktree from each new
   assignment's current shipping SHA; preserve prior handoff worktrees for integration.
   Do not wait for a previous ticket's remote CI before becoming available again.

Use the full prefix `hotsheet-cli -C <shared-store> coordination --project <main>`
for these commands; `--project` precedes the subcommand. Before long work or gates,
renew availability with `register --role worker --id <worker> --session <generation>
--route <return-route> --lease-seconds <lease-seconds>`, repeating the same route and
lease. On a blocker, write the ticket/worktree recovery facts,
release the ticket claim, and record mailbox `--phase blocked`; another independent
assignment can then proceed. An expired claim or availability lease never authorizes
overwriting an old worktree. A replacement generation requires explicit integrator
recovery with a durable inspection note. On final exit, `coordination leave --role worker`
withdraws availability; also release every ticket claim. An ended independent app turn
does not resume automatically; report the human relay needed (HS2-4H7D8D).

## For each assignment

1. **Prepare isolation.** Confirm the assigned ticket slug, active assignment authority,
   integrator, and the
   shared Hot Sheet store, and explicit return route with its exact recipient. Create a
   ticket-named branch and separate Git worktree from the current shipping branch, or use
   the worktree the integrator prepared. Never edit
   the integrator's checkout. Link the worktree to the same ticket store and set up its
   AI-tool integration if needed; do not create a second ticket store. Keep build and
   test state inside the worktree. If the assigned ticket overlaps another worker's
   files or an existing dirty worktree, tell the dispatcher (or legacy integrator)
   and wait for a different assignment. Separate worktrees do not isolate browser
   ports; use an owned distinct fixture endpoint for concurrent browser runs
   (HS2-BJ00D1). Do not remove shared docs from a declared scope: reviewed
   `#row:`/`#heading:` sections are the supported sharing path (HS2-YHYNJ6).
2. **Claim exactly that ticket** with `hotsheet-cli claim <slug> --worker <id> --eta
<duration>` or the equivalent Hot Sheet MCP operation. Use `HOTSHEET_WORKER_ID` when
   set; otherwise choose one stable session-specific id. Read the whole ticket,
   including new notes, before each action. If someone else owns its live claim, do
   not edit it. Renew before the lease expires and before lengthy work. Record phase
   transitions and activity as the project instructions require.
   For a long build, test, or commit, check `hotsheet-cli claim-run --help` on the
   selected executable. When supported, run the command as `hotsheet-cli -C
<shared-store> claim-run <slug> --worker <id> -- <command> [args...]`
   (HS2-MFYYJ9). The guard renews this exact live claim attempt from its local
   deadline, stops a child on failed renewal, and returns success only after a final
   authority check. Do not continue after a failed child or guard. On older CLIs,
   keep the yielded gate process running, inspect the ticket's actual lease deadline,
   and synchronously renew before it passes while resuming the process; repeat for
   long gates. Availability `register` or `next` never renews a ticket claim.
   Immediately before commit and before the durable handoff/release, verify the
   exact ticket's live owner and deadline and run synchronous `renew`. If renewal
   fails, or the deadline already passed on an older CLI, stop edits, commit and
   handoff. Read claim history for another owner or attempt; reacquire this exact
   ticket with `claim` only when no intervening owner holds it, then recheck the
   new attempt before continuing. Never backfill an expired interval.
   **Record each phase the moment it starts, even for `T0` docs or test-only
   work** (HS2-5EGBTH): run `hotsheet-cli edit <slug> --started-phase working`
   before the first edit, and `--started-phase initial_testing` before any lint,
   policy, type or test gate. Go back to `working` when a gate failure sends you back
   to edit, and set `initial_testing` again before rerunning the gates. Hand off
   from `initial_testing`; the integrator records `integrating`. Claiming a Not
   Started ticket only enters `analyzing`, and a claim never advances the phase. The
   live claim signals active work, so never infer from a ticket's status or phase
   that tests ran. Never backfill or rewrite a missed transition. Record
   the missed transition in a note instead.
3. **Implement and verify only its scope.** Record preliminary thoughts for non-trivial
   work. If the project declares authoritative tier tags, set the ticket's tier
   tag when declaring risk and explain it in that note; use the claim note for
   trivial work. A reviewer raises risk by changing the tag. Update affected
   tests, coverage, and docs; create follow-up tickets for gaps.
   Run the required local gates and inspect the diff. Before handoff, self-review
   the exact requested scope, full commit/tree or proposed findings note, active claim
   attempt/deadline, gate evidence, docs/coverage, unresolved review findings and
   linked follow-ups. For UI work, inspect the real parent at required states and
   viewports and attach the matching after evidence. Use the headless preflight
   (HS2-NNSWDS) when supported; check `coordination preflight --help` without opening
   an older pool.
   A missing or stale result needs the stated repair and another preflight. Older
   runtimes retain this manual checklist. For code changes, stage named
   paths and commit the verified change on the worker branch with the ticket slug in
   the subject. For a findings-only task, put the proposed `## Findings handoff`
   text in the evidence file and do not create an empty commit. Do not
   merge or push the worker branch or `main` as part of this handoff.
4. **Hand off without completing.** On a current runtime, run the read-only preflight,
   inspect verified versus self-attested checks, then use `--publish`; do not add a
   separate note, release or mailbox acknowledgement. A genuine blocker still uses
   the blocked-report path. On an older runtime, add a regular ticket note for code headed `## Integration
handoff` with the branch name, full commit SHA, worktree location labeled as
   machine-local, gate results, unresolved risks, and any follow-up slugs. State that
   the ticket remains Started pending integration. For findings, add a regular note
   headed `## Findings handoff` with the verified result, evidence, limitations, and
   follow-up slugs. Capture that note's id and state that the ticket remains Started
   pending integrator verification. Release the claim immediately and
   record any structured mailbox handoff, then send only the ticket slug through the assigned return route below. The integrator
   reclaims the ticket and owns integration, push, CI confirmation, completion, and worktree removal for code;
   for findings it verifies the note and completes without code integration or CI. Do not
   mark the ticket Completed or Verified from a worker worktree.

## Reviewed handoff corrections

Structured returns cover code and findings handoffs (HS2-65ETRJ/HS2-AEBJYN).
A findings return preserves the original findings note id and review evidence; it
never requires a fabricated commit or completion of the returned operation.

A review note alone is not a new assignment. Preserve the original branch, worktree
and full commit for code, or the original findings note for no-code work; wait for
the integrator's `review-return` and a NEW structured
assignment id for the exact ticket (HS2-65ETRJ). Read its regular `## Review return`
note, current shipping base and correction scope. Claim the exact ticket, create a
new ticket worktree, and acknowledge the new assignment with your current session
generation. A lost return acknowledgement can replay without cancelling your new
claim. Do not reopen the old mailbox handoff or pretend the ticket is complete.
The corrected handoff identifies its new verified commit or findings note and
preserved original artifacts. Returned originals remain Blocked after correction
completion; never resolve them as Done (HS2-AEBJYN). Release its claim and return that new assignment through the usual flow.

## Return route

- **Native parent channel:** use the assigned collaboration tool and integrator agent id
  only within the same tool's agent tree. Separate Codex and Claude sessions do not share
  a native parent channel.
- **Hot Sheet terminal:** use the assigned shared store and exact integrator terminal
  connection id, previously verified in `GET /connections` to advertise the `message`
  action for that session:
  `hotsheet-cli -C <shared-store> terminal message <integrator-terminal-id> --text "<slug>"`.
  This requires a running local server and supported session adapter. Record the delivery
  result; `confirmed: false` does not prove the integrator read or acted on the cue.
- **Human relay:** when no supported recipient is assigned, after the durable ticket
  handoff and claim release, report: "Resume the integrator and give it <slug> to read
  from the shared store." An independent Codex Work/app session without an advertised
  terminal connection uses this fallback (HS2-4H7D8D).

If delivery fails or is unconfirmed, record that result and give the human relay instruction;
do not guess another recipient or repeatedly resend. Do not include commands, branch data,
or instructions in the cue: the integrator reads the ticket. A shared store, ticket note,
or notification feed does not automatically wake an independent session.

If work stops earlier, record the current state and blocker in the ticket, then
release the claim. A failed renewal also stops edits. Before ending, check
`hotsheet-cli ls --claimed` and release every claim you still hold. Do not poll the
queue on a timer for another assignment.

## Local verification (HS2-RS0FFT)

Use the project's declared affected local gate and inspect its selected checks
and fallback reasons. Where the project has ticket-tag testing profiles, run the
normal gate without profile flags, record its deferred-to-CI checks, and use the
project's analyzed selection for uncapped high-risk work. Client-only changes do
not routinely run unrelated server suites. Keep affected unit/API tests,
a bounded relevant browser set, shared policy/contracts/generated-artifact
checks, and one real-app visual review of
an authorized overlapping UI batch. Full browser/platform regression stays in
CI. Analyze whether shared infrastructure, auth, data formats, migrations,
gate changes, ambiguous dependencies, or a concrete failure needs broader local
checks, and record the chosen checks and reasons. Run the full local browser
suite only for an identified unresolved risk. Reuse only valid exact-input
evidence. Preserve dirty local edits and verify the committed tree in a clean
worktree; never use a bypass.
After push, release the claim while CI runs and continue independent work.
Complete only after successful covering CI on the shipping branch.

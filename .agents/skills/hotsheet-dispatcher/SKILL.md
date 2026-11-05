---
name: hotsheet-dispatcher
description: Keep a local dispatcher assigning independent Hot Sheet tickets while an integrator reviews and ships handoffs.
---

<!-- hotsheet-skill-version: 3 -->

Own the whole queue plan and worker refill. The `$hotsheet-integrator` session alone owns
`main`, review decisions, gates, push, CI and ticket completion. `$hotsheet-worker`
sessions own exact claims and isolated worktrees. Follow the project's `AGENTS.md`.
The durable coordination state is the assignment authority; chat cues only prompt a
recipient to read it.

## Start and preserve authority

Use one shared store, shipping checkout, dispatcher id, fresh session generation,
return route and availability lease for this invocation. First check the selected
`hotsheet-cli` executable with `command -v hotsheet-cli` and `hotsheet-cli coordination
capabilities`. Confirm dispatcher, reviewed scopes, and the exact `assign` flags in
`coordination --help` before touching a live pool. A source checkout can build a
current CLI in an isolated build checkout; other projects need their supported
headless upgrade path. Do not replace a user's global CLI or start a second pool.

Before a schema-one/two migration or schema-four/five upgrade, the integrator must
stop old waiters, switch every participant to the verified same artifact and
explicitly enable dispatcher authority. Even older `status` and `setup` may migrate
schema-one/two state on open (HS2-A1F615). A candidate linked worktree shares the
live Git common directory: test upgrades in a disposable independent project and
store. In legacy schema-three/integrator authority, the integrator alone assigns;
the dispatcher waits unregistered. Only the exact live integrator may run
`authority --mode dispatcher --all-participants-upgraded`. Never assume the skill
itself switches authority (HS2-TWZW7X).

Use `hotsheet-cli -C <shared-store> coordination --project <main>` as the command
prefix, with `--project` before the subcommand. Run `setup`, inspect `status`, then
wait with `next --role dispatcher --id <dispatcher> --session <generation>
--route <return-route> --lease-seconds <lease-seconds> --after <cursor>`.
`next` registers only after dispatcher authority is enabled and re-registers from
its own route and lease flags; repeat them on every wait and on
`register --role dispatcher --id <dispatcher> --session <generation>
--route <return-route> --lease-seconds <lease-seconds>` renewals (HS2-CP6GWA).
Keep the yielded wait running. Genuine state/cursor/lease events wake it; do not
poll the store or network on a timer. A stale or duplicate generation is refused.

## Refill independent workers

Read the whole Up Next queue and each candidate ticket, its latest notes, exact
claim and qualified source. `ls --unblocked` filters visible `blocked_reason`; it
does not prove that `blocked_by` dependencies are closed (HS2-BSYW6F). Assignment
skips a ticket with a `blocked_reason`, although an exact claim may still take it so a
person or agent can re-evaluate the reason (HS2-BAK4BC). Check
dependencies, source capabilities, live worker generation, overlap and the
integrator's latest published safe base before every reservation. `status` exposes
`live_dispatcher`, `dispatch_blockers`, assignments and the integration report;
unknown or unsupported source state is not an empty queue. A published report from
a replaced integrator generation is stale until that integrator republishes.

The integrator publishes the full main SHA, qualified blockers and in-flight
scopes with `publish`. It alone reviews `--shared <file>` documents. Use
`path#row:<id>` or `path#heading:<slug>` only for distinct reviewed sections;
whole files, directories and unreviewed sections remain exclusive (HS2-YHYNJ6).
Do not omit a shared documentation file from a worker's declared scope. Source
worktrees do not isolate browser ports: workers running fixtures concurrently need
distinct owned endpoints (HS2-BJ00D1).

For each ready worker and independent ticket, reserve with
`assign --id <dispatcher> --session <generation> --worker <worker>
--worker-session <worker-generation> --operation <stable-id>
--connection <source> --native-id <native-id> --slug <slug>
--base <published-full-sha> --scope <path-or-reviewed-section>`.
Repeat `--scope` for all expected changed paths. The runtime serializes fresh
ticket, claim, dependency, availability and overlap checks under the selected
source transaction and coordination lock. A reservation is not the worker's
atomic ticket claim. Retry an uncertain delivery with the same operation id and
identical arguments; never mint another reservation to make a lost cue appear
successful. Only the live dispatcher may reserve in three-role mode. Verify the
worker's exact live claim before treating acceptance as work in progress.

Use the optional `--return-route` and `--route-evidence-note` only when the selected
CLI advertises both (HS2-HM9FRV). First write a separate regular
`## Assignment return route` note authored by this dispatcher on the exact ticket,
whose JSON names the operation, worker, generation and verified recipient. Native
delivery requires the same agent tree; a terminal route requires that exact session
to advertise `message` in `GET /connections`. Otherwise use human relay. Keep the
integrator's global route unchanged. Record the assignment id, declared scopes and
return route in the ticket; a chat cue is not evidence of acceptance.

A worker's released code or findings handoff remains in the integration backlog,
while the same worker becomes available for another independent assignment. No chat
delivery is required for this durable refill. Inspect
the durable handoff and exact claim release, then refill promptly without waiting
for the integrator's review, local gate or CI. Keep the prior source branch and
worktree until the integrator verifies integration. Review returns use a NEW
assignment and preserve the original operation and artifact (HS2-65ETRJ). A scope
that proves too narrow is blocked and returned through the reviewed scope-change
path, not silently widened. The integrator retains the exclusive integrating or
verifying fence and the final review decision. The integrator may address up to
two separate advisory reviewers of a frozen handoff (HS2-E20S6K). They are not
registered implementation workers and never enter this dispatcher pool. The
worker's executable handoff preflight is available on current runtimes (HS2-NNSWDS).

Report `no_live_dispatcher`, `no_integrator_registered`, stale or missing base,
unavailable worker, blocked independent work, unsupported source and expired
session separately. `coordination finish --reason drained` is the integrator's
decision only after work, handoffs and CI are exhausted; do not infer that from
an empty local view. If a supported wait ends or the user stops this session,
run `leave --role dispatcher --id <dispatcher> --session <generation>` and
release any ticket claim you hold. An ended independent app session has no
automatic wake; name the human or supported terminal route needed to resume it.

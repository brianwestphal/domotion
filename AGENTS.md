<!-- hotsheet:begin section=claude-adapter v=1 -->
## Shared Project Guidance (CLAUDE.md)

`CLAUDE.md` is the shared source of truth for this repository's engineering rules. Read it completely before making or reviewing changes, and follow it as if its contents appeared here. The filename reflects the project's history; the instructions apply equally to this tool.

- Project workflows are exposed as skills under `.agents/skills/`. Use a skill when the user names it or the request clearly matches its description.
- The skill adapters delegate to `.claude/skills/`, the canonical source for workflows shared across AI tools. When changing a shared workflow, edit the canonical file and keep the adapter metadata in sync.
- Claude tool names in shared documents describe capabilities, not required product-specific tools — use this tool's equivalent file-search, shell, editing, or web capability.
- Keep durable repository guidance in `CLAUDE.md`; provider-specific configuration belongs in its provider's directory.
<!-- hotsheet:end section=claude-adapter -->

<!-- BEGIN hotsheet:codex -->
## Hot Sheet — ticket workflow

This project tracks work as **Hot Sheet** tickets (plain files under the store). Use them to
know what to do next and to record what you did. Everything below works **headless** — no
app, and no server required.

**Create tickets by default for real work — even when work is described directly to you.**
When someone asks you to do something in this terminal (not through the Hot Sheet queue),
open a ticket before you start, then work through it: **claim it** to begin, implement, set it
`completed` with a note. Do this for features, bug fixes, refactors, and any multi-step or
code-changing task. Skip ticketing only for trivial one-offs: simple questions, quick
lookups, a single-line fix, or a git commit. When in doubt, create the ticket.

**Find and plan the queue:**
- `hotsheet-cli ls --up-next` — the prioritized Up Next queue.
- `hotsheet-cli show <slug>` — read one ticket in full.
- Or the MCP tools: `hotsheet_query` (with `up_next: true`) and `hotsheet_get`.

**Claim a ticket before you work it — claiming, not `started`, is what signals live work:**
- `hotsheet-cli claim <slug> --worker <your-id>` when you begin. This atomically moves a Not
  Started ticket to **Started** *and* takes a renewable live lease that tells everyone you are
  actively on it. Always claim before you touch code. Prefer it over `hotsheet-cli edit <slug>
  --status started`, which only flips the status and does **not** claim or signal live work.
  (Self-serve the top of the queue with `hotsheet-cli claim-next --worker <your-id>`.)
- `hotsheet-cli renew <slug> --worker <your-id>` during long work; `hotsheet-cli release <slug>
  --worker <your-id>` when you stop for completion, handoff, or a blocker.
- `hotsheet-cli edit <slug> --status completed --note "what you did"` when done.
- Or the MCP tools: `hotsheet_claim_next` / `hotsheet_renew` / `hotsheet_release` for the lease,
  and `hotsheet_update` (it takes a `note`) / `hotsheet_close`.
- Create work with `hotsheet-cli new --title "…" --category <bug|feature|task>` or
  `hotsheet_create`.

**Create every follow-up immediately, without asking.** As soon as you identify an
unfinished step, open question, known gap, out-of-scope task, or designed-but-unbuilt
behavior, create its ticket rather than leaving it in a comment, TODO, or note. Do not ask
permission or promise to file it later. Reference every follow-up slug in the current
ticket's completing note, then continue.

**Before completing a ticket:** finish and verify its scope; update the tests, coverage, and
docs the change requires; scan for placeholders, TODO/FIXME, stubs, and documented-but-
unbuilt behavior; create a follow-up for every incomplete item; and put the result,
verification, and all follow-up slugs in the completing note. `FEEDBACK NEEDED` is only for a
blocker on the *current* ticket that needs a user decision or unavailable external state —
leave that ticket `started`, name the blocker, and release its lease (`hotsheet-cli release`).
It does not replace follow-ups for independently describable work.

Normally continue until every actionable Up Next ticket is complete. Read the whole queue
before choosing an order; weigh dependencies, overlap, risk, and safe parallelization. Treat
priority as important guidance, not a hard rule. The CLI and MCP tools use the same engine —
use whichever is handier.

**Write portable durable references.** In documentation, ticket text, and notes, never copy a
developer-specific home directory, username, or absolute clone path. Use repository-relative
paths, a stable repo name/URL, or a placeholder such as `<repo-root>/path`. Keep an exact
local path only as clearly labeled machine-local diagnostic evidence.

## Testing

- **Double coverage:** cover each feature with both unit tests (logic in isolation, external
  dependencies mocked) **and** end-to-end tests (real user flows through the running system,
  minimal mocking). Keep test fakes faithful to the real contract — same shapes, fields, and
  status codes.
- **Coverage is a floor, not a ceiling.** 100% lines means every line *ran*, not that every
  *behavior* — or every *sequence* of behaviors — is *asserted*. It is blind to missing state
  transitions.
- **Stateful code gets transition-matrix + adversarial tests.** For anything with modes, a
  cache, or a state machine, enumerate the states *and* the transitions, then walk realistic
  multi-step sequences that cross boundaries. Deliberately try to break it with out-of-order,
  interleaved, repeated, and empty-then-refill sequences; pin any bug you find as a permanent
  regression test.
- **Fix lint and type errors before finishing** — as you go, not batched.

## Requirements & docs

Keep human-readable requirements/docs as the source of truth for what the project does, and
update them **in the same change as the code**: add, remove, or modify a behavior → update
its doc in the same commit. Create a new doc for a major new functional area and cross-link
related docs.

## Commit hygiene

Keep the repo in a known-good state.

1. Implement one coherent, ticket-sized change and update its docs and tests.
2. Lint and fix every affected package; run the affected unit and end-to-end tests. Do not
   leave a lint warning or failing test behind.
3. Mark the ticket `completed` with its verification note, review the diff, and make **one
   commit per ticket** whose message names every ticket slug it addresses. Combine tickets in
   one commit only when their changes overlap so strongly that separating them would be unsafe
   or misleading.
4. Get the worktree clean before starting the next ticket.

**Pushing is up to this repository.** Follow whatever push/PR/review conventions this project
already uses; this default guidance does not require or forbid pushing on its own.
<!-- END hotsheet:codex -->

<!-- BEGIN hotsheet:antigravity -->
## Hot Sheet — ticket workflow

This project tracks work as **Hot Sheet** tickets (plain files under the store). Use them to
know what to do next and to record what you did. Everything below works **headless** — no
app, and no server required.

**Create tickets by default for real work — even when work is described directly to you.**
When someone asks you to do something in this terminal (not through the Hot Sheet queue),
open a ticket before you start, then work through it: **claim it** to begin, implement, set it
`completed` with a note. Do this for features, bug fixes, refactors, and any multi-step or
code-changing task. Skip ticketing only for trivial one-offs: simple questions, quick
lookups, a single-line fix, or a git commit. When in doubt, create the ticket.

**Find and plan the queue:**
- `hotsheet-cli ls --up-next` — the prioritized Up Next queue.
- `hotsheet-cli show <slug>` — read one ticket in full.
- Or the MCP tools: `hotsheet_query` (with `up_next: true`) and `hotsheet_get`.

**Claim a ticket before you work it — claiming, not `started`, is what signals live work:**
- `hotsheet-cli claim <slug> --worker <your-id>` when you begin. This atomically moves a Not
  Started ticket to **Started** *and* takes a renewable live lease that tells everyone you are
  actively on it. Always claim before you touch code. Prefer it over `hotsheet-cli edit <slug>
  --status started`, which only flips the status and does **not** claim or signal live work.
  (Self-serve the top of the queue with `hotsheet-cli claim-next --worker <your-id>`.)
- `hotsheet-cli renew <slug> --worker <your-id>` during long work; `hotsheet-cli release <slug>
  --worker <your-id>` when you stop for completion, handoff, or a blocker.
- `hotsheet-cli edit <slug> --status completed --note "what you did"` when done.
- Or the MCP tools: `hotsheet_claim_next` / `hotsheet_renew` / `hotsheet_release` for the lease,
  and `hotsheet_update` (it takes a `note`) / `hotsheet_close`.
- Create work with `hotsheet-cli new --title "…" --category <bug|feature|task>` or
  `hotsheet_create`.

**Create every follow-up immediately, without asking.** As soon as you identify an
unfinished step, open question, known gap, out-of-scope task, or designed-but-unbuilt
behavior, create its ticket rather than leaving it in a comment, TODO, or note. Do not ask
permission or promise to file it later. Reference every follow-up slug in the current
ticket's completing note, then continue.

**Before completing a ticket:** finish and verify its scope; update the tests, coverage, and
docs the change requires; scan for placeholders, TODO/FIXME, stubs, and documented-but-
unbuilt behavior; create a follow-up for every incomplete item; and put the result,
verification, and all follow-up slugs in the completing note. `FEEDBACK NEEDED` is only for a
blocker on the *current* ticket that needs a user decision or unavailable external state —
leave that ticket `started`, name the blocker, and release its lease (`hotsheet-cli release`).
It does not replace follow-ups for independently describable work.

Normally continue until every actionable Up Next ticket is complete. Read the whole queue
before choosing an order; weigh dependencies, overlap, risk, and safe parallelization. Treat
priority as important guidance, not a hard rule. The CLI and MCP tools use the same engine —
use whichever is handier.

**Write portable durable references.** In documentation, ticket text, and notes, never copy a
developer-specific home directory, username, or absolute clone path. Use repository-relative
paths, a stable repo name/URL, or a placeholder such as `<repo-root>/path`. Keep an exact
local path only as clearly labeled machine-local diagnostic evidence.

## Testing

- **Double coverage:** cover each feature with both unit tests (logic in isolation, external
  dependencies mocked) **and** end-to-end tests (real user flows through the running system,
  minimal mocking). Keep test fakes faithful to the real contract — same shapes, fields, and
  status codes.
- **Coverage is a floor, not a ceiling.** 100% lines means every line *ran*, not that every
  *behavior* — or every *sequence* of behaviors — is *asserted*. It is blind to missing state
  transitions.
- **Stateful code gets transition-matrix + adversarial tests.** For anything with modes, a
  cache, or a state machine, enumerate the states *and* the transitions, then walk realistic
  multi-step sequences that cross boundaries. Deliberately try to break it with out-of-order,
  interleaved, repeated, and empty-then-refill sequences; pin any bug you find as a permanent
  regression test.
- **Fix lint and type errors before finishing** — as you go, not batched.

## Requirements & docs

Keep human-readable requirements/docs as the source of truth for what the project does, and
update them **in the same change as the code**: add, remove, or modify a behavior → update
its doc in the same commit. Create a new doc for a major new functional area and cross-link
related docs.

## Commit hygiene

Keep the repo in a known-good state.

1. Implement one coherent, ticket-sized change and update its docs and tests.
2. Lint and fix every affected package; run the affected unit and end-to-end tests. Do not
   leave a lint warning or failing test behind.
3. Mark the ticket `completed` with its verification note, review the diff, and make **one
   commit per ticket** whose message names every ticket slug it addresses. Combine tickets in
   one commit only when their changes overlap so strongly that separating them would be unsafe
   or misleading.
4. Get the worktree clean before starting the next ticket.

**Pushing is up to this repository.** Follow whatever push/PR/review conventions this project
already uses; this default guidance does not require or forbid pushing on its own.
<!-- END hotsheet:antigravity -->

<!-- BEGIN hotsheet:opencode -->
## Hot Sheet — ticket workflow

This project tracks work as **Hot Sheet** tickets (plain files under the store). Use them to
know what to do next and to record what you did. Everything below works **headless** — no
app, and no server required.

**Create tickets by default for real work — even when work is described directly to you.**
When someone asks you to do something in this terminal (not through the Hot Sheet queue),
open a ticket before you start, then work through it: **claim it** to begin, implement, set it
`completed` with a note. Do this for features, bug fixes, refactors, and any multi-step or
code-changing task. Skip ticketing only for trivial one-offs: simple questions, quick
lookups, a single-line fix, or a git commit. When in doubt, create the ticket.

**Find and plan the queue:**
- `hotsheet-cli ls --up-next` — the prioritized Up Next queue.
- `hotsheet-cli show <slug>` — read one ticket in full.
- Or the MCP tools: `hotsheet_query` (with `up_next: true`) and `hotsheet_get`.

**Claim a ticket before you work it — claiming, not `started`, is what signals live work:**
- `hotsheet-cli claim <slug> --worker <your-id>` when you begin. This atomically moves a Not
  Started ticket to **Started** *and* takes a renewable live lease that tells everyone you are
  actively on it. Always claim before you touch code. Prefer it over `hotsheet-cli edit <slug>
  --status started`, which only flips the status and does **not** claim or signal live work.
  (Self-serve the top of the queue with `hotsheet-cli claim-next --worker <your-id>`.)
- `hotsheet-cli renew <slug> --worker <your-id>` during long work; `hotsheet-cli release <slug>
  --worker <your-id>` when you stop for completion, handoff, or a blocker.
- `hotsheet-cli edit <slug> --status completed --note "what you did"` when done.
- Or the MCP tools: `hotsheet_claim_next` / `hotsheet_renew` / `hotsheet_release` for the lease,
  and `hotsheet_update` (it takes a `note`) / `hotsheet_close`.
- Create work with `hotsheet-cli new --title "…" --category <bug|feature|task>` or
  `hotsheet_create`.

**Create every follow-up immediately, without asking.** As soon as you identify an
unfinished step, open question, known gap, out-of-scope task, or designed-but-unbuilt
behavior, create its ticket rather than leaving it in a comment, TODO, or note. Do not ask
permission or promise to file it later. Reference every follow-up slug in the current
ticket's completing note, then continue.

**Before completing a ticket:** finish and verify its scope; update the tests, coverage, and
docs the change requires; scan for placeholders, TODO/FIXME, stubs, and documented-but-
unbuilt behavior; create a follow-up for every incomplete item; and put the result,
verification, and all follow-up slugs in the completing note. `FEEDBACK NEEDED` is only for a
blocker on the *current* ticket that needs a user decision or unavailable external state —
leave that ticket `started`, name the blocker, and release its lease (`hotsheet-cli release`).
It does not replace follow-ups for independently describable work.

Normally continue until every actionable Up Next ticket is complete. Read the whole queue
before choosing an order; weigh dependencies, overlap, risk, and safe parallelization. Treat
priority as important guidance, not a hard rule. The CLI and MCP tools use the same engine —
use whichever is handier.

**Write portable durable references.** In documentation, ticket text, and notes, never copy a
developer-specific home directory, username, or absolute clone path. Use repository-relative
paths, a stable repo name/URL, or a placeholder such as `<repo-root>/path`. Keep an exact
local path only as clearly labeled machine-local diagnostic evidence.

## Testing

- **Double coverage:** cover each feature with both unit tests (logic in isolation, external
  dependencies mocked) **and** end-to-end tests (real user flows through the running system,
  minimal mocking). Keep test fakes faithful to the real contract — same shapes, fields, and
  status codes.
- **Coverage is a floor, not a ceiling.** 100% lines means every line *ran*, not that every
  *behavior* — or every *sequence* of behaviors — is *asserted*. It is blind to missing state
  transitions.
- **Stateful code gets transition-matrix + adversarial tests.** For anything with modes, a
  cache, or a state machine, enumerate the states *and* the transitions, then walk realistic
  multi-step sequences that cross boundaries. Deliberately try to break it with out-of-order,
  interleaved, repeated, and empty-then-refill sequences; pin any bug you find as a permanent
  regression test.
- **Fix lint and type errors before finishing** — as you go, not batched.

## Requirements & docs

Keep human-readable requirements/docs as the source of truth for what the project does, and
update them **in the same change as the code**: add, remove, or modify a behavior → update
its doc in the same commit. Create a new doc for a major new functional area and cross-link
related docs.

## Commit hygiene

Keep the repo in a known-good state.

1. Implement one coherent, ticket-sized change and update its docs and tests.
2. Lint and fix every affected package; run the affected unit and end-to-end tests. Do not
   leave a lint warning or failing test behind.
3. Mark the ticket `completed` with its verification note, review the diff, and make **one
   commit per ticket** whose message names every ticket slug it addresses. Combine tickets in
   one commit only when their changes overlap so strongly that separating them would be unsafe
   or misleading.
4. Get the worktree clean before starting the next ticket.

**Pushing is up to this repository.** Follow whatever push/PR/review conventions this project
already uses; this default guidance does not require or forbid pushing on its own.
<!-- END hotsheet:opencode -->

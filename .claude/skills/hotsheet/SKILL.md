---
name: hotsheet
description: Plan and work through the complete Hot Sheet Up Next queue using priority, overlap, dependencies, and safe parallelism. Works headless, with or without a server.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---

<!-- hotsheet-skill-version: 47 -->

Work the project's complete Hot Sheet Up Next queue. An invocation normally drains every
actionable Up Next ticket; completing one ticket is not a stopping condition.

1. **Read and plan the whole queue.** List Up Next, read every queued ticket in full, and
   inspect relevant code before choosing execution order. Build a short working plan that
   identifies dependencies, implementation overlap or duplicates, independent work,
   safe parallelization opportunities, verification needs, and commit boundaries.
   Priority is an important guidance signal, not an absolute ordering rule. Prefer higher
   priority when other factors are equal, but reorder when dependencies, shared context,
   risk reduction, or avoiding duplicated work makes another order clearly better.
2. **Use available parallelism deliberately.** When sub-agents are available and the
   environment and user authorize delegation, assign concrete independent tickets or
   bounded investigations in parallel. Do not parallelize tickets that edit the same
   surfaces or depend on unresolved decisions. The primary agent owns integration,
   ticket status, verification, and publishing.
3. **Work each ticket end to end under an exact claim lease.** Choose one stable,
   session-specific worker id. Immediately before active work, claim the assigned ticket
   with the atomic CLI form
   `hotsheet-cli claim <id> --worker <worker> [--label <label>] [--lease-minutes N]`,
   which acquires the claim and changes Not Started to Started in one durable write.
   Do not issue separate claim and status commands. Renew
   before the lease expires and before lengthy work with `hotsheet_renew` or
   `hotsheet-cli renew`; release with `hotsheet_release` or `hotsheet-cli release` when
   work stops for completion, handoff, error, or feedback. If another worker holds the
   live lease, do not work concurrently; replan around other tickets. Then implement and
   verify scope, run the completion checklist, and mark completed with a result and
   verification note. Delegated workers claim their own exact assigned ticket and use a
   distinct worker id; the primary agent remains responsible for integration.
4. **Create every follow-up immediately, without asking.** As soon as you identify an
   unfinished step, open question, known gap, out-of-scope task, or designed-but-unbuilt
   behavior, create its ticket. Do not ask permission, wait, promise to file it later, or
   leave it only in a comment/TODO/note. Reference every follow-up slug in the current
   ticket's completing note, then continue.
5. **Publish at ticket boundaries.** Run required gates, review the diff, make one commit
   for that ticket, include its ticket slug in the commit message, and push before
   beginning the next sequential ticket. Combine tickets only when their implementations
   overlap so strongly that separation would be unsafe or misleading, or when they are
   duplicates; a combined commit message must reference every ticket slug it addresses.
   Integrate parallel tickets separately.
6. **Re-read the queue after every completion.** Concurrent work and new findings can
   change the plan. Continue until no actionable Up Next ticket remains.

**Completion checklist:** finish and verify scope; update required tests, coverage, and
docs; scan for placeholders, TODO/FIXME comments, stubs/mock returns, documented-but-
unimplemented behavior, open questions, and known gaps; immediately create tickets for
every incomplete item; include result, verification, and all follow-up slugs in the
completing note.

Write durable ticket text, notes, completion summaries, and documentation so another
developer can understand them from a different clone. Never copy a developer-specific
home directory, username, Desktop/Documents path, or absolute clone location when a
repository-relative path, stable repository name/URL, or placeholder such as
`<repo-root>/path` will work. Keep an exact local path only when the path itself is
indispensable machine-local diagnostic evidence, and label it as local context.

For user-visible UI work, liberally capture and attach a representative set of real-browser
screenshots covering the changed components, screens, states, and meaningful wide/narrow
layouts. **If the ticket already has an image demonstrating the problem or requested
design, treat a corresponding after screenshot as a required pre-close deliverable:**
reproduce the same component, state, and viewport as closely as practical, attach the new
capture to the ticket, and reference it by name (`attachment:filename`) in the completion
note. Also attach other useful wide/narrow or focused captures; prefer a crop when it
communicates the change more clearly. Do not silently substitute a local-only screenshot
for a ticket attachment. If capture or attachment is genuinely impossible after exhausting
safe alternatives, state the specific reason in the completion note. Screenshots supplement
behavioral assertions; they do not replace them.

Before attaching correctness evidence, apply `CLAUDE.md`'s visual-QA policy to the actual
capture, not just its assertions: critically inspect readability, usability, contextual
aesthetic fit and flow/order, clipping or truncation, icon-label alignment, spacing,
responsive behavior, and any other obvious defect. Fix every defect found, rerun affected
checks, and recapture; attach only evidence fit to hand off. An imperfect screenshot may be
attached only as explicit `problem_evidence` in a `FEEDBACK NEEDED` blocker that names the
real tradeoff or question—never as completion proof.

When attaching AI-generated evidence files from one verification operation, pass
them in one command (`hotsheet-cli attach <ticket> --actor-role ai --actor-id <worker-id> --purpose correctness_evidence <files…>`)
so they receive one durable batch identity and AI attribution. Use `problem_evidence` for
captures demonstrating a defect, `reference` for supporting material, and `other` only
when none of the semantic purposes fit. Do not run one attach command per file in a set.

Stop early only for an explicit user ticket/time/budget limit, an empty queue, or a
genuine blocker requiring user input or unavailable external state. For that current-
ticket blocker, leave the ticket started and add a `FEEDBACK NEEDED:` note naming the
specific decision or state required. FEEDBACK NEEDED is not deferred-work tracking:
create follow-ups first for independently describable gaps, exhaust safe alternatives,
and continue other independent Up Next work before stopping.

Notes:
- The CLI (`hotsheet-cli …`) and `hotsheet_*` MCP tools use the same engine and work
  without a server.
- Confirm HS2 generation before using connected MCP: `hotsheet-store.json` (directly
  or through `.hotsheet2/store`, with read-only legacy `.hotsheet/store` fallback)
  identifies HS2; `.hotsheet/db/PG_VERSION` identifies
  HS1. If uncertain, use `hotsheet-cli -C <HS2-store>`.
- If a ticket is unclear, do not guess. Record the needed decision, continue independent
  tickets, and return if the answer becomes available.
- When a genuine user decision can be narrowed to concise, distinct options, a
  `FEEDBACK NEEDED` note may include an uppercase `CHOICE` or `CHOICE:` line immediately
  followed by a Markdown list. Options may include attachment references. Use choices
  to make a decision easier, not to offload ordinary implementation judgment or replace
  an open-ended question. Users may select zero or multiple options and may always add a
  freeform response, so do not describe the list as exhaustive or require a selection.
- AI-authored `activity` notes include `--note-summary "Concise outcome"` (or MCP
  `note_summary`) in the same update. Keep it plain-text, one line, outcome-oriented,
  preferably at most 80 characters, and leave implementation/verification detail in
  the full Markdown note body. Activity is timeline history, not the primary result:
  write investigation conclusions, decisions, and important recommendations as `regular`
  Markdown notes, with an optional short activity entry pointing to them.
- Notes support Markdown. For multiline CLI notes, pass real line breaks with
  `hotsheet-cli edit <slug> --note-file <path>` or stdin via `--note-file -`; do not put
  JSON-escaped `\\n` sequences in `--note`. The CLI rejects likely escaped line breaks
  outside inline/fenced backtick code; use `--allow-literal-backslash-n` only when prose
  containing literal `\\n` text is intentional.

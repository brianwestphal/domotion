# Documentation architecture review

This review answers DM-2556. It evaluates the documentation as a system rather
than rewriting individual rendering contracts. The recommended migration is
deliberately incremental: establish reliable navigation and lifecycle metadata
first, consolidate by domain second, and archive historical evidence only after
links and code references are mechanically verified.

## Inventory and diagnosis

As of 2026-08-30, `docs/` contains 243 Markdown files. Of those, 240 use a
numeric filename and span about 37,000 lines; all Markdown documentation spans
about 40,500 lines. The flat numbered series has five duplicate numbers:

- 114: angled linear wipe / exact shaping oracle
- 115: parameterized transition design / production HarfBuzz shaping
- 116: layout-stage parity / transition schema and normalization
- 152: MathML italic token oracle / source-owned text failure boundary
- 228: background-clip text parity / pre-navigation rAF ownership

The number is therefore neither a unique identifier nor a useful reading
order. `docs/README.md` correctly says it is historical authoring order, but its
single 240-row table still makes that history the primary interface.

The largest navigation surfaces are also substantial documents in their own
right:

- `docs/ai/requirements-summary.md`: about 2,500 lines
- `docs/ai/code-summary.md`: about 1,240 lines
- `docs/font-resolution-diagram.md`: about 3,100 lines
- `docs/README.md`: about 190 dense table lines

At least 51 numbered documents contain lifecycle language such as draft,
proposed, retired, superseded, not started, or awaiting feedback. That state is
embedded in prose rather than represented consistently. A reader cannot
reliably distinguish the current normative contract from an investigation,
implementation diary, retained evidence report, or obsolete proposal without
opening and interpreting the whole document.

The subject distribution is heavily skewed. A filename-based conservative
classification finds roughly 67 text/font documents, 25 effects/paint, 26
layout/geometry, 22 image/media, 20 animation, and 32 product/tooling documents.
The text/font cluster alone is about 11,600 lines. This is a strong signal that
domain handbooks, not one flat chronology, should be the primary organization.

## What should remain true

Aggressive consolidation must preserve these properties:

1. A normative requirement has one current owner and one canonical statement.
2. Source citations, exact revisions, evidence hashes, hostile controls, and
   unresolved gaps remain recoverable.
3. Historical Hot Sheet numbers remain searchable as opaque provenance.
4. Code links never silently point at a moved or deleted document.
5. Humans get a short learning path; AI tools get bounded, structured context.
6. Platform support remains explicit: macOS, Linux, and Windows are first-class.

## Recommended information architecture

Replace the flat chronology as the primary interface with four layers.

### 1. Start here

Keep this layer under roughly 1,500 lines total:

- `README.md`: product promise, install, shortest working example, key links.
- `docs/README.md`: audience-based navigation, not the full historical table.
- `docs/product-contract.md`: supported/partial/unsupported behavior.
- `docs/api.md`: public API and CLI reference.
- `CONTRIBUTING.md` or an equivalent engineering workflow page.

### 2. Six normative domain handbooks

Each handbook should state the current behavior and link to implementation and
evidence records without replaying their chronology:

- `docs/handbook/text-and-fonts.md`
- `docs/handbook/layout-and-fragmentation.md`
- `docs/handbook/paint-effects-and-native-controls.md`
- `docs/handbook/images-media-and-embedding.md`
- `docs/handbook/animation-and-interaction.md`
- `docs/handbook/platforms-testing-and-release.md`

Every requirement belongs to exactly one handbook section. Cross-domain rules
are linked, not copied. The text/font handbook should be split internally into
family selection, shaping, geometry, glyph extraction, paint, and fallback so
its unusually large corpus stays navigable.

### 3. Reference and evidence

Move source reconstructions, oracle designs, workflow descriptions, retained
run hashes, and mutation matrices beneath stable topic paths:

- `docs/reference/chromium/`
- `docs/reference/harfbuzz/`
- `docs/reference/skia/`
- `docs/evidence/<domain>/`

Evidence files should describe what a run proved, not restate the full product
requirement. A handbook links to the newest accepted evidence and, when useful,
an evidence index links to superseded runs.

### 4. Archive

Move completed investigations, abandoned proposals, and superseded designs to
`docs/archive/YYYY/`. Archiving is not deletion: preserve original filenames or
record aliases so ticket searches and old links remain resolvable. Archived
documents must begin with a generated banner naming the current replacement.

## Metadata and generated indexes

Add small YAML front matter to every documentation page:

```yaml
---
id: text/font-selection
title: Font selection
kind: contract # contract | reference | evidence | investigation | proposal | archive
status: current # current | partial | proposed | superseded | retired
owners: [capture, render]
platforms: [macos, linux, windows]
supersedes: []
superseded_by: null
tickets: [DM-1234]
code:
  - src/capture/font.ts
---
```

The stable `id`, not the filename number, becomes the link and tooling key.
Generate these artifacts in CI:

- a short human topic index for `docs/README.md`;
- `docs/index.json` for AI retrieval and validation;
- a link/alias map for moved historical files;
- reports for duplicate IDs, broken links, missing owners, invalid lifecycle
  transitions, and two current contracts claiming the same requirement key.

Do not hand-maintain another 240-row prose summary. Generate compact views from
front matter and preserve prose only where it adds meaning.

## Consolidation rules

Use these rules while merging documents:

1. **Current behavior wins.** Put the final invariant in the handbook once.
2. **Why stays nearby.** Retain only the source reasoning needed to prevent a
   likely regression; move long source traces to reference pages.
3. **Proof is linked.** Keep corpus sizes, run IDs, hashes, and mutation lists in
   evidence pages unless they define the actual public contract.
4. **History is archived.** Ticket timelines and superseded alternatives do not
   belong in normative handbooks.
5. **No number-based semantics.** Preserve old numbers as aliases, but do not
   renumber the corpus merely to produce a prettier sequence.
6. **One gap registry.** Replace repeated “known gap” paragraphs with a generated
   registry keyed by stable requirement ID and owning ticket.
7. **One platform statement.** Put shared macOS/Linux/Windows policy in the
   platform handbook; domain pages list only genuine platform differences.

## AI consumption

The current AI summaries are too large to serve as default context. Replace
them with two generated levels:

- a compact manifest containing stable ID, title, kind, status, summary,
  platforms, code paths, dependencies, and canonical file;
- on-demand domain packets containing one handbook section plus its current
  reference and evidence links.

Keep a human-written architecture overview under roughly 400 lines. AI agents
should retrieve relevant packets by stable ID or code path instead of loading a
2,500-line global summary and dozens of chronological documents.

## Migration plan

### Phase 1 — make the corpus trustworthy

- Add front-matter schema and a validator/generator.
- Assign stable IDs and lifecycle kinds without moving files.
- Resolve the five duplicate filename numbers through aliases, not mass
  renumbering.
- Generate topic, status, code-owner, and historical-number indexes.
- Fail CI on broken internal links and duplicate stable IDs.

### Phase 2 — establish the six handbooks

- Start with text/fonts because it is the largest and most interdependent area.
- Extract only current normative statements into handbook sections.
- Mark original pages as reference, evidence, investigation, or superseded.
- Compare every handbook section against implementation paths and current tests
  before calling it current.

### Phase 3 — archive and shrink defaults

- Move superseded/retired/proposal history behind aliases.
- Replace the giant README table and AI summaries with generated compact views.
- Set measurable budgets: no default navigation page over 400 lines, no
  handbook section over 250 lines without a reference split, and no repeated
  normative paragraph across current contracts.

### Phase 4 — continuous enforcement

- Require metadata and an owning code/test path for new current contracts.
- Require a replacement ID when superseding a page.
- Generate documentation packets in the normal check pipeline.
- Review orphaned evidence and proposals quarterly.

## Recommendation

Do not begin with a 240-file rename. That creates enormous link churn without
improving truth. First introduce stable IDs, lifecycle metadata, aliases, and
generated indexes. Then consolidate domain by domain, starting with text/fonts,
while retaining the original documents as evidence or archive pages. This gets
humans a small, coherent reading path and gives AI tools precise retrieval units
without sacrificing the unusually valuable source and parity evidence already
present in the repository.

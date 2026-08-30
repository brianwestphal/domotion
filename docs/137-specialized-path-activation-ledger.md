---
id: "requirements/specialized-path-activation-ledger"
title: "137 — Specialized-path activation ledger"
kind: "contract"
status: "current"
owners: ["rendering"]
platforms: []
tickets: []
code: ["tools/activation-coverage.json"]
aliases: ["docs/137-specialized-path-activation-ledger.md","doc-137"]
---

# 137 — Specialized-path activation ledger

## Requirement

Every specialized rendering mechanism must prove that it participates in the
answer. A passing visual fixture is insufficient when a helper, resolver,
cache, platform branch, generated table, fallback trigger, or representation
boundary could be inert while a generic path happens to produce similar pixels.

[`tools/activation-coverage.json`](../tools/activation-coverage.json) is the
machine-readable registry. Each mechanism links its production owner to one
evidence file containing three distinct controls:

- a positive case that enters the mechanism;
- a negative case that stays on the neighboring path; and
- a mutation/discriminator that changes the answer when the governing input or
  implementation is changed.

`npm run check:activation-coverage` rejects missing owners/evidence, stale
control anchors, duplicate mechanisms, repository-escaping paths, equal
positive/negative controls, and an unrepresented mechanism kind. The focused
tests execute in ordinary CI; the ledger checker ensures their activation
claims cannot silently drift away from renamed or removed cases.

## Visual-review evidence

Every visual-test shard emits `activation-evidence.json` beside its results.
The review server reads that artifact and displays the platform and number of
linked mechanisms. This is provenance, not a claim that the artifact's pixels
passed: it tells the reviewer which positive/negative/mutation controls back the
specialized paths present in that build. Stage-specific evidence and per-region
human classification remain separate work.

## Maintenance rule

Adding a helper operation, resolver shortcut, memo/cache, platform-only branch,
generated decision table, raster trigger, or SVG representation boundary
requires a ledger entry and all three controls in the same change. Reusing a
test is valid only when its positive, negative, and mutation markers genuinely
exercise that mechanism; a filename or broad suite reference is not evidence.

---
id: "requirements/semantic-coverage-inventory"
title: "136 — CSS and SVG semantic coverage inventory"
kind: "contract"
status: "partial"
owners: ["product-tooling"]
platforms: []
tickets: []
code: ["tests/feature-coverage.ts","tools/parity-program.json","tools/semantic-coverage.json"]
aliases: ["docs/136-semantic-coverage-inventory.md","doc-136"]
---

# 136 — CSS and SVG semantic coverage inventory

## Requirement

Parity coverage is tracked at the level of rendering **state transitions**, not
at the level of property names. Saying that `transform` or `font-family` has a
fixture does not establish coverage of affine-to-projective ownership,
declared-face-to-platform-fallback routing, or any other decision branch.

[`tools/semantic-coverage.json`](../tools/semantic-coverage.json) is the
machine-readable inventory. Every transition family records:

- the CSS/SVG subjects and explicit `before -> after` states;
- a complete partition of those states into `exactStates` and
  `uncoveredStates`, so a partial family cannot hide which branches are proven;
- pinned Chromium/Skia/HarfBuzz/ICU source owners;
- Domotion production owners;
- structured stage oracles, metamorphic tests, and visual fixtures;
- platforms on which that evidence has run;
- whether coverage is `exact`, `partial`, or `unsupported`; and
- an explicit boundary for every non-exact row.

The inventory complements, and does not replace, the public-feature index in
`tests/feature-coverage.ts` or the pipeline-area matrix in
`tools/parity-program.json`. The former guards documented API behavior; the
latter describes evidence programs by rendering stage; this inventory answers
which semantic transitions those programs actually cover.

## Enforcement and report

`npm run check:semantic-coverage` validates the inventory and prints every
non-exact state transition with its family boundary. It fails for duplicate
IDs, repository-escaping or stale file references, malformed transition
descriptions, unknown feature/parity/fixture IDs, unclassified states, unknown
platforms/statuses, missing boundaries, or an `exact` claim without
all-platform oracle, metamorphic, and visual evidence. Every transition-bearing
public feature must link to a family or carry an explicit exclusion reason.

The ordinary CI gate permits explicitly documented gaps. Release validation
may run `npm run check:semantic-coverage -- --fail-on-gaps`; that command fails
until every row is exact. This distinction makes gaps visible without forcing
the repository to lie about current support while the parity program is still
closing them.

## Maintenance rule

Any new production semantic branch must add or update an inventory row in the
same change. A new property value is not automatically a new row: group values
only when they share one upstream decision procedure, production owner, and
evidence set. Split a row when one state crosses a different representation or
ownership boundary. Never upgrade a row to `exact` from screenshot percentages
alone.

---
id: "requirements/parity-release-gate"
title: "138 — Near-complete Chromium parity release gate"
kind: "evidence"
status: "partial"
owners: ["platform-release"]
platforms: ["macos","linux","windows"]
tickets: []
code: ["tools/parity-release-evidence.json"]
aliases: ["docs/138-parity-release-gate.md","doc-138"]
---

# 138 — Near-complete Chromium parity release gate

`npm run gate:parity-release` is the strict release decision. It does not emit a
confidence percentage. It emits `READY` only when every enforceable condition
is satisfied; otherwise it names each blocker and every explicit unsupported
boundary. `--report-only` prints the same report without changing the exit code.

The gate combines the source/parity area matrix, semantic transition inventory,
specialized-path activation ledger, exact stage-oracle reports, and reviewed
visual evidence in `tools/parity-release-evidence.json`. A release requires:

- no `partial` semantic family (an intentionally unsupported family is allowed
  only with an explicit boundary);
- every parity area source-audited, exact at its logical stage, and covered on
  macOS, Linux, and Windows;
- a passing, revision-matched report for every stage oracle;
- fresh reviewed feature, showcase, HTML, Unicode, and real-world suites on all
  three platforms with comparable environment fingerprints;
- every residual explained and classified, with no logical residual remaining;
- no unjustified relaxed threshold; and
- a valid positive/negative/mutation ledger for every registered specialized
  mechanism.

The checked-in evidence file intentionally starts incomplete. It is a release
attestation, not a baseline to make green by weakening predicates. CI may run
the report-only form for visibility; the strict command belongs at the release
boundary after the full evidence sweep and human review.

Dependency rolls additionally run `npm run stage:evidence:compare-roll`; see
[doc 160](160-chromium-roll-differential-audit.md). A changed stage cannot be
accepted from visual baselines alone: its review must identify upstream source,
classify the delta, and name updated logical rows when semantics changed.

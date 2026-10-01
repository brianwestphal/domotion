---
id: "requirements/tool-report-envelope"
title: "Tool report envelope"
kind: "contract"
status: "current"
owners: ["tools"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-AP6BPA", "DM-N6XJRS", "DM-31KJ0F", "DM-49WRZZ", "DM-XCR4NJ"]
code: ["tools/lib/report.ts", "tools/conformance-report-schemas.ts"]
aliases: ["docs/267-tool-report-envelope.md", "doc-267"]
---

# Tool report envelope

Migrated oracle and gate JSON files use a common outer record: `schemaVersion`, `tool`, `generatedAt`, `env`, and `data`. `schemaVersion` and `tool` identify the contract. `generatedAt` is an ISO timestamp, and `env` holds available run environment details. The existing report fields live in `data`; migrated command outputs also include `data.outcome` as `pass`, `fail`, `skip`, or `error`. A measured mismatch is `fail`, while an unavailable measurement is `skip`.

`writeReport` creates parent directories for `--json` destinations. Readers validate the envelope, including the expected tool and version, with a Zod schema before using its data. During migration, `readReportData` accepts a legacy shape only when the caller supplies its schema; flat legacy records with their own version also require an explicit `legacySchemaVersion`. It rejects unknown envelope and legacy versions rather than treating them as arbitrary data. Producers and their direct consumers migrate together.

The paint order, paint geometry, browser paint geometry, raster boundary, transform geometry, replaced ownership, pseudo fragment geometry, generic family preference, system UI preference, layout stage, mixed bidi, renderer font route, unified shaping, font palette paint, collapsed border fragmentation, and border phase commands write this envelope at schema version 1. The conformance report families use the same boundary; their reader schemas define the supported legacy form.

The animated culling geometry, timeline sampling ownership, text affine baseline protocol, text fragment span, and SVG effect combination oracles also write schema version 1 envelopes. Their earlier source fingerprints, verdicts, and tool-specific schema fields stay inside `data`, alongside normalized `data.outcome`. The timeline ownership command keeps its existing raw JSON stdout shape; `--json` writes the envelope. Their CI workflows upload the report files as artifacts and do not parse their internal fields.

The animated projective frame, vertical orientation, broken image fallback, and Linux terminal mask oracles write the same envelope for their JSON artifacts. The vertical orientation command keeps its existing stdout shape. The border phase ratifier accepts its earlier flat version 2 oracle report during transition and validates the new envelope before adjudication.

Browser HarfBuzz substitution and Linux MathML Greek raster reports use versioned envelopes for both produced rows and aggregate decisions. Their aggregate readers validate the envelope and accept only an explicitly described legacy row shape. The dynamic font palette gate writes its artifact report in the envelope; its in-memory paint-gate consumer keeps the typed report value.

The background clip text oracle also writes an envelope at schema version 1. Its native Linux/Windows gate reads and validates the envelope, accepts only the former flat version 2 report as legacy input, and retains its existing stdout verdict format.

The native scrollbar ownership audit and projective owner release producer write version 1 envelopes around their existing version 2 domain records. Their release checkers validate the outer envelope and inner domain schema before reading relative artifacts; only explicit flat version 2 legacy reports are accepted. The nested projective audit also writes an envelope around its prior version 1 record. Artifact paths, content hashes, and CLI stdout formats remain unchanged.

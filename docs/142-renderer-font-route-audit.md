# Renderer font-route audit

Status: **Investigation complete (DM-2348)**

Source baseline: Chromium `7d859f271cbda744098ac69f44978d4edfa62be3`,
HarfBuzz `4de187dd0a91`. This audit is deliberately about the production
`renderTextAsPath` funnel, not just `resolveFontForCodepoint` in isolation.

## Chromium's ownership model

Blink does not ask a per-codepoint resolver for the final painted face. For each
script/bidi segment, `HarfBuzzShaper::ShapeSegment` constructs one
`FontFallbackIterator`, shapes a candidate over the queued ranges, commits
clusters whose glyphs are nonzero, and requeues the remaining clusters
(`harfbuzz_shaper.cc:965-1144`). The iterator walks declared/segmented faces,
fallback-priority faces, one system-font answer per hint, last resort, and then
the first candidate for `.notdef` (`font_fallback_iterator.cc:120-229`).
`ShapeResultRun` retains the chosen `SimpleFontData` together with
`HarfBuzzRunGlyphData` (`shape_result_run.h:55-75, 257-418`). Thus the logical
unit that reaches paint is a shaped run: face plus glyph/cluster/position data.

The standalone Domotion resolver oracle remains necessary: it proves the
`kSystemFonts` answer. It is not sufficient to prove the final renderer,
because that answer may never be asked for, may be rejected after shaping, or
may be preceded by a declared or priority face.

## Production decision inventory

| Production mechanism | Resolver's role | What reaches emission | Current activation evidence | Remaining proof gap |
| --- | --- | --- | --- | --- |
| Primary and later declared families | None until those faces shape `.notdef` | The caller's exact primary instance or a declared/webfont partition | Cluster tests cover primary and segmented webfont acceptance | No per-run source/member/axis record tied to emitted glyphs |
| Shape-then-requeue cluster fallback | The resolver supplies only the `system` iterator stage | Contiguous `FontRun`s, then a same-face HarfBuzz shaping proxy | `_clusterFallbackCounters`, cluster tests, and `DOMOTION_CLUSTER_FALLBACK=0` A/B | Counters prove invocation, not which selected source produced each emitted glyph |
| Legacy per-codepoint fallback | It is the whole assignment procedure | Per-codepoint runs, followed by a HarfBuzz shaping override | Flag-off and decline tests exercise it | A decline is not recorded with its reason; an artifact cannot distinguish flag-off from an unopenable face |
| Priority emoji face | Bypassed for the one-shot priority candidate; the resolver may run afterward | Color-capable run or later fallback | Cluster priority counters and font-variant-emoji tests | Raster-overlay ownership can replace vector emission after this choice |
| Dotted-circle pinned span | Bypassed; `resolveDottedCircleHbRun` selects the mark companion face first | A forced single-face dotted-circle/mark run | Focused dotted-circle tests | Candidate gates are non-Blink and tracked by DM-2393 |
| Math/NFD decomposed commit | Resolver returns substituted text and a face; the cluster loop commits it directly | A run whose emitted text differs from its source span | Resolver decomposition tests | This is deliberately outside Blink's iterator and is included in DM-2387 |
| Feature and general HarfBuzz overrides | Selection is already complete | A proxy that preserves the selected outline/source face and changes shaping only | Exact shaping controls move features/script/language/direction | The proxy identity is not joined to the eventual glyph definition/subset |
| Paths emitter | The selected `FontRun` is consumed directly | `<path>` definitions and `<use>` placements | Glyph-path run tests | Glyph IDs are globally renumbered into `gN`; the SVG cannot recover face/file/axes or the selecting mechanism |
| Embedded-font emitter | The selected `FontRun` is consumed directly | PUA-mapped `<text>` plus hb-subset or svg2ttf bytes | `EmbeddedFontBuildDiagnostic` proves aggregate source/builder state | Diagnostics have no source spans, selected keys, clusters, or embedded-decline reason |
| Embedded decline to paths | Both emitters rerun from the same entry inputs | Paths output after a null embedded result | Mode-parity tests exercise successful arms | The transition and null reason are not recorded, so activation cannot be proven from a result artifact |
| Raster glyph overlay | Vector selection can be suppressed for captured raster-owned spans | Captured PNG region plus vector remainder | Raster-boundary oracle and emoji fixtures | Production ownership still depends on hardcoded capture-side emoji gates; DM-2392 owns removal |
| Raw `<text>` fallback in `text.ts` | The original decision is discarded | The consumer browser resolves the captured CSS family again | Partial/all-raster suppression tests | This is an unowned second font-selection pass; DM-2399 owns its removal or explicit degraded-boundary classification |

## Findings

1. **The default cluster path does not simply bypass the resolver.** It embeds
   `resolveFontForCodepoint` at the same conceptual system-font stage as Blink.
   Comparing every final run directly to an isolated resolver answer would
   create false failures whenever a declared, priority, last-resort, or
   first-candidate face correctly wins.
2. **Post-selection shaping overrides preserve face ownership.** The general
   HarfBuzz proxy and feature-value proxy change `layout`, not the underlying
   outline/source object. Synthetic bold/oblique and embedded rebuilding change
   emitted geometry, but not which face supplied the source glyph.
3. **There are four genuine alternate assignment owners:** the legacy decline
   path, dotted-circle pinning, decomposed commits, and emoji priority. The
   existing DM-2387, DM-2393, DM-2392, and DM-2330 tickets already own their
   logical reconciliation; this audit does not duplicate them.
4. **Current artifacts cannot prove the end-to-end claim.** Paths mode loses
   face provenance when glyph definitions receive global `gN` IDs. Embedded
   mode reports aggregate builder provenance only after a successful build.
   Neither records why the shaped splitter declined, why embedded mode fell
   back, or which source span used which mechanism.
5. **No new production face divergence was proven by static/source audit.** The
   unresolved issue is observability, not evidence that a particular current
   run is wrong. DM-2398 must add a renderer ledger and join it to the unified
   Chromium evidence before this area can claim exact end-to-end coverage.
6. **Raw `<text>` fallback is a separate correctness risk.** It delegates a
   second face-selection pass to the SVG consumer, which need not have the
   capture host's font inventory or fallback rules. DM-2399 isolates that work.

## Required renderer-facing record

DM-2398 should record, per source span, the request tuple; segment and decision
mechanism; selected logical key; concrete source path, collection member,
PostScript name, and axes from `getFontSourceInfo`; HarfBuzz glyph IDs, clusters,
advances, and offsets; emitter mode; embedded builder/subset identity or path
definition identity; and every decline/terminal reason. Its controls must make
each mechanism move independently. The final comparison must join those records
to Chromium painted faces and origins from the DM-2341 unified oracle, while
retaining the standalone resolver oracle as the narrower system-stage proof.

Related follow-ups: DM-2398 (renderer ledger/oracle), DM-2399 (raw-text
rerouting), DM-2387 (cluster state machine), DM-2393 (dotted circles), DM-2392
(emoji ownership), and DM-2330 (`font-variant-emoji`).

# Renderer font-route audit

Status: **Investigation complete (DM-2348); renderer ledger shipped in DM-2398**

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
| Legacy per-codepoint fallback | It is the whole assignment procedure | Per-codepoint runs, followed by a HarfBuzz shaping override | Only the explicit `DOMOTION_CLUSTER_FALLBACK=0` arm exercises it | Default shaping never restarts here after an unopenable candidate; the route oracle records `cluster-disabled-legacy` only for the mutation arm |
| Priority emoji face | Bypassed for the one-shot priority candidate; the resolver may run afterward | Color-capable run or later fallback | Cluster priority counters and font-variant-emoji tests | Raster-overlay ownership can replace vector emission after this choice |
| Dotted-circle shaping | The resolver may supply the ordinary system-stage candidate; no mark face is pinned | The authored range shaped on the iterator-selected face; HarfBuzz alone may insert U+25CC | Orphan/explicit-circle exact records plus the cluster-disabled mutation | Capture compatibility rewrites remain separately classified; they are not fallback owners |
| Canonical decomposition | The resolver may supply candidate coverage evidence; substituted text is not committed | The authored range shaped by that candidate's HarfBuzz normalizer | Menlo composition and broad exact glyph/cluster/advance rows | Helper-absent legacy decomposition remains confined to the explicit legacy route |
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
3. **DM-2387 removed the implicit alternate assignment owners.** Dotted-circle
   insertion and canonical decomposition now occur inside shaping the current
   iterator candidate, and an unopenable candidate cannot restart the run with
   per-codepoint assignment. The explicit flag-off legacy arm and Blink's
   in-iterator emoji-priority stage remain independently observable.
4. **DM-2398 closed the representative observability gap.** The opt-in
   production ledger now retains per-span mechanism, concrete source, shaping,
   emitter identity, and embedded-to-path transition evidence and joins its
   representative cases to Chromium faces/origins. The corpus remains
   representative rather than exhaustive (doc 143).
5. **No new production face divergence was proven by static/source audit or the
   first renderer ledger.** Future assignment owners must add a route case and
   independent control before they can inherit that claim.
6. **Raw `<text>` fallback is a separate correctness risk.** It delegates a
   second face-selection pass to the SVG consumer, which need not have the
   capture host's font inventory or fallback rules. DM-2399 isolates that work.

## Required renderer-facing record

DM-2398 records, per source span, the request tuple; segment and decision
mechanism; selected logical key; concrete source path, collection member,
PostScript name, and axes from `getFontSourceInfo`; HarfBuzz glyph IDs, clusters,
advances, and offsets; emitter mode; embedded builder/subset identity or path
definition identity; and every decline/terminal reason. Its controls must make
each mechanism move independently. The final comparison must join those records
to Chromium painted faces and origins from the DM-2341 unified oracle, while
retaining the standalone resolver oracle as the narrower system-stage proof.

Related implementation/follow-ups: DM-2398 (renderer ledger/oracle), DM-2399 (raw-text
rerouting), DM-2387 (cluster state machine), DM-2393 (dotted circles), DM-2392
(emoji ownership), and DM-2330 (`font-variant-emoji`).

---
id: "requirements/production-text-run-provenance"
title: "Production text-run provenance"
kind: "contract"
status: "current"
owners: ["text-fonts"]
platforms: ["macos"]
tickets: ["DM-2387","DM-2398","DM-2399","DM-2410","DM-2423","DM-2428","DM-2567"]
code: []
aliases: ["docs/143-production-text-run-provenance.md","doc-143"]
---

# Production text-run provenance

Status: **Shipped (DM-2398)**

`npm run fonts:renderer-route -- --json <path>` observes the actual
`renderTextAsPath` funnel. It complements, rather than replaces, the exhaustive
per-codepoint resolver oracle and the unified face/shaping oracle.

The ledger is disabled by default. An oracle or focused test enables it with
`setTextRunProvenanceEnabled(true)`, resets it per case, renders normally, and
reads `getTextRunProvenance()`. Ordinary captures therefore perform no extra
shape or serialization work.

Each selected run records:

- source UTF-16 span and emitted text;
- the final assignment owner: declared family, priority emoji, system resolver,
  last resort, first-candidate `.notdef`, or explicitly cluster-disabled
  legacy. Dotted-circle insertion and canonical decomposition are shaping
  outcomes on one of those owners, not separate assignment mechanisms;
- the complete CSS request tuple relevant to face/shaping selection, plus the
  itemized ISO 15924 script actually passed to the production shaper;
- logical font key plus concrete PostScript name, source path, collection
  member, variation axes, and HarfBuzz ownership;
- glyph IDs, clusters, advances, and offsets from the selected production
  shaping instance, plus the SHA/count identity and ownership disposition of
  the exact resolved command stream handed to the emitter (DM-2567); and
- emitter and stable emitted identity, plus embedded-success,
  embedded-decline-to-paths, path-success, path-decline, or source-owned
  boundary transitions. DM-2399 adds the exact decline reason and UTF-16
  degraded spans to those rows.

DM-2423 makes that recorded script operational rather than descriptive: the
ledger shapes with `FontRun.shapingScript`, the same value used by embedded and
path emission. It also observes source/member metadata on the iterator-selected
HarfBuzz run, so a dotted-circle record proves both the selected face and its
final glyph stream instead of silently reshaping the face as Common for
diagnostics.

The representative browser oracle covers declared, system, emoji-priority,
dotted-circle, `.notdef`, embedded, and legacy owners. Its mutation controls
require paths versus embedded mode, cluster enabled versus disabled, feature-on
versus feature-off glyph output, and Chromium painted origins all to move. It
joins each case to `CSS.getPlatformFontsForNode` and per-scalar `Range` origins,
and withholds its verdict on any comparable face disagreement.

DM-2387 expands that oracle to 29 rows. Distinct orphan and explicit-circle
inputs, canonical composition, and Latin/Arabic/Devanagari/Bengali/Thai/
Myanmar/Khmer/Brahmi counterexamples require exact nonempty glyph ids, clusters,
advances, and offsets, and each selected-face glyph count must equal Chromium's
CDP count. Every shaped row must preserve its authored source slice, no enabled
row may report `cluster-disabled-legacy`, and the dotted-circle pair must
produce distinct selected glyph records. A focused feature mutation also
forces the primary to `.notdef` and proves that every later candidate probe
receives the same resolved feature list.

DM-2410 adds a macOS whole-sequence record for `❤️ ⚡️ VS16 wins` under
`font-variant-emoji:text`. It joins explicit-VS precedence, the two Apple Color
Emoji selected runs, Helvetica suffix run, shaped advances, and selected
`sbix` spans in one record. A paired `DOMOTION_CLUSTER_FALLBACK=0` case is an
ungraded negative control: it must report `cluster-disabled-legacy` and a
different raster-span result. This prevents a passing per-codepoint/common
branch from masquerading as evidence for the production sequence route.

DM-2428 adds four mixed-bidi lines in both cluster-fallback modes: digits in an
RTL context, pointed Hebrew, adjacent Hebrew/Arabic, and mirrorable brackets.
The joined report now carries each shaping segment's UTF-16 boundary, resolved
bidi level/direction and script beside the selected face/glyph stream, captured
x origin, and snapped baseline. A coalesced-boundary mutation and a
paired-bracket-mirroring-disabled mutation must both move their target record.
Pixel grading remains explicitly separate (`rasterPhase:
"separate-visual-oracle"`), so a thin outline-only Skia floor cannot be reported
as a logical placement failure or broaden a tolerance.

The demo-review font-selection card is a composite gate: both the broad unified
face/shaping report and this production-route report must pass. The raw child
reports remain embedded in the artifact so a failure retains stage ownership.

Boundaries remain explicit. The route corpus is representative, not an
exhaustive Unicode sweep; add a case and independent mutation whenever a new
assignment owner or emitter transition lands. A protected face whose physical
member is unknowable retains `faceIndex: null`. DM-2399 closes raw
consumer-browser `<text>` rerouting after total or partial vector failure; see
[doc 152](152-source-owned-text-failure-boundary.md). A missing outline is now
visible in this ledger as an exact source-owned terminal rather than being
reshaped outside it.

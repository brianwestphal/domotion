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
  last resort, first-candidate `.notdef`, dotted-circle pin, decomposed commit,
  cluster-disabled legacy, or cluster-decline legacy;
- the complete CSS request tuple relevant to face/shaping selection, plus the
  itemized ISO 15924 script actually passed to the production shaper;
- logical font key plus concrete PostScript name, source path, collection
  member, variation axes, and HarfBuzz ownership;
- glyph IDs, clusters, advances, and offsets from the selected production
  shaping instance; and
- emitter and stable emitted identity, plus embedded-success,
  embedded-decline-to-paths, path-success, or path-decline transitions.

DM-2423 makes that recorded script operational rather than descriptive: the
ledger shapes with `FontRun.shapingScript`, the same value used by embedded and
path emission. It also observes source/member metadata copied onto a
resolver-pinned HarfBuzz proxy, so a dotted-circle record proves both the
selected face and its final glyph stream instead of silently reshaping the face
as Common for diagnostics.

The representative browser oracle covers declared, system, emoji-priority,
dotted-circle, `.notdef`, embedded, and legacy owners. Its mutation controls
require paths versus embedded mode, cluster enabled versus disabled, feature-on
versus feature-off glyph output, and Chromium painted origins all to move. It
joins each case to `CSS.getPlatformFontsForNode` and per-scalar `Range` origins,
and withholds its verdict on any comparable face disagreement.

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
member is unknowable retains `faceIndex: null`. Raw consumer-browser `<text>`
rerouting after total vector failure is outside this ledger and tracked by
DM-2399.

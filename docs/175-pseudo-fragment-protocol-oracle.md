# 175 — Chromium pseudo-fragment protocol oracle

**Ticket:** DM-2466

**Status:** structural decoder/live oracle complete; DM-2467 production capture now shares the decoder (doc 176), direct rendering remains DM-2468

**Source pins:** Chromium `7d859f271cbda744098ac69f44978d4edfa62be3`,
HarfBuzz `4de187dd0a915d13c976fa8bd474c084229f3aab`, and Chromium-pinned
Skia `62efacd37737505732dbe3d8daa62abd679626a1`

## Outcome

`src/capture/pseudo-fragment-protocol.ts` defines the source-owned intermediate
record proposed by doc 157; `tools/pseudo-fragment-protocol.ts` is its thin
oracle/test compatibility re-export. The decoder correlates one host and pseudo type with ordered
generated content items, box fragments, text/image fragments, UTF-16 source
slices, visual order, physical quads, fragmentainer translations, logical edge
ownership, shaped inline advances, and writing-mode-aware paint baselines.

`tools/pseudo-fragment-geometry-oracle.ts` obtains those facts from an untouched
live document. It assigns durable fixture correlation attributes, pierces the
CDP document once to find the real `::before`/`::after` backend nodes, takes one
`DOMSnapshot.captureSnapshot` layout epoch, and pairs its anonymous layout/text
rows with ordered `DOM.getContentQuads` results. It does not create, detach, or
lay out a clone.

A fresh macOS run against Playwright Chromium `147.0.7727.15` passed all 80
scenario/DPR rows and rejected all 10 mutations:

```text
pseudo fragment geometry oracle: 80/80 rows; 10/10 mutations;
147.0.7727.15; source-exact
```

Run it with:

```bash
npm run pseudo:fragment-geometry-oracle
```

Use `-- --json <path>` to retain the complete fingerprinted record. The report
records the browser, Playwright version, operating system, architecture, device
scale factor, all three source pins, protocol inputs, decoded records, state
coverage, and mutation evidence.

DM-2467 subsequently installed this same decoder in the production prepass;
[doc 176](176-source-owned-pseudo-fragment-capture.md) documents the private
frame registries, selected-face facts, exact-record schema, legacy projection,
and isolated Chromium surface failure boundary. The 80-row oracle remains the
independent structural decision proof rather than being duplicated inside the
capture implementation.

## Source-owned decoding boundary

Blink creates one anonymous layout child for each generated text/image
`ContentData` item. Accordingly, the decoder treats every text-bearing layout
row as a distinct text content item and every remaining anonymous child row as
an image item; offsets restart for each item. `TextBoxSnapshot.start/length`
are preserved and sliced as JavaScript UTF-16 units. An astral row proves that
the decoder does not reinterpret them as code-point indexes.

Snapshot text boxes retain their protocol order. That order is Blink's
post-bidi visual order, so the decoder never sorts by source offsets. Adjacent
anonymous child boxes whose block-axis intervals overlap form one local visual
fragment; a block-axis transition starts the next. The ordered groups must
pair one-for-one with `DOM.getContentQuads`. A count mismatch is classified as
ambiguous and returns no fragments.

For an untransformed fragmented pseudo, the paired quad supplies the physical
translation that `DOMSnapshot` omits. The multicol rows specifically show
repeated fragmentainer-local snapshot coordinates moving into three distinct
physical columns. For transformed rows, each local border box is mapped onto
the full four-point protocol quad, rather than being reduced to an axis-aligned
union.

Logical edge ownership follows `box-decoration-break`: `slice` gives the first
fragment its inline-start border/padding and the last fragment its inline-end
edge, while `clone` gives both to every fragment; block edges belong to every
fragment. Asymmetric physical border/padding values validate that mapping.
Margins remain explicit style facts but do not get folded into a content quad,
which represents the border box.

## Baseline transcription

The baseline helper is a direct transcription of Blink
`TextFragmentPainter` and `LineRelativeRect`, not a fitted line-height formula.
It starts with the final text fragment and the selected primary font's ascent:

- `horizontal-tb`: `(left, top + ascent)`, advancing right;
- `vertical-rl`, `vertical-lr`, and `sideways-rl`:
  `(right - ascent, top)`, advancing down; and
- `sideways-lr`: `(left + ascent, bottom)`, advancing up.

The live collector records an independent Chromium canvas-shaped advance and
the protocol fragment advance. The decoder retains both; it never scales one
to conceal a mismatch.

## Matrix and negative controls

The generated matrix covers content `none`, `normal`, empty, and string;
before/after; in-flow, absolute, and fixed placement; normal and explicit line
height; every Blink vertical-align class; LTR/RTL mixed bidi; horizontal,
vertical, and sideways writing; one/two/three-line wrapping; multicolumn
fragmentation; asymmetric slice/clone edges; text/URL/text anonymous children;
inline-block/flex/grid hosts; zoom, DPR 1/2, affine transforms, fractional
origins, scrolling, short text, and unpainted pseudos.

The structural verifier rejects the ten doc-157 mutations: font-size
half-leading, host-baseline copying, fragment unioning, source-order bidi,
missing fragmentainer translation, concatenated content items, wrong edge
ownership, horizontal baseline math in vertical writing, code-point offsets,
and a dropped anonymous image. Protocol unavailable, no-layout, malformed
geometry, invalid UTF-16 ranges, and group/quad ambiguity are explicit closed
states, never a silent legacy host anchor.

## Deliberate production boundary

This ticket establishes the decoder and independent stage gate only. Current
captures still use `pseudo-content.ts`/`pseudo-inject.ts`; no renderer tolerance
or legacy pseudo placement behavior changed. DM-2467 may now integrate this
record into capture with a scoped Chromium-painted fallback. DM-2468 remains
responsible for consuming it in paint order and for the independent
all-platform pixel/ink gate.

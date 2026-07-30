# Per-region size guard (frame-sequence compressor)

The frame-sequence compressor (`docs/100-rich-text-editing.md`) composes N
captured "states" of a page into one animated SVG. Compression is
pixel-identical to the uncompressed flipbook but **not unconditionally smaller**:
a wholesale-change run (a slideshow, where consecutive states share almost
nothing) pairs badly, re-emits nearly everything as births/deaths, and pays the
chrome-union + track overhead on top.

DM-1764 added a **whole-run** size-regression guard: if the compressed run came
out larger than the same states rendered uncompressed (`composeStatesFlipbook`),
revert the whole scene to the flipbook — so `autoCompress` can never make output
worse. DM-1772 makes that guard **per region**: it no longer reverts the whole
scene when one pane pairs badly; it demotes only what is worth demoting, decided
on real bytes.

This doc is the canonical spec for that decision. It is a lockstep reference for
`src/cli/animate.ts` (`buildStatesRunContent`'s guard) and
`src/animation/compressed-run.ts` (`extractState` / `buildCompressedRunPlan` /
`composeCompressedRun`); a change to either must update this doc.

## Regions

A *region* is the discriminator the compressor buckets glyph-layer text by
(docs/100 "Independent regions in one scene"), keyed as a string:

- `R<x>,<y>,<w>,<h>` — the innermost **clipping ancestor** (rounded box geometry).
- `D<animId>` — an explicit **declared** region root (`CompressedRunOptions.regionRootIds`).
- a **side-by-side column** taller than one line box (auto-detected).
- `""` — text in none of the above (the scene's un-regioned "main" content).

The distinct region keys a compose bucketed text into are returned as
`CompressedRunResult.regions` (first-appearance order). These are the candidate
keys the guard trials.

## Demotion

**Demoting** a region means moving its text out of the animated glyph layer and
into the chrome union — exactly the path *ineligible* text already takes
(occluded text, decorated/RTL/complex-script text, etc.). It is therefore
**pixel-safe by the same argument**: the chrome tree flipbooks that text in
place, so the painted result is unchanged.

Mechanically, a region key in `CompressedRunOptions.demotedRegions` forces every
element whose region matches to fail the eligibility gate in `extractState`, so
the chrome-clone's `strip` leaves its `textSegments` intact instead of pulling
them into the glyph layer.

Regions are **pixel-independent**: the occlusion promotion check
(`paintOrderHitSequence`, whole-tree) that decides whether text may join the
glyph layer is a property of the whole scene, not of any one region, so demoting
region A can never change region B's promotion decision. This is what lets the
guard decide each region on its own.

## The decision procedure

The trigger `compressedBytes / rawBytes` is free (the compressor already reports
both sides) and only **arms** the guard — it never decides. The choice is made on
**real bytes** among three pixel-identical candidates, and only for runs the
*automatic* pass created (`wasAutoCollapsed`); a hand-authored `states:` block or
`compress: true` marker is never silently rewritten (it gets a warning pointing
at `compress: false`).

The arming ratio differs by who asked for the run:

| Run | Constant | Ratio | Why |
|---|---|---|---|
| automatic (`wasAutoCollapsed`) | `COMPRESS_SIZE_GUARD_AUTO_RATIO` | `> 1` | Any failure to shrink the chrome is reason to price the alternatives. Since the decision is on measured bytes and ties keep the compressed form, arming can only find wins, never cost output — it costs a few speculative composes. |
| author-written (`states:` / `compress: true`) | `COMPRESS_SIZE_GUARD_RATIO` | `> 1.02` | This path only warns, so the 2% cushion keeps a run that merely ties on bytes from drawing a warning. |

The automatic path used the 2% cushion too until it was found to leave large
wins on the table: a mixed-pane scene (a well-pairing code pane beside a
wholesale-change slide pane) compressed to 1.008× — under the cushion, so nothing
armed and it shipped 69.9 KB, where demoting the slide pane into the chrome union
measured 57.3 KB. Whether a scene lands at 1.008× or 1.02× also moves with
unrelated renderer changes (any few-hundred-byte shift in the uncompressed chrome
re-scales the ratio), which made a 12 KB decision hinge on an arbitrary cushion.

Each candidate is **sized in a speculative trial** bracketed by
`snapshotGeneration()` / `restoreGeneration()` (doc 99 § speculative composition,
DM-1771) so a discarded compose's PUA codepoint / `dmfN` family addressing —
handed out in first-use order from the module-global, `manageFonts: false`
shared builder — never leaks into the real output. Only the winning candidate is
re-composed after rolling the builder back, so it alone owns the addressing.

The three candidates:

1. **keep-all** — the compressed run as first composed.
2. **per-region demotion** — trial each region in `run.regions` demoted alone;
   demote every region whose demotion shrinks the run. Because regions are
   pixel-independent, demoting the set of individually-beneficial regions is the
   minimum. Demoting *all* regions is the whole chrome union.
3. **`composeStatesFlipbook`** — the uncompressed flipbook, retained as a
   candidate (the never-worse floor).

The guard emits the **smallest**, with two tie rules: keep-all wins ties (never
rewrite when nothing helps), and demotion wins over the flipbook on a tie (chrome
demotion is the primary fallback).

### Why keep the flipbook floor

Chrome demotion beats the flipbook **only when states share subtrees the union
deduplicates**. On the mixed fixture below that is a 2× win (81.8 vs 97.8 KB).
But for a *pure* wholesale slideshow the union can't dedupe and comes out
slightly larger than the flipbook, so dropping the flipbook entirely would
regress the DM-1764 guarantee that `autoCompress` never grows output. Keeping
`composeStatesFlipbook` as a candidate — rather than *replacing* it with chrome
demotion — is what preserves that guarantee while still taking the demotion win
where it exists. (The DM-1772 ticket framed item 3 as "switch the fallback to
chrome demotion"; the shipped guard keeps the flipbook as a floor for exactly
this reason.)

## Measured (the mixed fixture)

A well-pairing editor pane beside a wholesale-change slideshow pane, 6 states,
97.3 KB of raw flipbook payload:

| candidate | composed bytes |
| --- | --- |
| compress both regions (keep-all) | 172.1 KB (1.77× raw) |
| demote the wholesale-change region only | 83.2 KB |
| demote the well-pairing region only | 170.9 KB |
| demote both (per-region minimum) | **81.8 KB** |
| `composeStatesFlipbook` (uncompressed floor) | 97.8 KB |

The guard here demotes both panes (each shrinks the run) → 81.8 KB, beating both
keep-all and the flipbook. Demoting the *wrong* subset (the well-pairing pane
only) would be 170.9 KB — larger than the flipbook — so the guard would fall to
the flipbook instead; a demotion that beats the flipbook is only reachable by
demoting the right region(s).

## Cost

One trial compose per candidate region plus the two fallbacks, ~80–135 ms each
on the two-pane fixture. N-region scenes do N + O(1) composes; the search is not
2ᴺ (regions are decided independently, not in combination).

## Tests

- `tests/compress-size-guard.e2e.test.ts` — the guard: a pure wholesale run
  reverts to the flipbook floor; a well-pairing run is left compressed; and the
  **mixed two-column fixture** trips the guard, chooses chrome demotion, beats
  the flipbook (proof it demoted the right region), holds pixel parity at every
  state via `expectFlipbookParity`, and is **byte-identical when re-composed**
  (the snapshot/restore leaves no trace).
- All 26 animate goldens stay byte-identical (no golden trips the guard).
- `src/render/embedded-font-snapshot.test.ts` — the underlying byte-identity of
  `snapshotGeneration()` / `restoreGeneration()` (DM-1771).

See also `docs/100-rich-text-editing.md` (the compressor + regions),
`docs/43-declarative-animate-config.md` (`autoCompress` / `compress` config), and
`docs/99-hinted-embedded-subset.md` (speculative composition).

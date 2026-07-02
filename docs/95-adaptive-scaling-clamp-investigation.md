# 95 — Adaptive scaling: CSS `clamp()` / viewport-unit alternative (investigation)

**Status: investigation only (DM-1561). No production change.** DM-1541 ships
adaptive per-ratio type scaling as a single `formatScaleFactor` (√ usable-area
ratio, `src/templates/formats.ts`) applied uniformly to a card's authored px
sizes. This doc evaluates the raised alternative: author the cards in CSS
`clamp()` / viewport-relative units (`vw`/`vh`/`vmin`) captured at the target
size, for finer per-element control (e.g. a headline scaling more aggressively
than body).

See also: [docs/91 — adaptive format scaling](./91-adaptive-format-scaling.md),
[docs/87 — format presets](./87-format-presets.md).

## TL;DR / recommendation

**Keep the uniform `formatScaleFactor` as the baseline; add per-element scale
*exponents* if differential scaling is wanted — do NOT switch the cards to raw
`vw`/`clamp()`.** Viewport units *do* capture faithfully (the one open question
in the ticket), but:

1. **Naive `vw` does the opposite of the DM-1541 goal.** `vw` is proportional to
   canvas *width*; a 9:16 reel is narrow, so a `vw`-sized headline comes out
   *smaller* on the reel than on landscape — exactly the "type tiny and lost in
   the tall frame" problem DM-1541 exists to fix.
2. **`clamp()`/viewport units are always-on, breaking the opt-in contract.** The
   current factor is gated on `safeInset` (`== null → 1`), so no-format output is
   byte-identical and a raw custom `--width`/`--height` doesn't rescale. CSS
   viewport units respond to *every* viewport, so they'd change the default and
   custom-size output unless every `clamp()` preferred term is pinned to land
   exactly on the authored px at the 1280×720 reference — fragile.
3. **They only help the wrapping text cards.** The number cards (`stat`,
   `counter`) need `fitOdometerCell`'s JS width-measurement to keep a fixed-width
   value from clipping; a `clamp()` can't express "as big as *fits* this column
   count." The uniform path already covers both card families.

A properly *tuned* `clamp()` (weighted toward `vh`) **can** match or beat the
uniform factor for legibility and gives genuine per-element control — but it buys
that with more authoring complexity and the two contract problems above. If the
only goal is "headline scales harder than body," a per-element **exponent** on
the existing factor (`fs(px, sf ** 1.2)`) delivers that at authoring time with no
capture coupling and no contract change.

## Does `clamp()`/`vw` capture faithfully? — Yes (pixel evidence)

Domotion captures **computed px** via Chromium, and the template pipeline renders
the card HTML at a viewport equal to the format canvas
(`runSingleFrameGenerator` → `runAnimateConfig({ width, height })`, so the
capture viewport = format size — no DM-1538 gotcha). So `vw`/`vh`/`clamp()`
resolve to concrete px at capture time and land verbatim in the SVG's
`font-size`.

Probe (`tools/scratch/dm1561/probe-clamp-capture.mjs`) authored a card with
`clamp()`/`vw` type and compared Chromium's computed px to the emitted SVG:

| element (`clamp`/`vw`) | Chromium computed | SVG `font-size` |
|---|---|---|
| `.title` = `clamp(40px, 8vw, 180px)` @ 1920×1080 | 153.6 | `153.6` |
| `.title` @ 1080×1920 (reel) | 86.4 | `86.4` |
| `.sub` = `clamp(20px, 3.2vw, 60px)` @ 1920 | 60 | `60` |
| `.eyebrow` = `clamp(14px, 1.8vw, 34px)` @ 1080 | 19.44 | `19.44` |

Faithful to the emitted decimal. (One authoring gotcha surfaced: a `clamp()`
preferred term that mixes units — `2vw + 6vh` — needs whitespace around the `+`;
`2vw+6vh` is invalid and silently drops the whole `clamp()` to the browser
default 16px.)

## Does it beat the uniform factor for legibility?

Prototyped one `title-card` three ways at reel (1080×1920) vs landscape
(1920×1080), rasterized with `svg-to-image`
(`tools/scratch/dm1561/png-*.png`). Resolved headline / sub / eyebrow px:

| approach | reel title | land title | reel eyebrow | land eyebrow |
|---|---|---|---|---|
| **uniform** `formatScaleFactor` (shipped) | 125.2 | 140.4 | 38.8 | 43.5 |
| naive `vw` (`clamp(_, 8vw, _)`) | 86.4 | 153.6 | 19.4 | 34 |
| tuned `clamp` (`clamp(56px, 2vw + 6vh, 200px)`) | 136.8 | 103.2 | 37.2 | 28.8 |

Reading the rasterized reels:

- **uniform** — headline fills the frame width, reads well. All elements scaled
  by the same 1.49, so the title:eyebrow ratio is fixed across formats.
- **naive `vw`** — headline is visibly *smaller*, floats in empty space: the
  landscape-tuned look shrunk into the tall frame. Clearly worse — this is the
  DM-1541 failure mode.
- **tuned `clamp`** — headline is the largest of the three and fills the frame;
  eyebrow/sub scaled independently. Reads great, and demonstrates the one real
  win: the author chose `2vw + 6vh` for the headline and lighter coefficients for
  the sub, so **the headline scales more aggressively than the body across
  ratios** (reel title:eyebrow 3.68 vs landscape 3.58 — impossible with a single
  uniform multiplier). All three read fine at landscape.

So: **naive `vw` loses; tuned `clamp` ties/wins on legibility and adds
per-element control** — but only after the author hand-tunes per-element `vw`/`vh`
coefficients, and only for the wrapping text cards.

## Where `clamp()`/`vw` costs more than it gives

- **Opt-in contract breaks.** `formatScaleFactor(…, safeInset)` returns exactly
  `1` when no format is chosen, so default and raw-`WxH` output is byte-identical
  (verified: default `title-card` emits `font-size="84"`/`"26"`). A `clamp()`
  authored into the card CSS is *always* live — it rescales the default 1280×720
  render (`2vw + 6vh` → 68.8px ≠ 84px) and every custom `--width`/`--height`.
  Preserving byte-identical default output would require pinning every preferred
  term to hit the authored px at exactly the reference viewport — brittle, and it
  couples each element's size to that one reference.
- **Number cards still need JS.** `stat`/`counter` clamp the odometer cell to the
  safe width via `fitOdometerCell` (a measured column-count fit). "As large as
  *fits* N columns" isn't expressible in `clamp()`; those cards would keep their
  JS path regardless, so `clamp()` wouldn't unify the two families.
- **Two mental models.** Authors would reason in `vw`/`vh` coefficients + min/max
  clamps per element instead of authored px × one factor. More knobs, more ways to
  get the reel wrong (the `vw` direction trap above).

## Concrete alternative that gets the per-element win cheaply

The only thing the uniform factor *can't* do is scale elements differentially.
That's achievable without `clamp()`/`vw` at all: give each element a **scale
exponent** on the existing factor —

```
.tc-title:  fs(84, sf ** 1.25)   // headline scales harder
.tc-sub:    fs(34, sf ** 0.9)    // body scales gentler
```

Pure authoring-time math, still gated on `safeInset` (exponent of `sf === 1` is
still `1` → byte-identical default), still works for the number cards' width cap,
no capture/viewport coupling. This delivers "headline scales more aggressively
than body" — the concrete benefit the alternative was reaching for — at a
fraction of the cost.

## Follow-up tickets proposed (for the maintainer to file)

- **Per-element scale exponents on `formatScaleFactor`** — add an optional
  exponent per authored size (`fs(px, sf, exp)`), let each card tune headline vs
  body scaling; keeps the opt-in gate + number-card cap. (The recommended path.)
- **Designer tuning pass on the curve/reference** — revisit `ADAPTIVE_REFERENCE`,
  the `[0.75, 1.85]` clamp, and the √-area curve against real reel/landscape
  proofs; decide whether per-format (not just per-area) tuning is wanted.
- **(If pursued) format-gated `clamp()` emission for text cards only** — emit
  viewport-unit CSS *only* when a format is chosen (static px otherwise), to keep
  byte-identical default output while getting viewport-responsive per-element
  control; scoped to the wrapping text cards, not the number cards.
- **Fold `chart` axis/label type into adaptive scaling** — still outstanding from
  DM-1541 regardless of which mechanism wins (uniform factor is the low-risk
  choice here).

## Repro

Throwaway probes live under `tools/scratch/dm1561/` (gitignored):
`probe-clamp-capture.mjs` (faithful-capture evidence + `clamp-*.svg`),
`probe-tuned-clamp.mjs` (`tuned-*.svg`), and `png-*.png` (the rasterized reel /
landscape comparison). Regenerate: `node tools/scratch/dm1561/probe-*.mjs` then
the `svg-to-image` invocations in the same dir.

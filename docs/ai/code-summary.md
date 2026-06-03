# Code summary — AI agents read me first

This file is the entry point the Hot Sheet ticket template tells you to read.
It points you at the existing canonical docs rather than duplicating them;
the source of truth lives in `CLAUDE.md` and the numbered `docs/*.md` set.

## Read these first, in order

1. **`CLAUDE.md`** (repo root) — the operating manual. Covers stack, code
   organisation, CAPTURE_SCRIPT discipline, decoration & shaping invariants,
   quality gates, language, **investigation + debugging tools (Playwright
   probes, `--debug` bundles, `svg-review`)**, git, ticket workflow,
   documentation rules. Always re-read when the date drifts past your last
   read — the file is updated as patterns emerge.

2. **`docs/README.md`** — index of the numbered docs. Each numbered doc is
   a per-feature requirements + design reference (what CSS round-trips, what
   doesn't, why). When you change capture/render/animate behaviour, the
   corresponding doc updates in the same commit.

3. **`docs/api.md`** — the published-package API surface. What
   `domotion-svg` consumers import. When you rename / add / break a public
   symbol, this is the contract document to keep in sync.

## Key code orientation

The same orientation lives in `CLAUDE.md` "Code Organization" but the
shortest possible map:

- **`src/capture/`** — Playwright bring-up + the `CAPTURE_SCRIPT` (a
  serialised function that runs inside the page to walk the DOM). The
  capture-script bundle is pre-built into `src/capture/script.generated
  .ts` by `scripts/build-capture-script.mjs`.
- **`src/render/`** — pure node-side renderers that convert a captured
  element tree into SVG markup. `element-tree-to-svg.ts` is the big one;
  `text-to-path.ts` + `text.ts` own glyph/decoration/wrap logic;
  `borders.ts` owns border math.
- **`src/animation/`** — multi-frame composition (animator, magic-move).
- **`src/scroll/`** — scroll-pattern grammar (DM-604) and the composer
  that stitches per-segment captures into one animated SVG.
- **`src/cli/`** — the four published bins: `domotion`, `svg-to-video`,
  `svg-review`, `animated-svg-scrubber`.
- **`src/review/`** — the published review-tool surface
  (`compare-pngs.ts`, `region-overlay.ts`, `server.ts`, `client.tsx`)
  shared between the in-repo `tests/review-server.tsx` and the
  consumer-facing `svg-review` CLI.
- **`src/scrubber/`** — the `animated-svg-scrubber` server + kerfjs
  page-side UI (`server.ts`, `client.tsx`, `trim.ts`): video-style
  play/scrub/range-loop/frame-export/trim for an animated SVG (doc 56).
- **`src/tree-ops/`** — element-tree transforms (`frame-merge.ts`,
  `tree-diff.ts`, `viewbox-culling.ts`, `resize-embedded-images.ts`).
- **`src/post-processing/`** — the optional svgo `optimize.ts` + `gzip.ts`.
- **`src/utils/`** — small shared helpers.
- **`tests/`** — visual-regression suites (`features.ts`, `showcase.ts`,
  `html-test-suite.tsx`, `real-world.tsx`) + the in-repo review server
  (`review-server.tsx`).

## Debugging a render-fidelity bug

The shortest possible path, per `CLAUDE.md` "Debugging the generated output":

```sh
# 1. Capture the source page with a debug bundle.
domotion capture <url-or-file> --debug -o out.svg

# 2. Review the diff in a browser UI with draggable region markers.
svg-review --expected out.debug/expected.png --actual out.debug/actual.svg

# 3. For a fixture already in the suite, crop the ticket's REGIONS:
npx tsx tools/crop-regions.ts --ticket DM-{id}
```

If those don't surface the cause, fall through to a Playwright probe under
`tools/probe-*.mjs` — `CLAUDE.md` has copy-pasteable patterns for the two
most common probes (measure-an-element, screenshot-a-region).

## What this file is NOT

- Not a complete summary of the codebase — `CLAUDE.md` is. Don't grow
  this file into a parallel orientation; update `CLAUDE.md` instead.
- Not a substitute for reading the relevant numbered doc — when a ticket
  touches a specific feature area (animation, scroll, gradients, fonts,
  ...), read its dedicated doc.

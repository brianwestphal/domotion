# Full-application demo captures

These SVGs are **real Domotion captures of two live applications**, committed
here so the site can embed them and CI can build the site without those external
repos checked out. Each is regenerated from its own app's demo pipeline (both
apps already depend on `domotion-svg` to produce them) — re-copy them here when
the source app refreshes its demo assets.

| File | Source app | Source asset | What it shows |
|---|---|---|---|
| `glassbox-review.svg` | Glassbox (AI code review) | `assets/demo.svg` | **Animated** storyboard: launch from the CLI → AI risk triage → open a split diff → annotate a line → complete the review → export the structured feedback → a Claude Code agent applies the fix. One infinitely-looping SVG. |
| `glassbox-risk-mode.svg` | Glassbox | `assets/demo-risk-mode.svg` | A still of the sidebar in AI-risk-triage mode, with colored per-file risk badges. |
| `hotsheet-board.svg` | Hot Sheet (ticket / worklist tool) | `docs/demo-1.svg` | The main board — every ticket across columns with the detail panel open. |
| `hotsheet-up-next.svg` | Hot Sheet | `docs/demo-4.svg` | The AI worklist view — Up Next tickets with notes, the queue an agent works from. |
| `hotsheet-dashboard.svg` | Hot Sheet | `docs/demo-8.svg` | The dashboard — stats and charts over the ticket set. |

## Regenerating

From each source app's checkout:

- **Glassbox:** `npm run demo:capture` rebuilds `assets/demo.svg` (and the
  mode stills via `npm run demo:capture-stills`).
- **Hot Sheet:** `npx tsx scripts/capture-demos.ts` rebuilds `docs/demo-N.svg`
  for every seeded demo scenario.

Then copy the chosen files into this directory and rebuild the site
(`npm run build` runs `scripts/build-demos.mjs`, which copies them to
`public/demos/apps/`).

## Current provenance (DM-2648)

Captured headlessly on 2026-09-02 with `DOMOTION_NO_OPEN=1`:

| App | Source commit | Capture command |
|---|---|---|
| Glassbox | `0f2fd17891511441538204dcf832d51b0f4e2e6c` | `npm run demo:capture`; `npm run demo:capture-stills -- --only risk-mode` |
| Hot Sheet | `5e7835e4c373f110345b798bb9cc05b66326af27` | `npx tsx scripts/capture-demos.ts 1 4 8` |

Committed asset SHA-256 digests:

| File | SHA-256 |
|---|---|
| `glassbox-review.svg` | `7efdf53fa96e316a9b84faf65f0ec0a6f2b0405103e72c4d26da86465802c0ca` |
| `glassbox-risk-mode.svg` | `c66cc7591af083675c18acc0846eca051d32036c9ecaf55c0be31bfc09486258` |
| `hotsheet-board.svg` | `851430b92be54104d20addaf5fe0933e02492e3a0c1c11db783bee64d5e47a44` |
| `hotsheet-up-next.svg` | `27b97500929109b7d30777487e53e875f833f9e6e359b06645cb713186c3470b` |
| `hotsheet-dashboard.svg` | `cc30818a8fc9693060d565bf56a872c984d9d5fce24bf18c61d3456567d5113c` |

The Hot Sheet copies normalize trailing whitespace after capture; SVG markup and
rendered content are otherwise unchanged from the source artifacts.

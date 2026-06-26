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

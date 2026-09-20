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

## Current provenance (DM-03JJVJ refresh)

Captured headlessly on 2026-09-20 with `DOMOTION_NO_OPEN=1`:

| App | Application source commit | Generated-artifact commit | Capture command |
|---|---|---|---|
| Glassbox | `e6a418288144cf0b73511c2279c4d03036f3442c` | `2ea045769b09baa24207056eedcad8bc07dc587b` | `npm run demo:capture`; `npm run demo:capture-stills -- --only risk-mode` |
| Hot Sheet | `7788b8365369670d34ed555b3c0d7119904b8aaf` | `d26c09b81309a61489904bc00f93225f74d143d4` | `npx tsx scripts/capture-demos.ts 1 4 8` |

The source commit is the checkout used for this headless regeneration. The
generated-artifact commit is the latest commit in that source repository which
already contains the selected asset paths; the refreshed bytes copied here were
regenerated from the newer source commit and are identified exactly by the
digests below.

Committed asset SHA-256 digests:

| File | SHA-256 |
|---|---|
| `glassbox-review.svg` | `b0a0933c83a600c1d4a6aaeae61c21309a1a86aa50cbd08e1c0c3e6b2793516e` |
| `glassbox-risk-mode.svg` | `0717f2b3764d0d3ff65a2412760d99797b72bd5d7d4d229a83f813885fbe680a` |
| `hotsheet-board.svg` | `9fc7fc28368d8329320e32559efaad592413a133bce2b0a4735ceb839d4b3cde` |
| `hotsheet-up-next.svg` | `5464de2c6ce0e90c826462024efc4f16c1502044eed0ff20b0c944906238586d` |
| `hotsheet-dashboard.svg` | `f2a570433cfe64250974cf098d130c591957797f2d13b1a5c7edf64a3d7b199f` |

The Hot Sheet copies normalize trailing whitespace after capture; SVG markup and
rendered content are otherwise unchanged from the source artifacts.

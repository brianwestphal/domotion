# SVG Review Tool

`svg-review` is a consumer-facing CLI bundled in the published npm package that
opens a local browser UI for comparing one captured Domotion SVG against the
Chromium reference it was meant to reproduce — and lets the user annotate
visual differences into a ready-to-paste GitHub issue. It is the
single-fixture cousin of the in-repo `demos:review` tool that maintainers
already use to triage the pixel-regression suites.

## Why this exists

When a consumer of `domotion-svg` finds that a real-world capture doesn't
reproduce Chromium's rendering exactly, the next step today is "open both
images in two browser tabs, switch back and forth, type a description into a
fresh GitHub issue, attach the PNGs by hand." That friction loses bug reports
that could otherwise become test fixtures. `svg-review` collapses that flow
into a single command + a few key/mouse interactions and emits a GitHub-issue-
shaped Markdown snippet the user can paste directly.

## Invocation

```
svg-review --expected expected.png --actual actual.svg [--port 3839]
```

- `--expected` — PNG of what Chromium painted on the source page. Required.
- `--actual` — Domotion's captured SVG (`.svg`) or its rendered PNG (`.png`).
  When given an SVG, the tool rasterises it via Playwright at 1×, matching
  the same rendering pipeline the in-repo pixel-regression tests use, so what
  the user is comparing is the same byte-for-byte image Domotion's consumers
  would see. Required.
- `--port` — port the local HTTP server binds to. Defaults to 3839; falls back
  to the next free port if taken.

The tool prints the URL it opens and (on platforms with a default browser
opener) launches the page automatically.

## UI

A single review card, similar in layout to one card in `tests/review-server
.tsx`'s grid:

- **Three figures side by side**: `expected`, `actual`, `diff`. The diff is
  computed on the fly using the same pixel-diff path the regression suites
  use, so a consumer's `svg-review` reading lines up with what a maintainer
  would see if they had the fixture in the suite.
- **Keyboard switching** (DM-585 pattern from `review-client.tsx`):
  - Click any figure → opens it in a fullscreen lightbox.
  - `←` / `→` (or `↑` / `↓`) inside the lightbox steps between the three
    images, preserving scroll position so it reads as a flicker-compare on
    the same patch.
  - `Esc` closes the lightbox.
- **Draw issue boxes**: in either the grid or the lightbox, mousedown-drag
  draws a coloured rectangle pinned to a region of the image. Pointer
  interactions reuse `tests/review-region-overlay.ts`'s `enableRegionOverlays
  ()` API: drag empty to draw, drag a handle to resize, click the interior
  to delete. Rects sync across the three figures because they share the
  same source-PNG dimensions.
- **Caption each region**: clicking a region opens an inline `<textarea>`
  for a freeform description (e.g. "border-radius too tight on this corner",
  "emoji missing tofu fallback").
- **Press `Enter` (Cmd/Ctrl+Enter inside the textarea)**: builds a GitHub-
  issue-shaped Markdown block in a side panel, plus a "Copy to clipboard"
  button and a link straight to <https://github.com/brianwestphal/domotion
  /issues/new> with the title pre-filled via the URL `?title=` parameter.

## Issue Markdown output

The generated paste-able block has three sections, ready to drop into the
GitHub new-issue form:

```markdown
### Domotion render fidelity issue

**Expected** (Chromium): `expected.png` (attached)
**Actual** (Domotion): `actual.svg` (attached)

| # | Region (x, y, w, h) | What's wrong |
|--:|---|---|
| 1 | (123, 456, 78, 90) | border-radius too tight |
| 2 | (200, 400, 150, 30) | font-weight too thin |

### How to reproduce
…
```

The `(x, y, w, h)` coordinates are in source-PNG pixel space so the maintainer
can crop the attached PNG to the exact region the user flagged — matching
the `REGIONS:` block convention `tools/crop-regions.ts` already understands.

Below the snippet, a short instructions block reminds the user to attach the
two source files when filing:

> File the issue at <https://github.com/brianwestphal/domotion/issues/new>,
> paste the Markdown above into the body, and attach `expected.png` and
> `actual.svg` so we can reproduce.

## Implementation outline

- `src/cli/review.ts` — the CLI entry point. Parses `--expected` / `--actual`
  / `--port`. Reads both files, rasterises the SVG via Playwright (the only
  hard dependency we already have for accurate diffs), computes the diff PNG
  via the same `tests/runner.ts` helpers the regression suites use (factored
  out into a small reusable module under `src/review/` so it's bundle-safe
  for the published package), then spins up the local HTTP server and
  opens the URL.
- `src/review/server.ts` — the HTTP server. Serves the static UI bundle and
  the three captured images. Distilled from `tests/review-server.tsx` but
  stripped of the Hot Sheet integration (consumers don't have access).
- `src/review/client.ts` — the page-side script. Reuses
  `tests/review-region-overlay.ts` for drawing/resizing rects and adds the
  Markdown-builder + clipboard-copy panel.
- `bin` entry in `package.json` → `svg-review: dist/cli/review.js`.

## What's intentionally out of scope

- Diff scoring / verdict tiers — the consumer doesn't need to argue with the
  maintainer's scoring, just point at the region.
- Filing the GitHub issue automatically (would need an OAuth flow); we hand
  off via URL parameters and clipboard instead.
- Batch comparison — a separate doc would cover multi-fixture review if a
  consumer ever needs it. For now this tool is one-shot per invocation.

## Follow-up tickets

Tracked in Hot Sheet (local-only) as DM-947 (factor pixel-diff into `src
/review/`), DM-948 (Playwright e2e), DM-949 (README pointer). DM-947 lands
first because the CLI depends on it; the other two are post-CLI polish.

## Relationship to debug-mode capture (DM-945)

DM-946 was scoped "in conjunction with DM-945". DM-945 adds a `--debug`
flag to `domotion capture` that emits a HAR plus other diagnostic
artifacts. The two tickets share one user story: a consumer hits a render
fidelity issue, runs the capture with `--debug` to get expected.png +
actual.svg + a HAR, then runs `svg-review` against the first two to file
a focused bug. The Markdown snippet should include "I have a HAR — request
it" so the maintainer knows to ask for the HAR when reproducing.

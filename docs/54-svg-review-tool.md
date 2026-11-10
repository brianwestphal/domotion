---
id: "requirements/svg-review-tool"
title: "SVG Review Tool"
kind: "contract"
status: "current"
owners: ["product-tooling"]
platforms: []
tickets: ["DM-585", "DM-945", "DM-946", "DM-947", "DM-948", "DM-949", "DM-964DQM"]
code:
  [
    "src/cli/review.ts",
    "src/review/",
    "src/review/client.tsx",
    "src/review/region-overlay.ts",
    "src/review/server.ts",
    "tests/review-server.tsx",
    "tests/kerf-client-uis.e2e.test.ts",
    "tools/crop-regions.ts",
  ]
aliases: ["docs/54-svg-review-tool.md", "doc-54"]
---

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
svg-review --expected expected.png --actual actual.svg [--port <n>] [--no-open]
```

- `--expected` — PNG of what Chromium painted on the source page. Required.
- `--actual` — Domotion's captured SVG (`.svg`) or its rendered PNG (`.png`).
  When given an SVG, the tool rasterizes it via Playwright at 1×, matching
  the same rendering pipeline the in-repo pixel-regression tests use, so what
  the user is comparing is the same byte-for-byte image Domotion's consumers
  would see. Required.
- `--port` — port the local HTTP server binds to. When omitted, binds an
  OS-assigned free port (the URL is printed on startup).
- `--no-open` — print the local URL without launching the default browser.

The tool prints the local URL and, unless `--no-open` is set, launches the
default browser when one is available.

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
  draws a colored rectangle pinned to a region of the image. Pointer
  interactions reuse `src/review/region-overlay.ts`'s `enableRegionOverlays
()` API: drag empty to draw, drag a handle to resize, click the interior
  to delete. Rects sync across the three figures because they share the
  same source-PNG dimensions.
- **Add a region without a pointer**: the side panel's "Add centered region"
  button adds a region covering the middle half of the image. Until a region
  exists, the list shows a "No regions yet" empty state.
- **Caption each region**: the side panel ("Annotated regions") lists one row
  per region with a single-line `<input>` for a freeform description (e.g.
  "border-radius too tight on this corner", "emoji missing tofu fallback").
  Clicking a region on the image does not open an editor; an interior click
  deletes it.
- **Live issue Markdown**: the GitHub-issue-shaped Markdown in the side
  panel's read-only `<textarea>` is rebuilt on every caption keystroke and
  every region add / move / resize / delete. Pressing `Enter` in a caption
  input commits it and moves focus to the textarea with its text selected.
  The visible "GitHub issue text" heading names the read-only field for
  assistive technology; its generated content remains selectable and copyable
  (DM-964DQM).
  The panel also has a "Copy issue text" button and an "Open a new GitHub
  issue →" link to <https://github.com/brianwestphal/domotion/issues/new>
  with the title (`Domotion render fidelity: <label>`) pre-filled via the URL
  `?title=` parameter. The copy outcome is reported in a status banner next to
  the button: success, or a warning that the text was selected for a manual
  copy when the Clipboard API is unavailable.
- **Chrome from `@kerfjs/ui`**: the icons on the panel and lightbox buttons
  (`LucideIcon`), the empty region list (`EmptyState`) and the copy status
  (`StateBanner`) are kerf-ui components rendered by the client. Their CSS is
  folded into `/client.js` at build time, so the page stays one HTML shell plus
  one script with no network access. See
  [doc 273](273-ui-conventions.md) for the subset and theme rules.

## Issue Markdown output

The generated paste-able block (built by `buildIssueMarkdown` in
`src/review/client.tsx`) is ready to drop into the GitHub new-issue form:

```markdown
### Domotion render fidelity issue

**Fixture**: `<label>`
**Expected** (Chromium): `expected.png` (attached)
**Actual** (Domotion): `actual.svg` (attached)

|   # | Region (x, y, w, h) | What's wrong            |
| --: | ------------------- | ----------------------- |
|   1 | (123, 456, 78, 90)  | border-radius too tight |
|   2 | (200, 400, 150, 30) | font-weight too thin    |

### How to reproduce

1. Open `actual.svg` in the same browser that produced `expected.png`.
2. Compare against `expected.png` at 1:1 pixel scale.
3. The regions listed above mark where Domotion's output diverges.

> Generated by `svg-review`. Coordinates are in source-PNG pixel space.
```

With no regions, the table is replaced by an italic "no regions annotated"
line.

The `(x, y, w, h)` coordinates are in source-PNG pixel space so the maintainer
can crop the attached PNG to the exact region the user flagged — matching
the `REGIONS:` block convention `tools/crop-regions.ts` already understands.

Below the textarea (in the page, not inside the generated Markdown), a hint
reminds the user to paste the text into the issue body and attach
`expected.png` and `actual.svg` when filing.

## Implementation outline

- `src/cli/review.ts` — the CLI entry point. Parses `--expected` / `--actual`
  / `--port`. Reads both files, rasterizes the SVG via Playwright (the only
  hard dependency we already have for accurate diffs), computes the diff PNG
  via the same `tests/runner.tsx` helpers the regression suites use (factored
  out into a small reusable module under `src/review/` so it's bundle-safe
  for the published package), then spins up the local HTTP server and
  opens the URL.
- `src/review/server.ts` — the HTTP server. Serves the static UI bundle and
  the three captured images. Distilled from `tests/review-server.tsx` but
  stripped of the Hot Sheet integration (consumers don't have access). It binds
  to `127.0.0.1` through `startLocalServer` and so inherits the shared
  cross-site guard: a request whose `Host` is not `127.0.0.1:<port>` or
  `localhost:<port>` answers 403, so a DNS-rebinding page cannot read the
  captured images (doc 240, "Cross-site request guard").
- `src/review/client.tsx` — the page-side script. Reuses
  `src/review/region-overlay.ts` for drawing/resizing rects and adds the
  Markdown-builder + clipboard-copy panel. `scripts/build-review-client.mjs`
  bundles it through `scripts/bundle-kerf-client.mjs` into
  `client.bundle.generated.ts`.
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
a focused bug. The generated Markdown reports the image and SVG evidence;
the user can mention the HAR separately when sharing the debug bundle.

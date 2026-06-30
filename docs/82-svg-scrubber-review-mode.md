# 82 — svg-scrubber review mode (`--review`)

## Summary

`svg-scrubber --review` turns the animated-SVG scrubber (doc 56) into an
**issue-reporting** surface. Alongside the normal transport (play / scrub /
range / export), a review panel lets you file issues about the SVG: type a
title + note, optionally drag a rectangle over the problem area, and **Save** —
each issue is written as a self-contained `.ticket` JSON file in the directory
`svg-scrubber` was launched from, capturing the **current frame time**, the
**selected in/out range**, and the **region** so a tracker like Hot Sheet can
import it directly.

It's the animated-SVG analogue of the static `svg-review` tool's region+notes
flow (doc 54), but instead of one expected/actual diff it captures the timeline
context that only matters for animation.

## CLI

```sh
svg-scrubber <file.svg> --review
```

- `--review` enables the panel + the `POST /ticket` endpoint. Without it the
  scrubber behaves exactly as before (and `/ticket` returns 404).
- `.ticket` files are written to **`process.cwd()`** (the launch directory).
  Each created path is logged to stderr (`📝 wrote ticket: <abs path>`), and the
  UI shows the path on save.

## The review panel

Shown only in `--review` mode, as an extra row in the transport bar:

- **Title** (required) — becomes the ticket title.
- **Category** — `bug` (default) / `issue` / `feature` / `task` /
  `investigation`; becomes the ticket category.
- **Mark region** — arms a drag-to-draw overlay on the stage. Drag a rectangle
  over the problem area; it's recorded in the SVG's **user-space units** (the
  same coordinate space as the crop rect, so it's meaningful regardless of zoom
  / pan). The overlay **stays armed across drags**, so you can add **multiple
  regions** (DM-1449) for an issue spanning several spots; the button shows the
  count (`Regions ✓ (2)`). **Clear** removes them all. Regions are optional
  (none → "whole frame").
- **Attach frame** (checkbox, default on — DM-1449) — when checked, Save also
  renders the **current frame** (the SVG at the playhead time, via the same
  Chromium seek+screenshot the frame export uses) to a sibling `.png` next to
  the `.ticket` and references it from the JSON. Uncheck for a quick text-only
  issue.
- **Note** — a free-form textarea; becomes the ticket body.
- **Captured context readout** — `frame @ <t>` and `range <in>–<out>` so you can
  see exactly what will be recorded.
- **Save issue** — POSTs the issue; on success the title/note/regions reset for
  the next one (the SVG, range, and playhead stay put).

## The `.ticket` file format

A `.ticket` file is **JSON** — chosen so any tool (or an AI assistant) can read
and import it without parsing prose. Schema (`ScrubberTicket` in
`src/scrubber/server.ts`):

```jsonc
{
  "tool": "svg-scrubber",
  "version": 1,
  "createdAt": "2026-06-30T15:00:00.000Z",
  "title": "Logo flickers at the loop point",
  "category": "bug",
  "svg": "/abs/path/to/animation.svg",   // null if loaded via drag-drop (no path)
  "svgName": "animation",
  "frameTimeMs": 1234.5,
  "range": { "startMs": 1000, "endMs": 2000 },
  "regions": [{ "x": 56, "y": 38, "w": 80, "h": 48 }],  // SVG user-units; [] = whole frame
  "region": { "x": 56, "y": 38, "w": 80, "h": 48 },     // back-compat: first region (or null)
  "framePng": "/abs/path/to/animation-<stamp>.png",     // sibling frame PNG, or null
  "note": "Visible seam when the animation wraps.",
  "details": "…markdown body…"
}
```

- **`title` / `category` / `details`** map directly onto the
  `hotsheet_create_ticket` arguments (and onto most trackers' title / type /
  body). `details` is a ready-to-paste Markdown rendering of the note + the
  captured context (SVG path, frame time, range, region(s), frame snapshot path).
- The structured fields (`frameTimeMs` / `range` / `regions` / `framePng` /
  `svg`) let an importer reconstruct the exact frame and area later.
- **`regions`** (DM-1449) is the canonical list; **`region`** is kept as the
  first region (or null) for pre-multi-region importers. **`framePng`** (DM-1449)
  is the absolute path of the sibling frame PNG when "Attach frame" was on, else
  null.

**Filename:** `<slugged-svg-name>-<timestamp>.ticket` in the launch directory
(unique per save; the timestamp keeps multiple issues from colliding). The frame
PNG, when attached, is the same `<slug>-<timestamp>.png` alongside it.

### Importing into Hot Sheet (the intended workflow)

The files are designed for the "tell Claude to import them" flow:

> Read the `.ticket` files in this folder, create a Hot Sheet ticket from each
> (`title` → title, `category` → category, `details` → details), attach the
> `framePng` if present, then move the `.ticket` files (and their sibling
> `.png`s) to the trash.

Because each file is a flat JSON object with `title` / `category` / `details`,
that's a direct mapping to `hotsheet_create_ticket` — no transformation needed.
When `framePng` is set, attach it (e.g. `hotsheet_add_attachment` with that path)
so the visual context rides along with the ticket.

## Implementation

- **`src/cli/scrubber.ts`** — `--review` flag; passes `review`, `ticketDir`
  (`process.cwd()`), and `initialPath` (the preloaded SVG's absolute path) to
  the server; logs the ticket directory on startup.
- **`src/scrubber/server.ts`** — `review` / `ticketDir` / `initialPath` inputs;
  `review` is injected into the client bootstrap; `buildTicketFile()` (pure,
  unit-tested) builds the filename + JSON + Markdown details; `POST /ticket`
  (review-mode only; 404 otherwise) validates the body with zod, writes the
  file, logs + returns the absolute path. **DM-1449:** when `attachFrame` + `svg`
  are sent, it renders the current frame (`parseSvgIntrinsicSize` →
  `setContent` → `seekTo(frameTimeMs)` → `screenshot`, the same path as
  `/export-frame`) to a `<slug>-<stamp>.png` sibling and records `framePng`; a
  render failure is non-fatal (the ticket is still written, `framePng: null`).
- **`src/scrubber/client.tsx`** — the review panel + the drag-to-draw region
  overlay (a sibling of the crop overlay, sharing its SVG-unit ↔ stage-px
  math), and `saveTicket()` (POST → status line). **DM-1449:** the overlay holds
  a `regions` array (rebuilds one `.region-box` per region + the live drag) and
  stays armed across drags; the "Attach frame" checkbox sends `attachFrame` +
  the SVG markup so the server can render the frame.

## Tests

- `src/scrubber/ticket.test.ts` — `buildTicketFile` (slug / JSON shape / field
  mapping / details markdown / no-path + no-region; **multi-region**, `regions`
  precedence over legacy `region`, **`framePng` + injected slug**) and the
  `POST /ticket` endpoint (writes the file + path, 400 missing title, 404 review
  off, **multi-region**, **attachFrame-without-browser stays graceful**).
  Browserless.
- `tests/scrubber-frame-attach.e2e.test.ts` (DM-1449) — real Chromium: `attachFrame`
  renders a valid sibling PNG (PNG magic bytes), referenced by `framePng`, slug
  matched to the `.ticket`.
- The existing `src/scrubber/server.e2e.test.ts` continues to cover the
  transport endpoints unchanged.

## Out of scope / possible follow-ups

- Multiple regions (DM-1449) ✅ and frame-PNG attachment (DM-1449) ✅ shipped.
- A built-in "import these tickets" command was **explicitly deferred** (not
  implemented) — the read-`.ticket`-and-`hotsheet_create_ticket` flow above
  already works without code.
- A built-in "import these tickets" command (today it's the
  read-and-create-via-`hotsheet_create_ticket` flow above).

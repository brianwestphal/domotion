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
  / pan). **Clear** removes it. A region is optional (omit → "whole frame").
- **Note** — a free-form textarea; becomes the ticket body.
- **Captured context readout** — `frame @ <t>` and `range <in>–<out>` so you can
  see exactly what will be recorded.
- **Save issue** — POSTs the issue; on success the title/note/region reset for
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
  "region": { "x": 56, "y": 38, "w": 80, "h": 48 },  // SVG user-units, or null
  "note": "Visible seam when the animation wraps.",
  "details": "…markdown body…"
}
```

- **`title` / `category` / `details`** map directly onto the
  `hotsheet_create_ticket` arguments (and onto most trackers' title / type /
  body). `details` is a ready-to-paste Markdown rendering of the note + the
  captured context (SVG path, frame time, range, region).
- The structured fields (`frameTimeMs` / `range` / `region` / `svg`) let an
  importer reconstruct the exact frame and area later.

**Filename:** `<slugged-svg-name>-<timestamp>.ticket` in the launch directory
(unique per save; the timestamp keeps multiple issues from colliding).

### Importing into Hot Sheet (the intended workflow)

The files are designed for the "tell Claude to import them" flow:

> Read the `.ticket` files in this folder, create a Hot Sheet ticket from each
> (`title` → title, `category` → category, `details` → details), then move the
> `.ticket` files to the trash.

Because each file is a flat JSON object with `title` / `category` / `details`,
that's a direct mapping to `hotsheet_create_ticket` — no transformation needed.

## Implementation

- **`src/cli/scrubber.ts`** — `--review` flag; passes `review`, `ticketDir`
  (`process.cwd()`), and `initialPath` (the preloaded SVG's absolute path) to
  the server; logs the ticket directory on startup.
- **`src/scrubber/server.ts`** — `review` / `ticketDir` / `initialPath` inputs;
  `review` is injected into the client bootstrap; `buildTicketFile()` (pure,
  unit-tested) builds the filename + JSON + Markdown details; `POST /ticket`
  (review-mode only; 404 otherwise) validates the body with zod, writes the
  file, logs + returns the absolute path.
- **`src/scrubber/client.tsx`** — the review panel + the drag-to-draw region
  overlay (a sibling of the crop overlay, sharing its SVG-unit ↔ stage-px
  math), and `saveTicket()` (POST → status line). Region coordinates convert
  through the same zoom/pan-aware origin math the crop overlay uses.

## Tests

- `src/scrubber/ticket.test.ts` — `buildTicketFile` (slug / JSON shape / field
  mapping / details markdown / no-path + no-region) and the `POST /ticket`
  endpoint (writes the file + returns the path, 400 on missing title, 404 when
  review is off). Browserless (the endpoint needs no Chromium).
- The existing `src/scrubber/server.e2e.test.ts` continues to cover the
  transport endpoints unchanged.

## Out of scope / possible follow-ups

- Multiple regions per ticket (currently one rectangle).
- Attaching the rendered frame PNG to the ticket (the frame export already
  exists; a future flag could embed/reference it).
- A built-in "import these tickets" command (today it's the
  read-and-create-via-`hotsheet_create_ticket` flow above).

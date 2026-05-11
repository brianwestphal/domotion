# Region-scoped feedback in the demos-review tool

End-to-end contract for an extension of Domotion's local visual-regression review tool (`npm run demos:review` → `tests/review-server.tsx`) that lets the user point at specific rectangular regions of an `expected` / `actual` / `diff` PNG triplet, persist those regions as a comment on the originating Hot Sheet ticket, and have Domotion's AI iteration loop crop the source images to those regions before reasoning.

Tracked in DM-570.

## Problem

When a real-world visual-regression test fails (e.g., `apple-mobile-fold`, `framer-mobile-fold`), the three PNGs the review tool shows for that test can be 1280 × 4000+ pixels. Verbal descriptions like *"look at the lowercase 'a'"* or *"the doodles around the apple icon"* are hard to ground without a coordinate system, and when those descriptions land on a Hot Sheet ticket as a comment, the AI iteration that follows has to skim the whole screenshot trying to find the area the user meant. Forcing the entire-page PNGs into the iteration prompt also burns context on mostly-unrelated pixels.

The fix: let the user spatially constrain feedback by drawing rectangles directly on the review-tool images, persist those rectangles on the ticket alongside the typed comment, and have the iteration loop crop the sources accordingly.

## Surfaces

This feature touches two surfaces and a metadata format that bridges them:

1. **The Domotion review tool** (`tests/review-server.tsx`, served by `npm run demos:review`) — the only existing place where the `expected` / `actual` / `diff` triplet is shown side-by-side. Gets the drag-to-draw rectangle overlay and the comment-submission flow.
2. **The Hot Sheet ticket** (via the Hot Sheet API the review tool already has access to in this dev environment) — receives the comment with an embedded `REGIONS:` block. Full PNG attachments stay attached to the ticket as today.
3. **Domotion's AI iteration loop** — parses the latest note's `REGIONS:` block, crops the source images, writes the crops to a deterministic scratch path, and uses them as primary visual context.

## Workflow contract

### Drawing rectangles in the review tool

- **Draw**: mousedown-drag-mouseup on any of the three images draws a rectangle. The same pixel-coord rectangle is mirrored onto the two sibling images (the triplet is always the same dimensions in the real-world suite; same-size-only is enforced).
- **Resize**: dragging an edge of an existing rectangle resizes it; the change mirrors across the triplet.
- **Delete**: clicking the *interior* of an existing rectangle removes it from all three images.
- **Multiple**: the user can have any number of rectangles in flight before submitting.
- **Numbering**: rectangles are auto-numbered `[1]`, `[2]`, … in the order drawn, with the badge rendered at the top-left corner of each overlay. The user can reference them by index in the comment text (*"the missing CTA in [1]"*).

### Submitting a comment

- The comment composer in the review tool exposes a free-text field plus the in-progress rectangle list.
- On submit, the tool POSTs a note to the Hot Sheet API for the matching ticket. The note body is:

  ```
  <user-typed comment text>

  REGIONS:
  - [1] image=diff (x=120 y=240 w=380 h=160) — bottom-left CTA missing
  - [2] image=actual (x=900 y=80 w=100 h=40)
  - [3] (x=400 y=600 w=200 h=200)
  ```

  Format rules:
  - Rectangles are listed in draw order, numbered to match the UI badges.
  - Coordinates are integer pixels in source-PNG space, origin top-left.
  - `image=<basename>` pins the rectangle to a single attachment. The basename is the short suffix the review tool already uses internally (`expected`, `actual`, `diff`) — full filenames like `DM-564_framer-mobile-fold-diff.png` are NOT required in the note; the iteration loop resolves them against the ticket's attachments.
  - A rectangle without an `image=` token applies to all three triplet members. This is the common case ("look at this region across all three").
  - The trailing caption after `—` is optional, free-form, and reproduced verbatim in iteration context.

- After submit, the rectangles are cleared from the review-tool overlay (they live in the comment text now; the UI canvas is the editor, not the archive).

### Iteration consumes the regions

When Claude is triggered on a ticket whose latest note contains a `REGIONS:` block:

1. Parse the block. Each entry → `{index, image?, x, y, w, h, caption?}`.
2. For each entry, resolve the target attachment(s):
   - With `image=<basename>` → match against `attachments[].filename` by substring (e.g., `image=diff` matches `DM-564_framer-mobile-fold-diff.png`).
   - Without `image=` → all three triplet members for the test the ticket is about.
3. For each `(rectangle, attachment)` pair, produce **one crop per rectangle** (no union-bbox collation — separate crops, in draw order). Crops are tight to the rectangle with no extra padding.
4. Write crops to `tests/output/region-crops/DM-{ticket-id}/{noteId}/[{rectIndex}]-{imageBasename}.png` so subsequent runs can locate the same crops deterministically. The `{noteId}` segment keeps historical comments addressable.
5. Inject the crops into Claude's working context as **primary** visual evidence, **in addition to** the full attached PNGs (which the Hot Sheet ticket continues to carry as today). The crops are labelled with `[index]`, `image=<basename>`, and the optional caption so Claude can read them with the user's framing.

## Non-goals

- Annotations beyond rectangles (arrows, freehand strokes, labels). Out of scope.
- Region reuse across tickets / region templates / saved-region libraries.
- Region drawing on the Hot Sheet's own attachment viewer. The review tool is the only intended drawing surface; Hot Sheet just persists the resulting note.
- Animated or video annotations — the visual-regression suite produces static PNGs only.

## Data shape — quick reference

```
REGIONS:
- [N] image=<basename-substring>? (x=<int> y=<int> w=<int> h=<int>) [— optional caption]
```

- `N` is the 1-based draw-order index, kept consistent between the in-UI overlay and the persisted note for the lifetime of one comment-submission.
- `image=` is optional. Match is substring against `attachments[].filename`; the review tool only ever emits `expected`, `actual`, or `diff` here, but the parser tolerates anything that uniquely identifies one attachment.
- All four geometric fields are required. Negative coordinates are invalid (the review tool clamps drags to image bounds before serializing).

## Implementation backlog (to be filed as follow-up tickets)

- **Review-tool overlay** (`tests/review-server.tsx`): drag-to-draw / drag-edges-to-resize / click-interior-to-delete, multi-image sync across the triplet, auto-numbering, multi-rectangle handling.
- **Review-tool comment composer**: free-text textarea, serialize-rectangles-on-submit, clear-on-submit, POST to Hot Sheet `POST /api/tickets/{id}/notes` (or equivalent) with the composed body.
- **Iteration parser + cropper**: `REGIONS:` block parser, attachment-resolution helper, `sharp`-based per-rectangle PNG cropping, scratch-path writer at `tests/output/region-crops/DM-{id}/{noteId}/`.
- **Iteration context-injection hook**: pulls the latest note's `REGIONS:` block on channel re-trigger and feeds the crops to Claude with labels.
- **Optional polish**: keyboard shortcut to clear all in-progress rectangles without submitting; on-image rendering of the rectangle index + caption while drawing.

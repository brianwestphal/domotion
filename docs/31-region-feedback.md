---
id: "requirements/region-feedback"
title: "Region-scoped feedback in the demos-review tool"
kind: "contract"
status: "current"
owners: ["rendering"]
platforms: []
tickets: ["DM-570", "DM-A3QT31", "DM-Q6WQNA"]
code:
  [
    "src/review/region-overlay.ts",
    "src/utils/region-feedback.ts",
    "tests/review-client.tsx",
    "tests/review-server.tsx",
    "tools/crop-regions.ts",
  ]
aliases: ["docs/31-region-feedback.md", "doc-31"]
---

# Region-scoped feedback in the demos-review tool

End-to-end contract for an extension of Domotion's local visual-regression review tool (`npm run demos:review` → `tests/review-server.tsx`) that lets the user point at specific rectangular regions of an `expected` / `actual` / `diff` PNG triplet, persist those regions in a newly filed Hot Sheet ticket, and crop the source images for a later iteration.

Tracked in DM-570.

## Problem

When a real-world visual-regression test fails (e.g., `apple-mobile-fold`, `framer-mobile-fold`), the three PNGs the review tool shows for that test can be 1280 × 4000+ pixels. Verbal descriptions like _"look at the lowercase 'a'"_ or _"the doodles around the apple icon"_ are hard to ground without a coordinate system, and when those descriptions land on a Hot Sheet ticket as a comment, the AI iteration that follows has to skim the whole screenshot trying to find the area the user meant. Forcing the entire-page PNGs into the iteration prompt also burns context on mostly-unrelated pixels.

The fix: let the user spatially constrain feedback by drawing rectangles directly on the review-tool images and persist those rectangles in the ticket details alongside the typed comment. A separate crop command produces the focused images on demand.

## Surfaces

This feature touches two surfaces and a metadata format that bridges them:

1. **The Domotion review tool** (`tests/review-server.tsx`, served by `npm run demos:review`) — the only existing place where the `expected` / `actual` / `diff` triplet is shown side-by-side. Gets the drag-to-draw rectangle overlay and the comment-submission flow.
2. **The Hot Sheet ticket** (via the review tool's Hot Sheet API integration) — is newly filed with the comment and a `REGIONS:` block in its details. The full PNG triplet is attached.
3. **The manual crop step** — `tools/crop-regions.ts` parses the ticket's `REGIONS:` block, crops the source images, and writes a deterministic scratch path. Current alphanumeric Hot Sheet slugs and headless operation still need DM-A3QT31.

## Workflow contract

### Drawing rectangles in the review tool

- **Draw**: mousedown-drag-mouseup on any of the three images draws a rectangle. The same pixel-coord rectangle is mirrored onto the two sibling images (the triplet is always the same dimensions in the real-world suite; same-size-only is enforced).
- **Resize**: dragging an edge of an existing rectangle resizes it; the change mirrors across the triplet.
- **Delete**: clicking the _interior_ of an existing rectangle removes it from all three images.
- **Cancelled gestures**: a `pointercancel` (the browser took the pointer, it left the window) is not a click — it never opens the lightbox, and a rectangle still being drawn is abandoned; a cancelled resize keeps its last geometry.
- **One overlay per card**: `enableRegionOverlays(card)` is idempotent — a second call returns the existing handle rather than nesting another `.region-stage` and stacking listeners. A detached secondary view (the lightbox) clears the rectangles it painted into the caller's `<svg>`.
- **Multiple**: the user can have any number of rectangles in flight before submitting.
- **Numbering**: rectangles are auto-numbered `[1]`, `[2]`, … (1-based, unique, dense) in the order drawn or added, with the badge rendered at the top-left corner of each overlay. A rectangle added through the "Add region" control takes the next free number exactly as a dragged one does, and deleting one renumbers the rest with their captions attached. Every consumer (badge, region list `#N`, Markdown rows, the serialized `REGIONS:` block) shows the same `index`. The user can reference them by index in the comment text (_"the missing CTA in [1]"_).

### Fullscreen / lightbox view

Clicking any of the three thumbnails opens the image at full size in a lightbox. The lightbox supports drawing, resizing, and deleting the same rectangles as the in-grid triplet — every gesture on the maximised image edits the same shared rect array, so closing the lightbox returns to the card with the changes already reflected on all three thumbnails.

Sizing:

- Landscape / square images (height ≤ width) — fit-to-screen: the image scales so its longest axis is 96 vw / vh.
- Portrait / scroll-mode images (height > width) — full-width: the image takes the entire viewport width and the lightbox container scrolls vertically. This trades the bird's-eye view for actual readable detail on demos whose source PNGs are 1280 × 4000+ pixels.

Keyboard navigation:

- Arrow keys step between every visible figure in DOM order (the same set the lightbox-open click captured), wrapping at the ends.
- When the next figure shares the same card as the previous (the expected → actual → diff triplet, or its per-chunk siblings), the lightbox **preserves vertical scroll position**. Flipping between the three renderings of a tall scroll-mode test inspects the same vertical slice across all three without re-scrolling.
- When the next figure is on a different card, scroll resets to the top of the new image.
- Escape closes the lightbox; clicking the dark background closes it.
- Clicking the image itself (without dragging) closes the lightbox — same as before.

### Submitting a comment

- The comment composer exposes a required logical-stage classification, a free-text evidence field, and the in-progress rectangle list. A ticket cannot be filed until the reviewer selects one of:
  - **Logical defect** — routing, shaping, layout, geometry, or another decision differs before rasterization.
  - **Paint / compositing defect** — logical geometry agrees, but vector paint, effects, stacking, blending, or compositing differs.
  - **Unsupported behavior** — the fixture is outside the current rendering contract and needs an explicit support decision.
  - **Accepted rasterization-only variance** — logical output agrees and only the documented rasterization, hinting, or antialiasing floor remains.
- The tool deliberately does not infer this classification from pixel scores. A screenshot can locate a residual, but cannot identify the pipeline stage that caused it; the reviewer must first compare the relevant logical-stage evidence.
- On submit, the tool files a Hot Sheet ticket whose details include:

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

- Newly filed ticket titles include a short classification prefix, and ticket details preserve the full classification and definition before the pixel metrics and reviewer evidence.

- After submit, the rectangles are cleared from the review-tool overlay (they live in the comment text now; the UI canvas is the editor, not the archive).

### Iteration consumes the regions

The cropper is available as a manual CLI step for legacy numeric tickets. The
reviewer runs `npx tsx tools/crop-regions.ts --ticket DM-<number>` for a ticket with a `REGIONS:`
block, then supplies the printed crop paths as visual context for the next
iteration. It does not run automatically when an agent is triggered. The tool:

1. Parse the block. Each entry → `{index, image?, x, y, w, h, caption?}`.
2. For each entry, resolve the target attachment(s):
   - With `image=<basename>` → match against `attachments[].filename` by substring (e.g., `image=diff` matches `DM-564_framer-mobile-fold-diff.png`).
   - Without `image=` → all three triplet members for the test the ticket is about.
3. For each `(rectangle, attachment)` pair, produce **one crop per rectangle** (no union-bbox collation — separate crops, in draw order). Crops are tight to the rectangle with no extra padding.
4. Write crops to `tests/output/region-crops/DM-{ticket-id}/{noteId}/[{rectIndex}]-{imageBasename}.png` so subsequent runs can locate the same crops deterministically. The `{noteId}` segment keeps historical comments addressable.
5. Prints the crop paths for the reviewer or agent to open as **primary** visual evidence alongside the full attached PNGs. The indexed paths retain the rectangle's identity; captions remain in the ticket details.

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

## Implementation status

- **Review-tool overlay and comment composer**: shipped in `src/review/region-overlay.ts`, `tests/review-client.tsx`, and `tests/review-server.tsx`. Rectangles are serialized with the submitted evidence; Escape clears in-progress rectangles.
- **Parser and cropper**: shipped in `src/utils/region-feedback.ts` and `tools/crop-regions.ts`. Crop injection into an agent's context remains a manual step after running the CLI.
- **Optional on-image captions while drawing**: not implemented (DM-Q6WQNA); the ticket retains captions after submission.

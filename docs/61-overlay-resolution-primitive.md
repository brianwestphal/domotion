# 61 — Overlay resolution as a public primitive

Status: **shipped** (DM-1132). `resolveOverlays(page, overlays)` lowers an
overlay's selector `anchor` (`{ selector, at, dx, dy }`) and a typing overlay's
`maxWidth: "anchor"` into concrete `x` / `y` / `wrapWidth` against a live
Playwright page — the resolution step that previously lived only inside
`composeAnimateConfig`, now reachable by imperative scripting-API callers.

## Why

Selector anchoring was available only to declarative (JSON-config) users. The
lowering of `anchor` / `maxWidth: "anchor"` against the live page happened inside
`composeAnimateConfig` and wasn't exposed. Imperative users of the scripting API
(`captureElementTree` + `generateAnimatedSvg`) therefore had no way to anchor an
overlay to a selector — they measured `getBoundingClientRect` by hand and passed
raw coordinates. (The motivating consumer is a demo-capture script that
hand-rolls box measurement for a `<textarea>` typing overlay.)

## Surface

```ts
import { resolveOverlays } from "domotion-svg";

const [overlay] = await resolveOverlays(page, [
  {
    kind: "typing",
    text,
    x: 0, y: 0,                                   // placeholder; replaced by the anchor
    anchor: { selector: "#field", at: "top-left", dx: 2, dy: 2 },
    maxWidth: "anchor",                           // → the field's content width
    caret: true,
  },
]);
// overlay.x / overlay.y / overlay.wrapWidth are now concrete numbers, the
// anchor / maxWidth keys are gone — ready for generateAnimatedSvg.
```

- **Input** (`AnchoredOverlay[]`): a resolved overlay (`TypingOverlay` /
  `TapOverlay` / `SvgOverlay` / `BlinkOverlay` / `ShineOverlay` / `InteractOverlay`,
  `src/animation/resolve-overlays.ts`) plus optional `anchor`, and — for
  typing — `maxWidth: "anchor" | number`.
- **Output**: the same overlays with `x` / `y` (and typing `wrapWidth`) concrete
  and the `anchor` / `maxWidth` keys stripped.
- **Anchor point**: resolved against the element's **border** box
  (`getBoundingClientRect`), matching the declarative anchor's long-standing
  behavior. `at` is the nine-position vocabulary (`"top-left"` … `"bottom-right"`,
  default `"top-left"`); `dx` / `dy` nudge from it. The corner math is shared
  with `contentBox` via `boxAnchorPoint` (DM-1133).
- **`maxWidth`**: `"anchor"` resolves to the anchored element's **content** width
  (`clientWidth` − horizontal padding); a number passes through to `wrapWidth`.
- A missing anchor selector is a **hard error** (fail-fast, like the declarative
  anchor).

## One engine, two callers

The CLI and the public primitive call the **same** code: the shared
`resolveAnchoredOverlays` engine in `src/animation/resolve-overlays.ts`.
`composeAnimateConfig`'s private `resolveOverlayAnchors` is now a one-line
wrapper that supplies the frame-indexed error label; `resolveOverlays` is the
public wrapper typed for the resolved-overlay-plus-anchor union. They can no
longer diverge.

## Scope / not covered

- **SVG-overlay file resolution.** `resolveOverlays` resolves only the page
  geometry (anchor + maxWidth). The `svg` kind takes a resolved `innerSvg`, not a
  file `src` — reading + id-namespacing a file is a CLI-only concern
  (`resolveSvgOverlays`), not page resolution. The CLI runs its anchor resolution
  first, then inlines svg `src`, exactly as before.
- **Cursor `selector` → point and the action runner** are resolved separately (a
  cursor target is the element's border-box center; actions drive Playwright).
  These now ship as their own root-exported primitives — `resolveCursorTarget` /
  `borderBox` / `runActions` (`src/index.ts`; see doc 63) — rather than being
  folded into this overlay resolver. Imperative callers needing a cursor point can
  also use `boxAnchorPoint` over a measured rect (or `contentBox(page, sel, { at:
  "center" })` for the content-box center).

## Related

- `docs/59-overlay-schema-ssot.md` — the resolved/authoring overlay split this
  builds on.
- `docs/60-programmatic-animate-pipeline.md` — the whole declarative pipeline,
  for callers who want the config rather than per-overlay resolution.
- `contentBox` / `boxAnchorPoint` (DM-1133, `docs/api.md`) — the padding-inset
  box helper and the shared corner math.

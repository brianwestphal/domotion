---
id: "requirements/overlay-resolution-primitive"
title: "61 — Overlay resolution as a public primitive"
kind: "contract"
status: "current"
owners: ["animation"]
platforms: []
tickets: ["DM-1132","DM-1133","DM-1793","DM-1799","DM-587"]
code: ["src/animation/resolve-overlays.ts","src/index.ts","tests/cross-region-anchor.e2e.test.ts"]
aliases: ["docs/61-overlay-resolution-primitive.md","doc-61"]
---

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

## Two box producers, one arithmetic (DM-1799)

Everything above measures the anchor in **page** context. That is exact wherever
the page can stand at the moment the overlay belongs to — which is every ordinary
frame, and every state of a *sequential* compressed run.

It is not exact in one place: a compressed run using **per-region timing**
(`regions` + `advances`, [docs/43 §11.1](43-declarative-animate-config.md)).
There, states advancing disjoint regions share one whole-page capture, and each
state's tree is **assembled** afterwards by taking each region's subtree from the
round holding *that region's* own state. The live page never stands in the
assembled configuration, so an anchor pointing into a region on a **different**
schedule would resolve against whatever that region held in the round the state
was driven in — off by however far that region's schedule had diverged.

So the engine now has **two box producers and one arithmetic**:

| | Box from | Used by |
|---|---|---|
| `resolveAnchoredOverlays` | `page.evaluate` — `getBoundingClientRect`, computed styles, canvas `measureText` | everything (the default) |
| `resolveAnchoredOverlaysInTree` | a captured element in an **assembled tree** | per-state overlays of a per-region-timing run |

Both hand their `AnchorBox` to the same `applyAnchorBox`, so the corner math,
`maxWidth: "anchor"`, `fontFamily: "anchor"`, the baseline placement, and the
`shine`/`interact` auto-size + auto-radius cannot drift between them.

This is possible because the captured element already carries every input the
page probe measures — including `fontAscent` / `fontDescent`, which come from the
**same** `canvas.measureText("Hg")` call and have been captured since DM-587 for
the renderer's own baseline math.

**Finding the element.** The tree resolver does not run CSS selectors. The caller
stamps each anchor target with `data-domotion-anim` before capture — the
mechanism `regions` and `textTracks` already use — and passes a
selector→animId lookup. A selector that was never stamped, or a stamp with no
element in the tree, is a hard error, matching the page path's fail-fast policy.
Building a selector engine over the captured tree is deliberately out of scope.

**Two documented differences**, both consequences of reading a serialized tree:

- **Content width** is `width − horizontal borders − horizontal padding`, where
  the page uses `clientWidth − padding`. These agree except when the element has
  a vertical scrollbar, which `clientWidth` excludes and the captured `width`
  does not.
- **`fontAscent` / `fontDescent` are pre-scaled** by the element's cumulative
  ancestor scale at capture (DM-587), while the page probe measures the unscaled
  computed font. Inside a `transform: scale()` subtree the captured value is the
  one matching painted output, so the tree resolver is if anything the more
  faithful — but the two are not interchangeable.

**Why the page resolver stays the default.** It is correct wherever the page can
stand at the right moment, it is what every shipped golden was measured under,
and it can see things the tree never will (anything capture drops). Only the
per-region-timing path needs the tree.

Regression coverage: `tests/cross-region-anchor.e2e.test.ts` drives two panes on
interleaved schedules with each editor state anchoring into the preview pane, and
asserts the two states' anchors land exactly one marker step apart. Reverting to
page-context resolution fails it by exactly that step, which is the DM-1793 bug.

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

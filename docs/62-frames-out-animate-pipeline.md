# 62 — Frames-out / per-frame hook for the declarative animate pipeline

Status: **shipped** (DM-1136). Both sections are implemented: §1 (frames-out
`composeAnimateFrames`) in DM-1137 and §2 (the per-frame `onFrame` hook + the
options-object signature) in DM-1138. This opened up the all-or-nothing
`composeAnimateConfig` so a consumer who started from a JSON config can inject
custom per-frame manipulation without abandoning the declarative pipeline. The
call surface lives in `docs/60-programmatic-animate-pipeline.md` + `docs/api.md`.

## Why

After DM-1130 (doc 60) a library caller can run the whole declarative pipeline
in-process:

```ts
const svg = await composeAnimateConfig(browser, cfg); // config in, final SVG out
```

But it is **all-or-nothing**. The moment a consumer needs to inject a
hand-built overlay, tweak a captured tree, add bespoke window chrome, or run a
custom capture for one frame, they must abandon `composeAnimateConfig` entirely
and reimplement the whole capture → action → resolve → cull → magic-move →
compose loop with the lower-level primitives (`captureElementTree`,
`elementTreeToSvgInner`, `cullElementsOutsideViewBox`, `buildMagicMove`,
`resolveOverlays`, `buildCursorOverlay`, `generateAnimatedSvg`). That is the
opposite of the "start declarative, make a small change to evolve" goal that
motivated the DM-1128 gap analysis.

The gap is structural, not incidental: `composeAnimateConfig` interleaves all of
those steps in one `for` loop in `src/cli/animate.ts`, then computes
`cursorOverlay` / `resolveCursorAt` / `fontFaceCss` / `background` after the loop
and feeds everything to a single `generateAnimatedSvg(...)` call. The caller
sees only the two endpoints (config, SVG string) and nothing in between.

## The seam already exists

The end of `composeAnimateConfig` is already a clean split. After the frame loop
it assembles exactly the argument object that `generateAnimatedSvg` consumes:

```ts
// (today, inlined at the tail of composeAnimateConfig)
return generateAnimatedSvg({
  width: cfg.width, height: cfg.height,
  frames, fontFaceCss, cursorOverlay, resolveCursorAt, background: canvasBg,
});
```

That argument object **is** `AnimationConfig` (the renderer's public input type,
doc 08 / `src/animation/animator.ts`). So "produce the frames" and "render the
frames" are already separable with no new intermediate type — the intermediate
type is the existing `AnimationConfig`.

## Proposed surface

Two complementary additions. They are NOT alternatives — the frames-out variant
is the composable primitive, the hook is the low-friction in-place add-on
(ticket option 3, "both").

### 1. Frames-out variant — `composeAnimateFrames` (primary)

```ts
import { composeAnimateFrames, generateAnimatedSvg } from "domotion-svg";

// Same capture + action + overlay/cursor resolution pipeline as
// composeAnimateConfig, but STOPS before the final render and returns the
// assembled AnimationConfig.
const animation = await composeAnimateFrames(browser, cfg /*, configDir?, log? */);

// animation: AnimationConfig — { width, height, frames, fontFaceCss,
//   cursorOverlay, resolveCursorAt, background }

// The caller is free to mutate before rendering:
animation.frames[1].overlays = [...(animation.frames[1].overlays ?? []), myOverlay];
animation.frames.splice(2, 1);                 // drop a frame
animation.frames[0].svgContent += myWindowChrome;

const svg = generateAnimatedSvg(animation);    // caller renders when ready
```

- **Return type**: the existing `AnimationConfig`. No new public type to learn;
  it is already exported and already documented (doc 08).
- **`composeAnimateConfig` becomes a one-liner over it** — exactly the
  refactor pattern doc 60/61 established (one engine, two callers, can't
  diverge):

  ```ts
  export async function composeAnimateConfig(browser, cfg, configDir?, log?) {
    return generateAnimatedSvg(await composeAnimateFrames(browser, cfg, configDir, log));
  }
  ```

- **Same signature shape** as `composeAnimateConfig`: `configDir` defaults to
  `process.cwd()`, `log` defaults to a no-op (doc 60).
- This is the single biggest lever for the JSON → programmatic evolution path:
  a caller keeps every declarative convenience (selector anchors, the action
  runner, cursor `"auto"`, `${vars}`, continuous-session frames, magic-move)
  and only takes over the final render step.

### 2. Per-frame hook — `onFrame` callback (add-on)

For callers who want to mutate in place during the loop (e.g. touch the live
`page` between frames, or amend a frame as it is produced) rather than
post-process the whole array:

```ts
const svg = await composeAnimateConfig(browser, cfg, {
  configDir,
  log,
  onFrame: async (frame, ctx) => {
    // frame: the AnimationFrame just pushed (mutable)
    // ctx:  { page, tree, index } — the live Playwright page, this frame's
    //        captured CapturedElement[] tree (null for scroll-block frames),
    //        and the frame index.
    if (ctx.index === 0) frame.overlays = [...(frame.overlays ?? []), myOverlay];
  },
});
```

- Invoked **after** each frame is captured + culled + its overlays/anchors
  resolved and pushed to `frames`, and **before** the magic-move bridge for the
  prior frame is built (so a mutation to `frame.svgContent` is reflected, but a
  mutation that changes element geometry across a magic-move boundary is the
  caller's responsibility — documented caveat).
- `ctx.tree` is the same `CapturedElement[]` the renderer saw; mutating it after
  the fact does **not** re-render `frame.svgContent` (already a string by then).
  Callers wanting tree-level edits should use the frames-out variant + re-render,
  or mutate the DOM via `ctx.page` before capture using a declarative
  `evaluate` action. (Stated explicitly to avoid a footgun.)
- `onFrame` is plumbed through an **options object** added to
  `composeAnimateConfig` — see "Signature compatibility" below.

## Signature compatibility

`composeAnimateConfig` currently takes positional `(browser, cfg, configDir?,
log?)`. Adding `onFrame` positionally is ugly. Proposed: introduce an **options
object** as an optional 3rd parameter while keeping the positional form working
for one release.

Open question for the maintainer (captured as a follow-up decision, not blocking
this doc):

- **(A)** Overload: accept either `(browser, cfg, configDir?, log?)` OR
  `(browser, cfg, opts?)` where `opts = { configDir?, log?, onFrame? }`.
  Back-compatible, slightly more code.
- **(B)** Migrate to `(browser, cfg, opts?)` only, and bump the positional
  callers (just the CLI `runAnimate` + doc 60 examples). Cleaner, a breaking
  change to a young surface (DM-1130 shipped recently).

Recommendation: **(A)** for one minor release, then deprecate the positional
tail — `composeAnimateConfig` is part of the published `domotion-svg` API as of
DM-1130 and external callers may already use the positional form.

## Scope / not covered

- **No frame-level re-render helper.** The frames-out variant hands back
  `svgContent` strings already rendered from each tree. A caller that needs to
  edit the *tree* and re-render must call `elementTreeToSvgInner` themselves
  (the same primitive the pipeline uses). Exposing a "render this tree the way
  the pipeline did" convenience is a possible later addition but is out of scope
  here; the lower-level primitive is already public.
- **No streaming / incremental render.** `composeAnimateFrames` still runs the
  whole capture loop before returning — it is "stop before the final compose,"
  not "yield frames as they are captured." A generator/streaming form is a
  larger change with no current consumer.
- **Scroll-block frames** (`fc.scroll`) have no single captured tree, so
  `onFrame`'s `ctx.tree` is `null` for them and the frames-out variant's
  corresponding `frame.svgContent` is the composed scroll SVG — callers
  mutating it should treat it as opaque.

## Follow-up tickets

- **Implement `composeAnimateFrames`** — extract the post-loop assembly into the
  frames-out variant returning `AnimationConfig`; reduce `composeAnimateConfig`
  to `generateAnimatedSvg(await composeAnimateFrames(...))`; re-export from the
  package root; update doc 60 + `docs/api.md`.
- **Implement the `onFrame` hook + options-object signature** — decision (A)
  vs (B) above; unit-test the hook fires once per frame with the right
  `index` / `tree` / mutability semantics.
- **Companion: DM-1135** (doc 63) — expose the action vocabulary + cursor
  resolution as standalone primitives, closing the *other* half of the
  JSON ↔ programmatic gap (per-feature primitives vs the whole pipeline).

## Related

- `docs/60-programmatic-animate-pipeline.md` — the `composeAnimateConfig`
  surface this opens up.
- `docs/61-overlay-resolution-primitive.md` — the same "lower a CLI-internal
  step to a public primitive" pattern, for overlay anchor resolution.
- `docs/08-animation-model.md` — `AnimationConfig` / `AnimationFrame` /
  `generateAnimatedSvg`, the renderer input this hands back.

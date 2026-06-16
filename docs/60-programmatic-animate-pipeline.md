# 60 — Programmatic declarative-animate pipeline

Status: **shipped** (DM-1130). The JSON-config-driven animation pipeline that
powers `domotion animate` is now reachable from the public package surface, so a
library consumer can run a declarative animation in-process instead of shelling
out to the CLI or reimplementing the capture→compose loop by hand.

## Why

The declarative runner already existed but was unreachable: `composeAnimateConfig`
/ `validateAnimateConfig` / `interpolateConfigVars` and the `AnimateConfig` type
lived only in `src/cli/animate.ts`, and the package root re-exported
capture / render / animation / scroll / tree-ops / post-processing but never
`cli/`. A programmatic consumer doing `import { … } from "domotion-svg"` therefore
had to either spawn the `domotion animate` subprocess or hand-reimplement the
pipeline — losing every declarative convenience (selector anchors, the
declarative action runner, cursor `"auto"`, `${vars}`, continuous-session
frames). This surfaced while integrating 0.12.0 into a demo-capture script that
uses the low-level scripting API.

## Surface

Re-exported from the package root (`domotion-svg`):

| Export | Kind | What it does |
| --- | --- | --- |
| `validateAnimateConfig(raw)` | function | Parse + validate an untrusted object (`JSON.parse` of a config) into a typed `AnimateConfig`; throws `animate: <path>: <msg>` on failure. |
| `interpolateConfigVars(cfg)` | function | Resolve `${name}` against `cfg.vars` in every string field, returning a new config. (Called internally by `composeAnimateConfig`; exposed for callers who want the resolved config first.) |
| `composeAnimateConfig(browser, cfg, configDir?, log?)` | function | Capture + compose every frame into one animated SVG string (unoptimized), on a caller-owned Playwright `Browser`. Equals `generateAnimatedSvg(await composeAnimateFrames(...))`. |
| `composeAnimateFrames(browser, cfg, configDir?, log?)` | function | **Frames-out variant (DM-1137, doc 62 §1).** Same pipeline, but returns the assembled `AnimationConfig` (`{ width, height, frames, fontFaceCss, cursorOverlay, resolveCursorAt, background }`) instead of rendering — so callers can mutate the composed frames (add an overlay, drop a frame, post-process glyphs) before `generateAnimatedSvg(config)`. |
| `AnimateConfig` | type | `z.infer` of the animate-config zod schema. |
| `AnimationConfig` | type | The render-ready config `composeAnimateFrames` returns / `generateAnimatedSvg` accepts (distinct from the authoring-time `AnimateConfig`). |

Typical in-process use:

```ts
import { chromium } from "@playwright/test";
import { validateAnimateConfig, composeAnimateConfig, launchChromium } from "domotion-svg";

const cfg = validateAnimateConfig(JSON.parse(jsonText)); // or an object built in memory
const browser = await launchChromium();
try {
  const svg = await composeAnimateConfig(browser, cfg); // configDir / log optional
} finally {
  await browser.close();
}
```

The `domotion animate` CLI is now exactly this wrapper around the same function:
read file → `JSON.parse` → `validateAnimateConfig` → `composeAnimateConfig` →
optional `optimizeSvg` → write.

### Frames-out: mutate before rendering (DM-1137)

When you need to touch the composed frames before they're rendered — drop a
frame, graft on an overlay, post-process the per-frame `svgContent` — use
`composeAnimateFrames`, which returns the `AnimationConfig` instead of the SVG.
`composeAnimateConfig` is literally `generateAnimatedSvg` applied to its result,
so there's no divergence:

```ts
import { composeAnimateFrames, generateAnimatedSvg } from "domotion-svg";

const config = await composeAnimateFrames(browser, cfg, configDir);
config.frames = config.frames.filter((f) => /* keep some */ true); // mutate
const svg = generateAnimatedSvg(config);                           // then render
```

Caveat: mutating a frame's captured tree after the fact does NOT re-render its
already-composed `svgContent`; edit `svgContent` / `overlays` directly, or drop
and recompose. (The per-frame `onFrame` hook below is the in-pipeline counterpart
for touching each frame as it's composed.)

### Per-frame hook — `onFrame` (DM-1138)

To act on each frame **as it's composed** — while the page is still on that
frame's DOM — pass an `onFrame` hook via the options-object form of the trailing
argument (`{ configDir?, log?, onFrame? }`). It fires after the frame is captured,
culled, and pushed, before the magic-move bridge:

```ts
const svg = await composeAnimateConfig(browser, cfg, {
  configDir,
  onFrame: (frame, { page, tree, index }) => {
    // `frame` is the just-pushed AnimationFrame — mutating `frame.overlays`
    // (or `frame.svgContent`) IS reflected in the final SVG.
    if (index === 0) frame.overlays = [...(frame.overlays ?? []), myBadgeOverlay];
    // `page` is live on this frame's DOM; `tree` is the captured element tree
    // (null for scroll-block frames). May be async (it's awaited).
  },
});
```

The options form works on both `composeAnimateConfig` and `composeAnimateFrames`;
the positional `(configDir?, log?)` form stays supported. Caveats: mutating `tree`
does NOT re-render the already-serialized `frame.svgContent` (edit `svgContent` /
`overlays` instead); scroll-block frames pass `tree === null`.

## `configDir` is optional

`composeAnimateConfig`'s `configDir` resolves a frame's **relative** `input` and
svg-overlay `src` paths against a base directory. It now **defaults to
`process.cwd()`**, and `log` defaults to a no-op, so the common in-process call
is just `composeAnimateConfig(browser, cfg)`:

- Absolute `input` / `src` paths and `http(s)://` URLs ignore `configDir`
  entirely, so callers that already have concrete locations never need it.
- Callers loading a config from a file should still pass `dirname(configPath)`
  (what the CLI does) so the config's relative paths resolve against the config,
  not the process cwd.

The deeper "split path-resolution out so an in-process caller with content
already in memory needs no filesystem context at all" idea from the ticket is a
larger redesign (e.g. an input-loader injection point, support for `data:` /
inline-HTML inputs) and is **not** done here — relative-path resolution simply
became optional. Left as a follow-up if a concrete in-memory-input consumer
needs it.

## Implementation note — barrel cycle

`src/cli/animate.ts` previously imported the capture / render / animation /
scroll helpers from the package root (`../index.js`). Because the root now
re-exports `animate.ts`, that would form an import cycle, so `animate.ts` was
switched to import from the feature sub-barrels directly (`../animation/index
.js`, `../capture/index.js`, …), which don't depend on the root. No behavior
change; it just makes the dependency direction one-way (root → cli → features).

## Related

- `docs/43-declarative-animate-config.md` — the config format itself.
- `docs/59-overlay-schema-ssot.md` — the overlay shapes the config + renderer
  share.
- **DM-1132** — exposing the overlay *resolution* step (`anchor` → concrete
  `x`/`y`/`bgWidth`) as a standalone primitive, so imperative callers building
  their own frames (not whole configs) can opt into selector anchoring.

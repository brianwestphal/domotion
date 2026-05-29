# Public API

This document is the contract: every export listed below is part of the
`domotion-svg` npm package's public surface. Anything not listed is internal
and may change without a version bump.

The package's main entry is `dist/index.js`. Consumers should import from
`"domotion-svg"` (or `"domotion-svg/dist/index.js"`) — not from
`"domotion-svg/dist/<some-subpath>"`.

Per-feature barrels under `src/{capture,render,animation,scroll,tree-ops,post-processing}/index.ts`
each define their own curated surface; `src/index.ts` aggregates and is the
file you actually consume.

DM-622 (May 2026) rewrote this surface as a breaking change (0.1.1 → 0.2.0).
The cull was ~14 internal helpers; this list is what remains.

## Capture

In-browser DOM capture via Playwright Chromium. The capture step walks the
live DOM and produces a serializable element tree the renderer can consume.

| Export | Kind | Description |
| --- | --- | --- |
| `captureElementTree` | function | Run the capture script in a Playwright `Page` and return the element tree for the given selector + viewport. |
| `captureElementTreeWithWarnings` | function | Same as above but returns `{ tree, warnings }` instead of mutating a global buffer. |
| `getLastCaptureWarnings` | function | Read the warnings buffer populated by `captureElementTree`. Use when you can't switch to the `WithWarnings` form. |
| `logCaptureWarnings` | function | Pretty-print the warnings to stderr. |
| `embedRemoteImages` | function | Walk a captured tree and inline any `<img>` / `<image>` data into `data:` URIs so the SVG is self-contained. |
| `DemoRecorder` | class | Higher-level helper that captures N frames from a sequence of page states, ready for `generateAnimatedSvg`. |
| `launchChromium` | function | Convenience wrapper around `playwright.chromium.launch` with the headless / font / color-scheme defaults Domotion expects. |
| `CaptureOptions` | type | Options accepted by `captureElementTree` (viewport, color-scheme, raster pre-pass toggles, etc.). |
| `CapturedElement` | type | The serializable element-tree node — the contract between capture and render. |
| `CaptureWarning` | type | `{ selector, feature, detail }` entries reported by `getLastCaptureWarnings`. |

## Render

Pure functions that take a captured tree and emit SVG markup. No DOM access,
no Playwright dependency — these are the "node-side" half of the pipeline.

| Export | Kind | Description |
| --- | --- | --- |
| `elementTreeToSvg` | function | Render a captured element tree into a **complete `<svg>` document** (the obvious entry point for "give me a standalone SVG file"). Composes `elementTreeToSvgInner` + `wrapSvg`. |
| `elementTreeToSvgInner` | function | Render a captured tree into the **inner** body markup (no `<svg>` wrapper) — use this only for multi-frame composition where you emit one outer `<svg>` yourself. Previously called `elementTreeToSvg` (renamed in DM-950 to reflect what it actually emits). |
| `wrapSvg` | function | Wrap rendered body markup in a top-level `<svg>` element with viewBox + color-scheme attrs. |
| `registerWebfont` | function | Pre-register a webfont (family name + binary) so the renderer can shape glyphs against it. Use when capturing pages with custom fonts. |
| `clearWebfonts` | function | Clear the global webfont registry. Useful between independent captures in the same process. |
| `getGlyphDefs` | function | Read the accumulated `<defs>` (glyph paths) the renderer collected across calls. Used by frame-by-frame composers to share a single `<defs>` block. |
| `clearGlyphDefs` | function | Reset the glyph-defs accumulator. Pair with `getGlyphDefs` when rendering an independent sequence. |

## Animation

Compose multiple captured frames into one self-contained animated SVG with
CSS keyframe transitions + intra-frame property animations + optional cursor
and typing / tap / SVG overlays.

| Export | Kind | Description |
| --- | --- | --- |
| `generateAnimatedSvg` | function | Compose `frames[]` into one SVG with crossfade / push-left / scroll / cut transitions and overlays. |
| `AnimationConfig` | type | Top-level config: `{ width, height, frames, sharedDefs?, cursorOverlay?, resolveSelector? }`. |
| `AnimationFrame` | type | Per-frame data: `{ svgContent, duration, transition?, overlays?, animations?, cullCss? }`. |
| `AnimationOverlay` | type | Discriminated union of `TypingOverlay` \| `TapOverlay` \| `SvgOverlay`. (Renamed from `Overlay` in DM-622.) |
| `TypingOverlay` | type | Frame-relative typed-text reveal. |
| `TapOverlay` | type | Frame-relative tap-ripple at `(x, y)`. |
| `SvgOverlay` | type | Inline a separately-captured SVG over the frame (e.g. picture-in-picture). |
| `IntraFrameAnimation` | type | CSS property animation that runs while the frame is held. |
| `CursorOverlay` | type | Macro-style cursor track played across the scene timeline. |
| `CursorEvent` | type | Union of `Move` / `Click` / `Show` / `Hide`. |
| `CursorMoveEvent`, `CursorClickEvent`, `CursorShowEvent`, `CursorHideEvent` | type | Per-event variants. |
| `CursorStyle` | type | Cursor appearance (cursor icon + ripple color/size). |
| `SelectorResolver` | type | `(sel, frameIndex) => { x, y, w, h } | null` — for cursor events that target a DOM selector. |
| `cursorOverlayMarkup` | function | Lower-level builder for the cursor SVG markup if you're not using `generateAnimatedSvg`. |
| `resolveCursorScript` | function | Resolve a cursor event script against the captured frame coordinate space. |

## Scroll

Parse / execute / compose scroll-pattern animations per the DM-604 grammar.
Most consumers use the CLI subcommand; the programmatic surface is exposed
for tooling that wants to embed the scroll machinery.

| Export | Kind | Description |
| --- | --- | --- |
| `parseScrollPattern` | function | Parse a pattern string into the `ScrollPattern` AST. |
| `ScrollPatternError` | class | Thrown by the parser; carries source position. |
| `executeScrollPattern` | function | Walk a parsed `ScrollPattern` against a Playwright `Page`, capturing one segment per scroll step. |
| `ScrollExecutionError` | class | Thrown by the executor on resolver / capture failures. |
| `composeScrollSvg` | function | Compose segment captures into one animated SVG with scroll-aware keyframes. |
| `ScrollPattern` | type | Top-level pattern AST. (Renamed from `Pattern` in DM-622.) |
| `ScrollPatternSegment` | type | A pattern segment: bracketed or flat. (Renamed from `Segment`.) |
| `ScrollPatternAction` | type | A scroll or pause action inside a flat segment. (Renamed from `Action`.) |
| `ScrollAction`, `PauseAction` | type | The two action variants. |
| `ScrollAxis` | type | `"x"` \| `"y"`. (Renamed from `Axis`.) |
| `BracketedSegment`, `FlatSegment` | type | Segment variants. |
| `ScrollTarget`, `DeltaTarget`, `AbsoluteTarget` | type | Targets a scroll action moves toward. |
| `Anchor`, `NamedAnchor`, `SelectorAnchor` | type | Anchor variants for `AbsoluteTarget`. |
| `SignedLength`, `Length` | type | Length tokens with sign and unit. |
| `Easing` | type | Easing curves (named or `cubic-bezier`). |
| `UntilClause`, `PositionUntil`, `CountUntil` | type | `until` loop variants. |
| `ScrollExecutorOptions` | type | Options for `executeScrollPattern` (default speed, capture function, scroll behavior). |
| `ScrollComposerOptions` | type | Options for `composeScrollSvg` (output viewport, optimization). |

## Tree ops

Mutate / inspect / diff captured trees between capture and render. Useful
when you're driving the pipeline manually instead of through `DemoRecorder`.

| Export | Kind | Description |
| --- | --- | --- |
| `cullElementsOutsideViewBox` | function | Walk a captured tree and mark elements never visible at any time as `displayNone`. Returns `{ css }` with per-element visibility keyframes for animations that cross the viewBox boundary. (Renamed from `cullFrame` in DM-622.) |
| `resizeEmbeddedImages` | function | Walk a captured tree and resize / re-encode embedded image data URIs to a target dimension. |
| `ResizeEmbeddedImagesOptions` | type | Options for `resizeEmbeddedImages` (max dimension, JPEG quality, etc.). |
| `diffTrees` | function | Diff two element trees and return per-element diff entries. Used by the animator's frame-merge fast path. |
| `TreeDiff`, `DiffEntry`, `DiffEntryKind` | type | The diff result shape. |

## Post-processing

Optional passes that run after `elementTreeToSvg`. Both are pure string-in /
string-out.

| Export | Kind | Description |
| --- | --- | --- |
| `optimizeSvg` | function | Run svgo on the output. Aggressive enough to shrink real-world demos ~30-40% without touching paths. |
| `gzipSvg` | function | gzip the output (for serving as `.svgz`). |

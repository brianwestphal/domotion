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
| `contentBox` | function | `contentBox(page, selector, { at, dx, dy })` → the padding-inset **content** box of an element on a live page (viewport coords), plus a resolved `at` point. Where text actually starts inside a padded `<input>` / `<textarea>` — the one-liner imperative typing-overlay callers need instead of re-measuring padding by hand. Throws if the selector matches nothing. |
| `borderBox` | function | `borderBox(page, selector, { at, dx, dy })` → the **border** box (`getBoundingClientRect`, border + padding included), the symmetric sibling of `contentBox`, with the same `{ at, dx, dy }` anchor vocabulary and `{ x, y, width, height, at }` shape. This is the box the cursor targets (vs `contentBox` for typing overlays) — they differ by the element's border + padding. Throws if the selector matches nothing. |
| `resolveCursorTarget` | function | `resolveCursorTarget(page, selector)` → just the border-box **center** point `[x, y]` (= `borderBox(page, sel, { at: "center" }).at`). The sugar for building a cursor `{ type: "move", to: { x, y } }` event so imperative cursor choreography matches the CLI's `cursor: "auto"` / explicit-event resolution. Throws on no-match. |
| `boxAnchorPoint` | function | Pure helper behind `contentBox` / `borderBox`: resolve a named corner / edge / center (`"top-left"` … `"bottom-right"`, the overlay `anchor.at` vocabulary) of a `{x,y,width,height}` box, with an optional `dx`/`dy` nudge. |
| `ContentBox`, `ContentBoxOptions`, `BorderBox`, `BorderBoxOptions`, `BoxAnchor` | type | The `contentBox` / `borderBox` results, their options (`at`/`dx`/`dy`), and the named-anchor union. |
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
| `wrapInDeviceChrome` | function | Wrap a finished capture SVG in a device bezel (`phone` / `browser` / `window`) — nests the capture as a child `<svg>` (no re-render) and returns `{ svg, width, height }`. Takes an optional `{ label }` (browser URL / window title). Pure-SVG, cross-platform. See `docs/65-device-chrome.md`. |
| `isDeviceChrome` | function | Type-guard: is a string one of the supported `--chrome` devices? |
| `DEVICE_CHROMES` | const | The readonly list of supported device-chrome names (`["phone", "browser", "window"]`). |
| `isChromeTheme` | function | Type-guard: is a string one of the supported `--chrome-theme` values (`dark` / `light`)? |
| `CHROME_THEMES` | const | The readonly list of browser/window chrome themes (`["dark", "light"]`). |
| `DeviceChrome` / `ChromeTheme` / `DeviceChromeOptions` / `FramedSvg` | type | Companion types for `wrapInDeviceChrome`: the device name (`phone` / `browser` / `window`), the `dark` / `light` theme, the options object (`{ device, theme?, label? }`), and the `{ svg, width, height }` result. |
| `registerWebfont` | function | Pre-register a webfont (family name + binary) so the renderer can shape glyphs against it. Use when capturing pages with custom fonts. |
| `clearWebfonts` | function | Clear the global webfont registry. Useful between independent captures in the same process. |
| `getGlyphDefs` | function | Read the accumulated `<defs>` (glyph paths) the renderer collected across calls. Used by frame-by-frame composers to share a single `<defs>` block. |
| `clearGlyphDefs` | function | Reset the glyph-defs accumulator. Pair with `getGlyphDefs` when rendering an independent sequence. |
| `setRenderTextMode` / `getRenderTextMode` | function | Set / read how text is emitted — `"embedded-font"` (subset `@font-face` + `<text>`, the default) or `"paths"` (glyph outlines, per-pixel-faithful). `RenderTextMode` is the value type. |
| `withRenderTextMode` | function | `withRenderTextMode(mode, fn)` — run `fn` with the render-text mode set to `mode`, restoring the prior value afterward (even if `fn` throws). The mode is a process-global; prefer this save/restore wrapper over a bare `setRenderTextMode` for a scoped change so it can't leak into later renders. |
| `clearEmbeddedFonts` | function | Reset the embedded-font subset builder (used by `"embedded"` mode) between independent captures. |
| `getEmbeddedFontFaceCss` | function | Read the accumulated base64 `@font-face` CSS for the glyphs rendered in `"embedded"` mode — emit it once into the document's `<style>`. |
| `acquireGlyphHelper` | function | Ensure the platform native glyph-extraction helper binary is present (downloads + caches it on first use). Returns its path, or `null` when unavailable. See docs 50 / 51. |

## Animation

Compose multiple captured frames into one self-contained animated SVG with
CSS keyframe transitions + intra-frame property animations + optional cursor
and typing / tap / SVG overlays.

| Export | Kind | Description |
| --- | --- | --- |
| `generateAnimatedSvg` | function | Compose `frames[]` into one SVG with crossfade / push-left / scroll / cut transitions and overlays. |
| `composeAnimatedLayers` | function | **Animated-SVG compositing (DM-1323).** `composeAnimatedLayers(layers, { width, height, durationMs?, background? })` → `{ svg, width, height, durationMs }`. Stacks already-rendered SVGs (each possibly *animated* — a cast, scroll capture, template, or another composite), z-ordered, each placed at `x`/`y`/`width`/`height` with an independent timeline (`start`, `mode: hold\|stretch\|loop`) and optional layer-level `animations`, animation preserved. Layer animations: `translateX`/`translateY`/`scale`/`transform`/`opacity` (move/scale/fade), and `clipScaleX`/`clipScaleY` to **resize a layer's visible box** (e.g. shrink a window) without scaling its contents — so chrome buttons keep their size and inner content reflows. The declarative front-end is `domotion composite`. See `docs/77-nested-animated-compositing.md`. |
| `CompositeLayer` / `CompositeLayerAnimation` / `ComposeLayersOptions` / `CompositeResult` | type | The `composeAnimatedLayers` parameter + result shapes. |
| `namespaceEmbeddedAnimatedSvg` | function | Prefix every document-global name (ids, `@keyframes`, classes, embedded-font families, `--scene-dur`) of a complete animated-SVG document with a token, so it can nest inside another animated SVG without collisions. The id-collision building block under compositing / `cast` + `template` frames. |
| `offsetEmbeddedAnimatedSvgTimeline` | function | Re-anchor a nested animated SVG's internal timeline onto a container's master loop: `{ periodMs, startMs, masterMs, mode?, windowMs? }`. `hold` plays once at the natural rate then freezes; `stretch` scales to fill `windowMs`; `loop` repeats. The per-layer timeline building block (DM-1319 / DM-1323). |
| `NamespaceEmbedOptions` | type | Options for `namespaceEmbeddedAnimatedSvg`. |
| `OffsetTimelineOptions` | type | Options for `offsetEmbeddedAnimatedSvgTimeline` (`{ periodMs, startMs, masterMs, mode?, windowMs? }`). |
| `EmbeddedTimelineMode` | type | `"hold"` \| `"stretch"` \| `"loop"` — the nested-timeline playback mode. |
| `AnimationConfig` | type | Top-level config: `{ width, height, frames, sharedDefs?, fontFaceCss?, cursorOverlay?, resolveSelector?, background? }`. (`fontFaceCss` injects embedded-font `@font-face` once; `background` paints a full-viewport canvas rect.) |
| `AnimationFrame` | type | Per-frame data: `{ svgContent, duration, transition?, magicMove?, overlays?, animations?, cullCss? }`. (`magicMove` is the per-frame bridge layer built by `buildMagicMove`.) |
| `AnimationOverlay` | type | Discriminated union of `TypingOverlay` \| `TapOverlay` \| `SvgOverlay`. (Renamed from `Overlay` in DM-622.) |
| `TypingOverlay` | type | Frame-relative typed-text reveal. Character-by-character with the caret glued to the fontkit-measured text edge (DM-1518); `mode: "type" \| "paste"` and `jitter: 0–1` tune the feel. See `docs/93-realistic-typing.md`. |
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
| `cursorAtPoint` | function | Resolve the effective CSS `cursor` keyword at a viewport point `(x, y)` against a captured tree — the topmost element (paint order) whose box contains the point (DM-1106). For placing a cursor overlay over whatever is actually under the pointer. |
| `cursorGlyphSvg` | function | Build the SVG markup for a named cursor glyph at `(x, y)`: `cursorGlyphSvg(value, x, y, size?, color?)` — the standalone cursor-icon renderer. |
| `CURSOR_GLYPHS` | const | Map of cursor keyword → `CursorGlyph` (the Lucide-authored cursor icon set). |
| `CURSOR_CATEGORIES` | const | The cursor keywords grouped into titled categories (`{ title, values }[]`) — for pickers / docs. |
| `CursorGlyph` | type | One authored cursor glyph: 24×24 Lucide-box `body` markup, `fill` (silhouette vs. line-art), and the hotspot point. |
| `CursorTimelineEntry` | type | `{ t, cursor }` — one entry in a resolved cursor timeline. |
| `CursorAtResolver` | type | `(x, y, frameIndex) => string` — resolve the cursor keyword at a point, per frame. |
| `buildMagicMove` | function | Build the magic-move bridge layer from a `(prevTree, nextTree)` pair (matched elements slide, added/removed cross-fade). Set the result as `AnimationFrame.magicMove` when the frame's `transition.type` is `"magic-move"`. See doc 53. |
| `resolveOverlays` | function | `resolveOverlays(page, overlays)` → lower each overlay's selector `anchor` (`{ selector, at, dx, dy }`) and a typing overlay's `maxWidth: "anchor"` into concrete `x` / `y` / `bgWidth` against a live page, returning overlays ready for `generateAnimatedSvg`. The same resolution the declarative CLI runs, for imperative callers. See doc 61. |
| `OverlayAnchor`, `AnchoredOverlay` | type | The anchor descriptor (`{ selector, at?, dx?, dy? }`) and the `resolveOverlays` input (a resolved overlay plus optional `anchor` / typing `maxWidth`). |
| `MagicMove` | type | The bridge layer `buildMagicMove` returns (composite markup + per-element slide / fade descriptors). |
| `MagicMoveSlide` | type | One matched-element slide entry within a `MagicMove`. |

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
| `compressEmbeddedFontsToWoff2` | function | Async post-pass that re-compresses embedded TTF `@font-face` data URIs to WOFF2 (~40% off the font bytes; cross-browser-verified). Applied by the CLI `--optimize` step. |
| `gzipSvg` | function | gzip the output (for serving as `.svgz`). |

## Declarative animate pipeline

The JSON-config-driven animation pipeline that powers the `domotion animate`
CLI, exposed (DM-1130) so library callers can run it in-process — anchors,
declarative actions, cursor `"auto"`, `${vars}`, continuous-session frames —
without shelling out to the CLI or reimplementing it. See
`docs/43-declarative-animate-config.md` (the config spec) and
`docs/60-programmatic-animate-pipeline.md` (the programmatic surface).

| Export | Kind | Description |
| --- | --- | --- |
| `validateAnimateConfig` | function | Parse + validate an untrusted config object (e.g. `JSON.parse` of a config file) against the zod schema, returning a typed `AnimateConfig`. Throws an `animate:`-prefixed error listing each offending path on failure. |
| `interpolateConfigVars` | function | Resolve `${name}` references against the config's top-level `vars` map across every string field, returning a new config. `composeAnimateConfig` calls this itself; exposed for callers who want the resolved config first. |
| `composeAnimateConfig` | function | Capture + compose every frame of an `AnimateConfig` into one animated SVG string (unoptimized), using a caller-owned Playwright `Browser`. `composeAnimateConfig(browser, cfg)` is the typical call. The trailing args accept either the positional `(configDir?, log?)` or a single `ComposeAnimateOptions` object `{ configDir?, log?, onFrame? }` (DM-1138). `configDir` (default `process.cwd()`) resolves relative `input` / svg-overlay `src` paths; `log` defaults to a no-op. Equivalent to `generateAnimatedSvg(await composeAnimateFrames(...))`. |
| `composeAnimateFrames` | function | The **frames-out** variant (DM-1137): runs the identical capture + action + overlay/cursor + cull + magic-move pipeline but returns the assembled `AnimationConfig` (`{ width, height, frames, fontFaceCss, cursorOverlay, resolveCursorAt, background }`) instead of rendering. Mutate the frames (add an overlay, drop a frame, post-process) then `generateAnimatedSvg(config)`. Same `(browser, cfg, configDir?|opts?, log?)` signature as `composeAnimateConfig`. |
| `OnFrameHook` | type | `(frame, { page, tree, index }) => void \| Promise<void>` (DM-1138) — the per-frame callback fired after each frame is captured + pushed, before the magic-move bridge. `frame` is the just-pushed `AnimationFrame` (mutating `frame.overlays` is reflected in the SVG); `page` is the live page; `tree` is the captured `CapturedElement[]` (or `null` for scroll-block frames). Mutating `tree` does NOT re-render `frame.svgContent`. |
| `ComposeAnimateOptions` | type | The options-object form of the `composeAnimateConfig` / `composeAnimateFrames` trailing args: `{ configDir?, log?, onFrame? }`. |
| `AnimateConfig` | type | The validated config shape (`z.infer` of the animate-config zod schema): `{ width, height, frames, vars?, cursor?, … }`. |
| `runActions` | function | `runActions(page, actions, log?)` — apply the declarative action vocabulary against a live Playwright `page`, in order. The payoff for imperative callers is the DOM-mutation set (setText / addClass / insert / replaceText / setStyle / dispatch / …) that aren't one-line Playwright calls; each applies across **every** matched element and throws if the selector matches nothing. `log` defaults to a no-op (the CLI passes one for the `evaluate`-too-long nudge). |
| `AnimateAction` | type | The declarative action union accepted by `runActions` (and a config frame's `actions`): the interaction actions (click / fill / press / hover / focus / selectOption / scroll / wait / evaluate) plus the DOM-mutation set. |
| `applyForcedPseudoStates` | function | `applyForcedPseudoStates(page, forceState, log?)` — force each `{ selector, states }` entry into its CSS pseudo-classes (`:hover` / `:active` / `:focus` / …) via CDP `CSS.forcePseudoState` **before** capture, so a subsequent `captureElementTree` paints the page's OWN interaction styling (cascade siblings like `.card:has(.cta:hover)` included). Applies across every matched element; throws on no match; no-op on an empty list. The CDP session is intentionally left attached — the forced override is cleared the instant the session detaches, so it must outlive the capture. The imperative twin of a config frame's `forceState`. See `docs/94-interaction-state-capture.md`. |
| `ForceState` | type | One `{ selector, states }` forced-pseudo-state entry consumed by `applyForcedPseudoStates` and a config frame's `forceState` array. `states` is a non-empty list of the supported pseudo-classes (hover / active / focus / focus-within / focus-visible / visited / target / enabled / disabled / checked / indeterminate / read-only / read-write / link). |

## Templates

Parameterized generators that produce a self-contained SVG by driving the existing capture → compose pipeline (templates add no new rendering code). See `docs/70-template-system.md`; authoring a third-party `domotion-template-<name>` package is `docs/74-template-authoring.md`.

| Export | Kind | Description |
| --- | --- | --- |
| `renderTemplateToSvg` | function | `renderTemplateToSvg(template, params, opts?)` → `TemplateOutput` (`{ svg, width, height, durationMs? }`). Validates `params` against the template's schema, then renders it (owns a temp `workDir` + browser unless one is passed in `opts`). The primary entry point. |
| `RenderTemplateOptions` | type | Options for `renderTemplateToSvg` (`{ browser?, … }`). |
| `Template` | type | The template contract a generator/decorator implements: `{ name, description, paramsSchema, render(params, ctx) }`. |
| `TemplateRenderContext` | type | The building blocks passed to `render`: `{ browser, workDir, log, runAnimateConfig, captureToSvg }`. |
| `TemplateOutput` | type | A template's result: `{ svg, width, height, durationMs? }`. |
| `validateTemplateParams` | function | Validate + default a params object against a template's `paramsSchema` (throws a path-specific error on bad input). |
| `isTemplate` | function | Type-guard that a value is a valid `Template` (used by the third-party package loader). |
| `loadTemplate` | function | Resolve a bare name to a built-in, else `import("domotion-template-<name>")`; the registry mechanism behind `domotion template <name>`. |
| `listBuiltinTemplates` / `getBuiltinTemplate` | function | Enumerate / look up the seven first-party built-ins. |
| `templatePackageName` | function | Map a bare name → its `domotion-template-<name>` npm package name. |
| `templateParamsJsonSchema` / `describeTemplateParams` | function | Project a template's zod `paramsSchema` to a JSON Schema / a `ParamInfo[]` flag list (powers `--help` + editor autocompletion). |
| `ParamInfo` | type | One projected param (name, type, default, description) from `describeTemplateParams`. |
| `lowerThirdTemplate` / `LowerThirdParams` | const / type | Built-in: broadcast lower-third banner. |
| `deviceMockupTemplate` / `DeviceMockupParams` | const / type | Built-in: wrap a captured page in a phone/browser/window bezel (decorator; `screenSvg` nests an animated screen). |
| `backgroundLoopTemplate` / `BackgroundLoopParams` / `BackgroundVariant` | const / type | Built-in: seamless looping background (aurora/orbs/stars/gradient-pan/grid/wave). |
| `kineticTextTemplate` / `KineticTextParams` / `KineticVariant` | const / type | Built-in: kinetic typography (rise/slide/fade/clip/pop). |
| `chartTemplate` / `ChartParams` / `ChartType` | const / type | Built-in: animated column/bar/line/pie/donut chart. |
| `chatTemplate` / `ChatParams` / `ChatMessage` | const / type | Built-in: message-thread bubbles popping in. |
| `subscribeTemplate` / `SubscribeParams` | const / type | Built-in: subscribe/follow pop-up card. |

## Terminal capture

Turn a recorded terminal session (asciinema v2 `.cast`) into an animated SVG. See `docs/67-terminal-capture.md`.

| Export | Kind | Description |
|--------|------|-------------|
| `castToAnimatedSvg` | function | `castToAnimatedSvg(castText, browser, opts?)` → `{ svg, width, height, frameCount, totalDurationMs }`. Parse a cast, replay it through the headless VT emulator, select settle-point frames, render each, and stitch them with hard cuts. `opts` (`TermToSvgOptions`): `theme`/`fontSize`/`fontFamily`/`padding`/`cols`/`rows` + the `settleMs`/`minFrameMs`/`maxFrameMs`/`tailMs` timing knobs + `log`. |
| `castToTermFrames` | function | The **frames-out** half: `castToTermFrames(castText, browser, opts?)` → `{ frames, width, height, totalDurationMs, fontFaceCss }`. Returns one `AnimationFrame` per settle-point (svgContent + duration + `cut` transitions) so you can retime, wrap in window chrome, or re-transition before `generateAnimatedSvg` (pass the returned `fontFaceCss` so the font embeds once, not per frame). `opts.manageFonts: false` defers the font to a host pipeline that collects it. `castToAnimatedSvg` is `generateAnimatedSvg(await this(...))`. |
| `parseCast` | function | `parseCast(text)` → `{ header, events, duration }` — parse an asciinema v2 cast document (header + `[time, "o", data]` output events). |
| `TerminalEmulator` | class | `new TerminalEmulator(cols, rows, theme?)` wraps `@xterm/headless`: `.write(data)` feeds bytes, `.snapshot()` reads the screen as a `TermGrid` of resolved styled cells, `.dispose()` frees it. |
| `gridSignature` | function | `gridSignature(grid)` → a comparable string (trailing blanks trimmed) used to skip snapshots identical to the previous one. |
| `buildFrames` | function | `buildFrames(emulator, events, opts?)` → `TermFrame[]` (`{ grid, durationMs }`) — replay events and snapshot at settle points, deriving per-frame holds and merging identical screens. |
| `gridToHtml` | function | `gridToHtml(grid, opts)` → a self-contained terminal HTML document (monospace rows of style-coalesced spans) for the capture→SVG pipeline. |
| `THEMES` | object | Built-in `TerminalTheme`s: `catppuccin` (default), `dark`, `github-light`. |
| `resolveThemeSpec` | function | `resolveThemeSpec(spec)` → a concrete `TerminalTheme`. `spec` is a built-in name OR a `TerminalThemeSpec` object overriding `bg` / `fg` / `ansi[16]` on top of an `extends` base. Powers the `--theme` / `--theme-file` / `--bg` / `--fg` CLI flags and the JSON `term.theme`. |
| `xterm256ToHex` | function | `xterm256ToHex(index)` → hex for an xterm 256-color palette index (16–231 cube, 232–255 grayscale). |
| `TermToSvgOptions` / `TermToSvgResult` / `TermFramesResult` | type | The options + result shapes for `castToAnimatedSvg` / `castToTermFrames`. |
| `ParsedCast` / `CastHeader` / `CastOutputEvent` | type | The `parseCast` result shapes. |
| `TermCell` / `TermGrid` | type | A resolved terminal cell (char + fg/bg/bold/italic/dim/underline) and a grid of them. |
| `FrameBuildOptions` / `TermFrame` / `HtmlRenderOptions` | type | The `buildFrames` / `gridToHtml` option + frame shapes. |
| `TerminalTheme` | type | A palette: `{ name, bg, fg, ansi[16] }`. |
| `TerminalThemeSpec` | type | A custom-theme override: `{ extends?, name?, bg?, fg?, ansi? }` — any subset, merged onto the `extends` base (default catppuccin). |

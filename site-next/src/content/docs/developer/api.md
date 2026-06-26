---
title: Scripting API
description: Use Domotion's primitives as a library when you outgrow the CLI.
---

When you outgrow the CLI — custom interaction loops, programmatic frame
composition, custom overlays — the same primitives are available as a library.
Everything below is a named export of `domotion-svg` (ESM), the same surface the
CLI is built on. This page is the canonical reference for that surface.

The pipeline is always the same three stages: **capture** a live page into a
serializable element tree, **render** that tree to SVG markup, and (optionally)
**compose** multiple rendered frames into one animated SVG. Here is the whole
round trip end to end:

```ts
import { captureElementTree, elementTreeToSvg, launchChromium } from "domotion-svg";

const browser = await launchChromium();
const page = await browser.newPage();
await page.setContent(`<div style="padding:20px;color:white;background:#0d1117">Hello</div>`);

const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 800, height: 200 });
const svg = elementTreeToSvg(tree, 800, 200);

console.log(svg);
await browser.close();
```

## On this page

- [**Common tasks**](#common-tasks) — the high-level helpers a typical consumer
  reaches for: capture & render, animate, templates, terminal recordings,
  compositing, device chrome, and export.
- [**Advanced & low-level**](#advanced--low-level) — the internal primitives the
  high-level helpers are built on. Most consumers never need these; they're here
  for hand-rolling a pipeline, custom overlays, or fine font control.

## Common tasks

### Capture & render a page

`launchChromium` → `captureElementTree` → `elementTreeToSvg` is the core path: a
live page in, a standalone SVG file out.

```ts
function launchChromium(opts?: LaunchOptions): Promise<Browser>
function captureElementTree(
  page: Page,
  selector?: string,                                       // default "body"
  viewport: { x: number; y: number; width: number; height: number },
): Promise<CapturedElement[]>
function elementTreeToSvg(
  elements: CapturedElement[],
  width: number,
  height: number,
  opts?: {
    idPrefix?: string;
    includeGlyphDefs?: boolean;
    hiDPIFactor?: number;            // default 2
    includeEmbeddedFontCss?: boolean;
  },
): string
```

`launchChromium` launches Chromium via Playwright, auto-installing the browser
binary on first use if it's missing (it shells out to
`npx playwright install chromium` and inherits stdout/stderr so the user sees
progress). Use this instead of importing `chromium` from `@playwright/test`
directly when you want a frictionless first-run experience; `opts` is forwarded
to Playwright's `chromium.launch()`.

`captureElementTree` walks the DOM of a live page into a serializable element
tree — the intermediate representation every renderer consumes. Warnings about
unsupported features encountered during the walk are stored and accessible via
`getLastCaptureWarnings()` / `logCaptureWarnings()` (see
[Advanced & low-level](#capture-internals)).

`elementTreeToSvg` renders that tree into a **complete `<svg>` document** — the
entry point for "I have a tree, give me a standalone SVG file." Most
single-frame callers want this.

```ts
const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 800, height: 200 });
const svg = elementTreeToSvg(tree, 800, 200);
```

### Animate multiple frames

Compose several rendered frames into one self-contained animated SVG. There are
two paths: the imperative `generateAnimatedSvg`, and the declarative
JSON-config path (`validateAnimateConfig` + `composeAnimateConfig`) that powers
`domotion animate`.

```ts
function generateAnimatedSvg(config: AnimationConfig): string
```

`generateAnimatedSvg` composes per-frame element trees plus transition / overlay
config into one self-contained animated SVG with `@keyframes` cross-fade /
push-left / scroll / cut / magic-move transitions and optional typing / tap /
SVG / cursor overlays. `AnimationConfig` carries `{ width, height,
frames: AnimationFrame[], sharedDefs?, fontFaceCss?, cursorOverlay?,
background?, loopFade?, ... }`; each `AnimationFrame` has `{ svgContent,
duration, transition?, overlays?, ... }`.

```ts
import { generateAnimatedSvg } from "domotion-svg";

const svg = generateAnimatedSvg({
  width: 800,
  height: 400,
  frames: [
    { svgContent: frame0, duration: 1500, transition: { type: "crossfade", duration: 400 } },
    { svgContent: frame1, duration: 1500 },
  ],
});
```

For the declarative path, run the same pipeline `domotion animate` uses
in-process instead of shelling out to the CLI:

```ts
function validateAnimateConfig(raw: unknown): AnimateConfig
function composeAnimateConfig(
  browser: Browser,
  cfg: AnimateConfig,
  configDirOrOpts?: string | ComposeAnimateOptions,
  log?: (msg: string) => void,
): Promise<string>
```

`validateAnimateConfig` parses untrusted JSON into a typed, validated
`AnimateConfig` (throws on the first schema violation, listing the offending
paths). `composeAnimateConfig` is the full pipeline in one call —
`generateAnimatedSvg(await composeAnimateFrames(...))` — and returns the
finished animated SVG string. The trailing argument accepts either a `configDir`
string or a `ComposeAnimateOptions` object (`{ configDir?, log?, onFrame? }`);
`configDir` resolves relative `input` / SVG-overlay `src` paths and defaults to
`process.cwd()`.

```ts
import { launchChromium, validateAnimateConfig, composeAnimateConfig } from "domotion-svg";

const cfg = validateAnimateConfig(JSON.parse(rawJson));
const browser = await launchChromium();
const svg = await composeAnimateConfig(browser, cfg, "./config-dir");
await browser.close();
```

For the config schema and a field-by-field reference, see
[Animate config](/domotion/developer/animate-config/) and the generated
[Animate config reference](/domotion/developer/reference/animate-config-reference/).

### Generate from a template

Templates are parameterized generators that produce a self-contained SVG by
driving the capture → compose pipeline (they add no new rendering code). See
[Custom templates](/domotion/developer/custom-templates/) for the authoring
contract.

```ts
function renderTemplateToSvg<P>(
  template: Template<P>,
  rawParams: unknown,
  opts?: RenderTemplateOptions,                            // { browser?, log? }
): Promise<TemplateOutput>                                 // { svg, width, height }
function listBuiltinTemplates(): string[]
```

`renderTemplateToSvg` validates `rawParams` against the template's schema, then
renders it to an SVG. A browser is launched and closed around the render unless
you pass one in `opts`. `listBuiltinTemplates` enumerates the built-ins by name.

Each built-in is a `Template<P>` value (plus its params type) you can pass
directly to `renderTemplateToSvg`:

```ts
const lowerThirdTemplate: Template<LowerThirdParams>
const deviceMockupTemplate: Template<DeviceMockupParams>
const backgroundLoopTemplate: Template<BackgroundLoopParams>
const kineticTextTemplate: Template<KineticTextParams>
const chartTemplate: Template<ChartParams>
const chatTemplate: Template<ChatParams>
const subscribeTemplate: Template<SubscribeParams>
```

```ts
import { renderTemplateToSvg, chartTemplate } from "domotion-svg";

const { svg } = await renderTemplateToSvg(chartTemplate, {
  type: "bar",
  data: [12, 30, 18, 45],
});
```

Loading templates by name, the registry, and param introspection live in
[Advanced & low-level](#template-helpers).

### Terminal recordings

Turn a recorded terminal session (asciinema v2 `.cast`) into an animated SVG in
one call.

```ts
function castToAnimatedSvg(
  castText: string,
  browser: Browser,
  opts?: TermToSvgOptions,
): Promise<TermToSvgResult>                                // { svg, width, height, frameCount, totalDurationMs }
```

Parses the cast, emulates it, renders each settle point, and composes to an
animated SVG. `TermToSvgOptions` covers `theme`, `cols` / `rows`, `fontSize`,
`fontFamily`, `padding`, `cursor` shape, and the `mode` (`"incremental"` — small
true-incremental reveal, the default — or `"full"` whole-screen frames).

```ts
import { launchChromium, castToAnimatedSvg } from "domotion-svg";
import { readFileSync } from "node:fs";

const browser = await launchChromium();
const { svg } = await castToAnimatedSvg(readFileSync("session.cast", "utf-8"), browser);
await browser.close();
```

The lower-level cast parser, emulator, and frame builders are in
[Advanced & low-level](#terminal-internals).

### Composite layers

Stack already-rendered SVGs (static or animated) into one composite.

```ts
function composeAnimatedLayers(layers: CompositeLayer[], opts: ComposeLayersOptions): CompositeResult
```

Each layer is placed at its own `{ x, y, width, height }` and runs on its own
timeline with animation intact — e.g. a phone window growing over a background
loop. Each `CompositeLayer` can carry layer-level `animations` (`scale` /
`translateX/Y` / `opacity` / `transform`, plus `clipScaleX/Y` to resize a
layer's visible box without scaling its contents). Returns `{ svg, width,
height, durationMs }`.

The lower-level nesting primitives this is built on are in
[Advanced & low-level](#animation-internals).

### Wrap in device chrome

Wrap a finished capture SVG in a hand-drawn device bezel.

```ts
function wrapInDeviceChrome(
  captureSvg: string,
  device: DeviceChrome,                                    // "phone" | "browser" | "window"
  screenW: number,
  screenH: number,
  opts?: DeviceChromeOptions,                              // { label?, theme? }
): FramedSvg                                               // { svg, width, height }
```

Wraps a capture SVG in a phone body, browser window, or plain app window, and
returns the framed SVG plus its new outer dimensions. The capture is **nested**
(not re-rendered), so glyph paths stay byte-identical. `label` fills the browser
URL bar / window title; `theme` is `"dark"` (default) or `"light"` for the
browser/window bezels.

```ts
const { svg, width, height } = wrapInDeviceChrome(captureSvg, "phone", 390, 844);
```

The enum constants and type guards behind the `--chrome` flags are in
[Advanced & low-level](#device-chrome-internals).

### Optimize & export

Optional post-processing passes that run after rendering.

```ts
function optimizeSvg(svg: string): string
function gzipSvg(svg: string): Buffer
```

`optimizeSvg` runs an svgo pass to shrink the markup (string in, string out);
`gzipSvg` returns the gzip-compressed bytes for serving as a `.svgz` (most
Domotion output compresses dramatically since it's plain text).

## Advanced & low-level

The primitives the [Common tasks](#common-tasks) helpers are built on. Reach for
these when hand-rolling a pipeline, composing frames yourself, building custom
overlays, or taking fine control of fonts and text rendering. Most consumers
never need this section.

### Render internals {#render-internals}

```ts
function elementTreeToSvgInner(
  elements: CapturedElement[],
  width: number,
  height: number,
  idPrefix?: string,
  includeGlyphDefs?: boolean,
  hiDPIFactor?: number,
  includeEmbeddedFontCss?: boolean,
): string
function wrapSvg(inner: string, width: number, height: number, opts?: { tree?: CapturedElement[] }): string
```

`elementTreeToSvgInner` renders only the **body markup** (no outer `<svg>`
wrapper). Multi-frame composers (the animator, the scroll composer) call this
directly and emit one outer `<svg>` themselves, so per-frame `idPrefix`-scoped
ids don't collide and the embedded-font CSS isn't duplicated per frame.
`wrapSvg` wraps inner body markup in a complete `<svg>` document; pass the
originating `tree` so the wrapper can emit the correct color-scheme attribute and
root-background rect. (`elementTreeToSvg` is `wrapSvg` ∘ `elementTreeToSvgInner`.)

### Text-render mode and fonts {#font-helpers}

```ts
type RenderTextMode = "paths" | "embedded-font"
function setRenderTextMode(mode: RenderTextMode): void
function getRenderTextMode(): RenderTextMode
function clearEmbeddedFonts(): void
function getEmbeddedFontFaceCss(): string
```

Domotion defaults to `embedded-font` mode: glyphs are drawn with a subset font
embedded once as base64 `@font-face` CSS. `paths` mode draws every glyph as an
SVG `<path>` (per-pixel faithful, larger output). When composing multiple frames
yourself, call `clearEmbeddedFonts()` before a generation, render each frame with
`includeEmbeddedFontCss: false`, then pass the accumulated
`getEmbeddedFontFaceCss()` into the composer so the font bytes appear once.

```ts
function registerWebfont(family: string, weight: number, style: string, buffer: Buffer, unicodeRange?: Array<[number, number]>): void
function clearWebfonts(): void
```

Register font bytes (a `.ttf`/`.otf`/`.woff` buffer) under a CSS family so the
renderer draws with the page's actual webfont glyphs instead of a system-font
substitute. Call `clearWebfonts()` between captures that use different fonts.

```ts
function getGlyphDefs(): string
function clearGlyphDefs(): void
function acquireGlyphHelper(opts?: AcquireOptions): Promise<string | null>
```

`getGlyphDefs()` / `clearGlyphDefs()` manage the shared glyph-path registry used
in `paths` mode. `acquireGlyphHelper()` pre-warms the native glyph-helper cache
(downloads + SHA-verifies the platform release asset) ahead of rendering instead
of paying the lazy first-render cost; it returns `null` on unsupported platforms
or when offline (the renderer falls back to fontkit either way).

### Capture internals {#capture-internals}

```ts
function captureElementTreeWithWarnings(
  page: Page,
  selector?: string,
  viewport: { x: number; y: number; width: number; height: number },
  opts?: { rasterizeFromImagePath?: string },
): Promise<{ tree: CapturedElement[]; warnings: CaptureWarning[] }>
```

The same capture as `captureElementTree`, but returns the warnings inline rather
than only via the module global — use this when running multiple captures
concurrently so they don't race on the shared warning buffer.

```ts
function embedRemoteImages(
  tree: CapturedElement[],
  options?: EmbedRemoteImagesOptions,                      // { warnings?, timeoutMs?, retries?, retryBackoffMs? }
): Promise<void>
```

Fetch every `http(s)` image URL referenced by the captured tree and inline it as
a `data:` URI, so the resulting SVG loads correctly in offline image viewers
(Preview, Finder QuickLook, thumbnails) that don't fetch remote resources from
local files. Mutates the tree in place. Per-URL fetch failures leave the URL as
is and surface a `remote-image` `CaptureWarning`.

```ts
function getLastCaptureWarnings(): CaptureWarning[]
function logCaptureWarnings(label?: string): void
```

`getLastCaptureWarnings()` returns the warnings recorded by the most recent
capture on this process; `logCaptureWarnings()` prints them to the console under
an optional label.

```ts
function contentBox(page: Page, selector: string, opts?: ContentBoxOptions): Promise<ContentBox>
function borderBox(page: Page, selector: string, opts?: BorderBoxOptions): Promise<BorderBox>
function resolveCursorTarget(page: Page, selector: string): Promise<[number, number]>
function boxAnchorPoint(box: Rect, at?: BoxAnchor, dx?: number, dy?: number): [number, number]
```

Measure where things actually sit on a live page so imperative overlays land
correctly. `contentBox` returns the padding-inset content box of a selector
(where text starts inside a padded field — the anchor for a typing overlay);
`borderBox` is the symmetric border-box sibling; `resolveCursorTarget` is the
border-box-center sugar the CLI cursor uses; `boxAnchorPoint` resolves a named
anchor (`"top-left"`, `"center"`, …) on a rect, with optional pixel offsets.

```ts
class DemoRecorder {
  constructor(baseUrl: string, opts: CaptureOptions)
  init(opts: CaptureOptions): Promise<void>
  captureUrl(path: string, waitMs?: number, idPrefix?: string): Promise<string>
  captureCurrent(idPrefix?: string): Promise<string>
  captureFullPage(idPrefix?: string): Promise<{ svgContent: string; pageHeight: number }>
  getPage(): Page
  getBoundingBox(selector: string): Promise<{ x: number; y: number; width: number; height: number } | null>
  close(): Promise<void>
}
```

A higher-level helper that owns the browser, a viewport-sized context, and a
page, and turns a navigation (or the current page state) into SVG in one call.
Construct it with a base URL and `CaptureOptions` (`{ width, height, mobile?,
colorScheme?, selfContained?, ... }`), call `init()`, then drive it. `getPage()`
hands you the underlying Playwright page for custom interactions before
capturing.

### Tree operations {#tree-operations}

Transform, inspect, or diff captured trees between capture and render.

```ts
function cullElementsOutsideViewBox(elements, width, height, ...): string
function resizeEmbeddedImages(tree: CapturedElement[], opts?: ResizeEmbeddedImagesOptions): Promise<void>
function diffTrees(prev: CapturedElement[], next: CapturedElement[]): TreeDiff
```

- **`cullElementsOutsideViewBox`** marks elements outside a viewBox window as
  culled (and returns the per-class visibility keyframes the animator splices
  in) — used to scroll a tall capture through a fixed window.
- **`resizeEmbeddedImages`** downscales each inlined image to its render rect (×
  a hiDPI factor) and re-encodes it, shrinking the output with no visible diff.
- **`diffTrees`** pairs elements across two captures (the input `buildMagicMove`
  consumes).

### Animation internals {#animation-internals}

```ts
function buildMagicMove(
  prevTree: CapturedElement | CapturedElement[],
  nextTree: CapturedElement | CapturedElement[],
  render: (roots: CapturedElement[], idPrefix: string) => string,
  idPrefix: string,
): MagicMove | null
```

Build the magic-move bridge layer between two captured trees: matched elements
slide from their old position to their new one while added/removed elements
cross-fade. Returns `null` when nothing is worth animating (the caller then falls
back to `crossfade`). Attach the result to the originating frame's `magicMove`
field and set its `transition.type` to `"magic-move"`. `render` is a thin
`elementTreeToSvg`-style wrapper, injected to keep the module renderer-agnostic.

```ts
function namespaceEmbeddedAnimatedSvg(svg: string, token: string, opts?: NamespaceEmbedOptions): string
function offsetEmbeddedAnimatedSvgTimeline(svg: string, opts: OffsetTimelineOptions): string
```

The lower-level nesting primitives `composeAnimatedLayers` is built on, exposed
for callers assembling composites by hand: `namespaceEmbeddedAnimatedSvg`
prefixes a nested SVG's global names (ids, keyframes, classes, optionally font
families) so it can't collide with siblings; `offsetEmbeddedAnimatedSvgTimeline`
re-anchors a nested SVG's internal timeline into a window of the master loop.

```ts
function cursorOverlayMarkup(...): string
function resolveCursorScript(...): ...
function cursorAtPoint(...): ...
function cursorGlyphSvg(glyph: CursorGlyph, ...): string
const CURSOR_GLYPHS: ...
const CURSOR_CATEGORIES: ...
```

Render a macOS-style cursor moving along a script timeline with click pulses
(`cursorOverlayMarkup` / `resolveCursorScript`), hit-test which cursor keyword
sits under a point for the auto cursor-type overlay (`cursorAtPoint`), and draw
an individual cursor glyph (`cursorGlyphSvg`, plus the `CURSOR_GLYPHS` /
`CURSOR_CATEGORIES` tables). Wire the resolved overlay into
`AnimationConfig.cursorOverlay`.

```ts
function resolveOverlays(page: Page, overlays: AnchoredOverlay[]): Promise<(TypingOverlay | TapOverlay | SvgOverlay | BlinkOverlay)[]>
```

Lower selector-anchored overlays into concrete-coordinate overlays against a
live page — the resolution step the declarative CLI runs, made reachable for
imperative `captureElementTree` + `generateAnimatedSvg` callers.

### Declarative animate internals {#declarative-internals}

The remaining stages of the JSON-config pipeline behind
`composeAnimateConfig`. See [Animate config](/domotion/developer/animate-config/)
and the [Animate config reference](/domotion/developer/reference/animate-config-reference/)
for the schema.

```ts
function interpolateConfigVars(cfg: AnimateConfig): AnimateConfig
```

Resolve `${vars}` placeholders across every string field of a config and return
the substituted copy.

```ts
function composeAnimateFrames(
  browser: Browser,
  cfg: AnimateConfig,
  configDirOrOpts?: string | ComposeAnimateOptions,
  log?: (msg: string) => void,
): Promise<AnimationConfig>
```

Capture and compose every frame (anchors, actions, cursor `auto`, vars) into the
assembled `AnimationConfig` — the **frames-out** half. Mutate the frames if you
like, then hand the result to `generateAnimatedSvg`. The trailing argument
accepts either a `configDir` string or a `ComposeAnimateOptions` object
(`{ configDir?, log?, onFrame? }`); `configDir` resolves a frame's relative
`input` / SVG-overlay `src` paths and defaults to `process.cwd()`.

```ts
function runActions(page: Page, actions: AnimateAction[], log?: (msg: string) => void): Promise<void>
```

Apply the declarative action vocabulary (`click` / `fill` / `setText` /
`addClass` / `insert` / `setStyle` / `dispatch` / …) against a live page, in
order — the DOM-mutation half of a config without authoring JSON. Throws on the
first failing action (e.g. a selector that matches nothing) rather than silently
skipping.

### Scroll primitives {#scroll-internals}

Capture a tall page and animate it scrolling through a fixed viewport, driven by
a small pattern language.

```ts
function parseScrollPattern(source: string): ScrollPattern
function executeScrollPattern(page: Page, pattern: ScrollPattern, opts: ScrollExecutorOptions): Promise<ScrollSegmentCapture[]>
function composeScrollSvg(segments: ScrollSegmentCapture[], opts: ScrollComposerOptions): string
class ScrollPatternError extends Error {}
class ScrollExecutionError extends Error {}
```

`parseScrollPattern` turns a pattern string into an AST (throwing
`ScrollPatternError` on bad syntax); `executeScrollPattern` drives the page
through it, capturing one segment per stop; `composeScrollSvg` stitches those
segment captures into a single animated SVG that scrolls between anchors.

```ts
const pattern = parseScrollPattern("down to .pricing, pause 1s, down 600px");
const segments = await executeScrollPattern(page, pattern, { viewportW: 1024, viewportH: 768 });
const svg = composeScrollSvg(segments, { viewportW: 1024, viewportH: 768, axis: "y" });
```

### Terminal internals {#terminal-internals}

```ts
function castToTermFrames(
  castText: string,
  browser: Browser,
  opts?: TermToSvgOptions,
): Promise<TermFramesResult>                               // { frames, width, height, totalDurationMs, fontFaceCss }
```

The **frames-out** half of `castToAnimatedSvg` — returns the individual
`AnimationFrame`s so you can retime, wrap in window chrome, or interleave them
with other frames before calling `generateAnimatedSvg` yourself.

```ts
function parseCast(castText: string): ParsedCast
class TerminalEmulator { constructor(cols: number, rows: number, theme: TerminalTheme); /* ... */ }
function buildFrames(emu: TerminalEmulator, events, opts, resizes): Promise<TermFrame[]>
function gridToHtml(grid: TermGrid, opts?: HtmlRenderOptions): string
function gridSignature(grid: TermGrid): string
const THEMES: Record<string, TerminalTheme>
function resolveThemeSpec(spec?: string | TerminalThemeSpec): TerminalTheme
function xterm256ToHex(index: number): string
```

`parseCast` reads the asciinema header + output events; `TerminalEmulator` +
`buildFrames` replay them into settle-point grids; `gridToHtml` renders a grid to
the HTML Domotion then captures; `gridSignature` fingerprints a grid for
de-duplication; `THEMES` / `resolveThemeSpec` / `xterm256ToHex` cover color
themes and 256-color → hex conversion.

### Device-chrome internals {#device-chrome-internals}

```ts
const DEVICE_CHROMES: readonly ["phone", "browser", "window"]
const CHROME_THEMES: readonly ["dark", "light"]
function isDeviceChrome(value: string): value is DeviceChrome
function isChromeTheme(value: string): value is ChromeTheme
```

The enumerations the CLI's `--chrome` / `--chrome-theme` flags validate against,
with their runtime type guards.

### Template helpers {#template-helpers}

```ts
function loadTemplate(name: string): Promise<Template<unknown>>
function getBuiltinTemplate(name: string): Template<unknown> | undefined
function templatePackageName(name: string): string
function isTemplate(value: unknown): value is Template<unknown>
function validateTemplateParams<P>(template: Template<P>, raw: unknown): P
```

`loadTemplate` resolves a built-in by name or a published
`domotion-template-<name>` npm package; `getBuiltinTemplate` looks up a built-in
by name; `templatePackageName` maps a short name to its package name;
`isTemplate` is the runtime type guard; `validateTemplateParams` applies a
template's schema (with defaults) to raw params. (`listBuiltinTemplates`, which
enumerates the built-ins, is in [Common tasks](#generate-from-a-template).)

```ts
function templateParamsJsonSchema(template: Template<unknown>): object
function describeTemplateParams(template: Template<unknown>): ParamInfo[]
```

Surface a template's parameters as a JSON Schema, or as a flat `ParamInfo[]`
list (name, type, default, description) for building UIs / docs.

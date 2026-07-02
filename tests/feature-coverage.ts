/**
 * Canonical feature/requirement index (DM-1459).
 *
 * Line/branch coverage proves every *line executed*; it says nothing about
 * whether every documented *behavior* — or every *transition between states* —
 * is actually *asserted*. This manifest is the orthogonal axis: one entry per
 * documented behavior, mapping it to the public export(s)/CLI verb(s) that
 * implement it and the test(s) that would fail if it regressed.
 *
 * `tools/check-feature-coverage.mjs` (`npm run check:features`) reads this file
 * and reports:
 *   - **Gaps** — a feature with `tests: []` (documented behavior, no asserting
 *     test).
 *   - **Broken refs** — a `tests` path that no longer exists (renamed/deleted
 *     test).
 *   - **Drift** — a public value-export (from `dist/index.js`) or a CLI verb/bin
 *     not claimed by any feature's `exports`/`verbs`. This makes the index
 *     SELF-POLICING: a new export or verb added without a feature entry fails
 *     the check, forcing the index to grow with the code.
 *
 * `tests/conventions.test.ts` asserts this manifest is well-formed (unique ids,
 * every `tests` path exists) as part of the unit gate.
 *
 * Modeled on the apple-fm coverage-by-feature exercise (see `docs/83-feature-
 * coverage.md`). Stateful modules carry a `transition` note: the index MUST
 * cover transitions between states (mode set→scope→restore, until-loop
 * iteration, transition-to-transition composition), not just single operations
 * from a clean state — that is exactly the gap line coverage is blind to.
 */

export interface FeatureEntry {
  /** Stable id, `area.behavior`. */
  id: string;
  /** One-line behavior description (what would break). */
  behavior: string;
  /** Doc reference(s) — a numbered doc, FEATURES.md anchor, or CLAUDE.md section. */
  doc?: string;
  /** Public value-exports (from the package barrel) this feature owns. */
  exports?: string[];
  /** CLI verbs (`capture`/`animate`/…) and/or bins (`svg-to-video`/…) it owns. */
  verbs?: string[];
  /** Repo-relative test file(s) that assert this behavior. `[]` = KNOWN GAP. */
  tests: string[];
  /** Present when this is a state-*transition* assertion; describes the transition. */
  transition?: string;
}

export const FEATURES: FeatureEntry[] = [
  // ── Capture ────────────────────────────────────────────────────────────
  {
    id: "capture.element-tree",
    behavior: "Walk a live Chromium page into a serializable element tree (with computed styles / geometry).",
    doc: "docs/ai/code-summary.md",
    exports: ["captureElementTree", "captureElementTreeWithWarnings", "launchChromium"],
    verbs: ["capture", "domotion"],
    tests: ["src/capture/content-box.test.ts", "tests/examples-use-real-pipelines.test.ts"],
  },
  {
    id: "capture.warnings",
    behavior: "Collect + surface capture-time warnings (unsupported CSS, fetch failures) rather than silently dropping.",
    doc: "docs/01-fidelity.md",
    exports: ["getLastCaptureWarnings", "logCaptureWarnings"],
    tests: ["src/capture/warnings.test.ts"],
  },
  {
    id: "capture.iframe-recursion",
    behavior: "A same-origin <iframe> recurses into native SVG; a cross-origin frame stays raster unless allowlisted.",
    doc: "docs/81-iframe-recursion.md",
    tests: ["src/capture/script/cross-origin.test.ts"],
    transition: "raster-fallback → native-recursion when contentDocument becomes readable (same-origin, or cross-origin via --cross-origin-frames).",
  },
  {
    id: "capture.emoji-detect",
    behavior: "Detect color-emoji runs at capture time so they route to the raster fallback, not glyph paths.",
    doc: "docs/reference/raster-image-fallback-cases.md",
    exports: [],
    tests: ["src/capture/emoji.test.ts", "src/capture/script/emoji-detect.test.ts"],
  },

  // ── Render (DOM tree → SVG) ────────────────────────────────────────────
  {
    id: "render.tree-to-svg",
    behavior: "Render a captured tree to a complete <svg> document (and body-only inner markup for composers).",
    doc: "docs/ai/code-summary.md",
    exports: ["elementTreeToSvg", "elementTreeToSvgInner", "wrapSvg"],
    tests: ["src/render/borders.test.ts", "src/render/box-shadow.test.ts", "src/mask.test.ts", "src/render/gradients.test.ts", "src/render/list-markers.test.ts"],
  },
  {
    id: "render.text",
    behavior: "Emit text as real glyph paths (single-line / multi-segment / multi-line / input), with bidi mirroring + decorations.",
    doc: "docs/03-font-family-chain.md",
    exports: [],
    tests: ["src/render/text.test.ts", "src/render/text-to-path.test.ts", "src/render/vertical-text.test.ts"],
  },
  {
    id: "render.optimize",
    behavior: "Optional SVGO optimize pass + gzip (.svgz) output.",
    doc: "docs/26-self-contained-svgs.md",
    exports: ["optimizeSvg", "gzipSvg"],
    tests: ["src/post-processing/optimize.test.ts"],
  },
  {
    id: "postprocess.clip-transform-safety",
    behavior: "Detect the Firefox-only trap of `transform-box: fill-box` inside a `<clipPath>`/`<mask>` (ignored by Firefox → clip/mask pivots about the SVG origin). Surfaced non-fatally by composite over caller-supplied layers; assert variant fails fast.",
    doc: "docs/84-viewer-browser-support.md",
    exports: ["findFillBoxInClipOrMask", "assertNoFillBoxInClipOrMask"],
    tests: ["src/post-processing/clip-transform-safety.test.ts", "src/animation/composite.test.ts"],
  },
  {
    id: "render.embed-images",
    behavior: "Embed remote images as data URIs and resize oversized embeds to the target raster size.",
    doc: "docs/26-self-contained-svgs.md",
    exports: ["embedRemoteImages", "resizeEmbeddedImages"],
    tests: ["src/embed-remote-images.test.ts", "src/tree-ops/resize-embedded-images.test.ts"],
  },
  {
    id: "render.cull",
    behavior: "Cull elements outside the viewBox before render (scroll composer perf).",
    doc: "docs/ai/code-summary.md",
    exports: ["cullElementsOutsideViewBox"],
    tests: ["src/tree-ops/viewbox-culling.test.ts"],
  },
  {
    id: "render.transparent-bg",
    behavior: "A transparent page/root/canvas background yields a transparent SVG — no opaque backdrop rect painted.",
    doc: "docs/26-self-contained-svgs.md",
    exports: [],
    tests: ["src/animation/animator.test.ts", "src/scroll/composer.test.ts", "src/animation/composite.test.ts", "src/cli/svg-to-video-core.test.ts"],
  },

  // ── Text-render mode (STATEFUL: process-global save/restore) ────────────
  {
    id: "text.mode",
    behavior: "Text-render mode is a process-global (embedded-font vs paths); withRenderTextMode is a save/restore scope guard.",
    doc: "docs/ai/code-summary.md",
    exports: ["getRenderTextMode", "setRenderTextMode", "withRenderTextMode"],
    tests: ["src/render/render-text-mode-guard.test.ts"],
    transition: "default(embedded-font) → set(paths) → withRenderTextMode(embedded-font, cb) restores paths afterward, EVEN WHEN cb throws.",
  },
  {
    id: "text.glyph-defs",
    behavior: "The shared glyph-defs registry is live in paths mode (visual harness / scroll composer); cleared per generation.",
    doc: "docs/ai/code-summary.md",
    exports: ["getGlyphDefs", "clearGlyphDefs"],
    tests: ["src/render/glyph-registry.test.ts", "src/render/render-text-mode-guard.test.ts"],
    transition: "empty → ensureGlyphDef populates (paths mode) → resetGeneration/clearGlyphDefs empties it for the next frame.",
  },
  {
    id: "text.embedded-fonts",
    behavior: "Embedded-font mode collects @font-face CSS across a render; cleared between generations.",
    doc: "docs/ai/code-summary.md",
    exports: ["getEmbeddedFontFaceCss", "clearEmbeddedFonts"],
    tests: ["src/render/embedded-font-builder.test.ts"],
    transition: "clear → per-run registration accumulates → getEmbeddedFontFaceCss emits once → clearEmbeddedFonts resets.",
  },

  // ── Fonts / webfonts ───────────────────────────────────────────────────
  {
    id: "fonts.webfonts",
    behavior: "Register + clear discovered webfonts (unicode-range subsetting, cross-origin fetch).",
    doc: "docs/03-font-family-chain.md",
    exports: ["registerWebfont", "clearWebfonts"],
    tests: ["src/webfont-unicode-range.test.ts", "src/cross-origin-font-face.test.ts"],
  },
  {
    id: "fonts.glyph-helper",
    behavior: "Acquire the platform glyph-extraction helper (CoreText / fontconfig / DirectWrite).",
    doc: "docs/80-cross-platform-system-fallback-resolver.md",
    exports: ["acquireGlyphHelper"],
    tests: ["src/render/helper-acquire.test.ts", "src/render/glyph-helper.test.ts"],
  },

  // ── Scroll (STATEFUL: pattern → executor state machine) ─────────────────
  {
    id: "scroll.pattern",
    behavior: "Tokenize + parse the scroll-pattern language (delta/absolute targets, direction prefix, easing, until).",
    doc: "docs/37-scroll-pattern-grammar.md",
    exports: ["parseScrollPattern", "ScrollPatternError"],
    tests: ["src/scroll/pattern.test.ts"],
  },
  {
    id: "scroll.execute",
    behavior: "Execute a parsed pattern against a page: axis resolution, sign-multiplied delta, speed→duration, until loops.",
    doc: "docs/37-scroll-pattern-grammar.md",
    exports: ["executeScrollPattern", "ScrollExecutionError"],
    tests: ["src/scroll/executor.test.ts"],
    transition: "until-loop re-evaluates the condition per iteration; the final iteration clamps to the target (clampScrollToTarget), and a no-progress body ends the loop.",
  },
  {
    id: "scroll.compose",
    behavior: "Compose captured scroll segments into one animated scrolling SVG (fixed/sticky hoisting, visibility windows).",
    doc: "docs/ai/code-summary.md",
    exports: ["composeScrollSvg"],
    tests: ["src/scroll/composer.test.ts", "src/scroll/hoist-fixed.test.ts", "src/scroll/hoist-sticky.test.ts"],
  },

  // ── Animate (STATEFUL: multi-frame transition composition) ──────────────
  {
    id: "animate.generate",
    behavior: "Compose captured frames into one animated SVG with @keyframes.",
    doc: "docs/ai/code-summary.md",
    exports: ["generateAnimatedSvg"],
    tests: ["src/animation/animator.test.ts"],
  },
  {
    id: "animate.transitions",
    behavior: "Frame transitions (crossfade / cut / push-left / scroll / magic-move) COMPOSE — each scene's entrance is composed from the predecessor's transition.",
    doc: "docs/53-magic-move-transition.md",
    exports: [],
    tests: ["src/animation/animator-mixed-transitions.test.ts"],
    transition: "a frame's entrance depends on the PREVIOUS transition type (fade-in after crossfade, slide-in after a same-axis slide, cut after cut) — the transition-to-transition matrix.",
  },
  {
    id: "animate.magic-move",
    behavior: "Magic-move: matched elements glide prev→next, added fade in, removed fade out, across a bridge composite.",
    doc: "docs/53-magic-move-transition.md",
    exports: ["buildMagicMove"],
    tests: ["src/animation/magic-move.test.ts"],
  },
  {
    id: "animate.frames-pipeline",
    behavior: "Build/compose frames + config from the animate JSON (continuous sessions, cast/template frames).",
    doc: "docs/60-programmatic-animate-pipeline.md",
    exports: ["buildFrames", "composeAnimateFrames", "composeAnimateConfig"],
    verbs: ["animate"],
    tests: ["src/cli/animate.test.ts", "tests/showcase-transitions.test.ts"],
  },
  {
    id: "animate.config",
    behavior: "Validate the animate config (zod) + ${} var interpolation.",
    doc: "docs/60-programmatic-animate-pipeline.md",
    exports: ["validateAnimateConfig", "interpolateConfigVars"],
    tests: ["src/cli/animate-config-json-schema.test.ts", "src/cli/animate.test.ts"],
  },
  {
    id: "animate.overlays",
    behavior: "Resolve typing/tap/svg/blink overlays + DOM-mutation/interaction actions.",
    doc: "docs/61-overlay-resolution-primitive.md",
    exports: ["resolveOverlays", "runActions"],
    tests: ["src/animation/resolve-overlays.test.ts", "src/animation/overlay-schema.test.ts"],
  },
  {
    id: "animate.tree-diff",
    behavior: "Diff two captured trees (magic-move matching / continuous-session frames).",
    doc: "docs/62-frames-out-animate-pipeline.md",
    exports: ["diffTrees"],
    tests: ["src/tree-ops/tree-diff.test.ts"],
  },
  {
    id: "animate.cursor",
    behavior: "Cursor overlay (explicit path or auto): glyph, timeline, click resolution, element anchoring.",
    doc: "docs/63-cursor-action-primitives.md",
    exports: ["cursorOverlayMarkup", "cursorAtPoint", "cursorGlyphSvg", "resolveCursorScript", "resolveCursorTarget", "CURSOR_CATEGORIES", "CURSOR_GLYPHS", "boxAnchorPoint"],
    tests: ["src/animation/cursor-overlay.test.ts"],
  },

  // ── Composite (STATEFUL: nested animated timelines) ─────────────────────
  {
    id: "composite.layers",
    behavior: "Stack already-rendered (possibly animated) SVGs into one, each on its own re-anchored timeline, id-namespaced.",
    doc: "docs/77-nested-animated-compositing.md",
    exports: ["composeAnimatedLayers", "namespaceEmbeddedAnimatedSvg", "offsetEmbeddedAnimatedSvgTimeline"],
    verbs: ["composite"],
    tests: ["src/animation/composite.test.ts", "src/animation/embed-namespace.test.ts", "src/animation/embed-timeline.test.ts", "src/cli/composite.test.ts"],
    transition: "a layer's internal timeline is re-anchored to start at its own `start` within the composite master loop and hold/stretch/loop before/after.",
  },

  // ── Templates ──────────────────────────────────────────────────────────
  {
    id: "templates.registry",
    behavior: "Resolve a template by name (built-in first, else domotion-template-<name> npm), render + describe + validate params.",
    doc: "docs/70-template-system.md",
    exports: ["loadTemplate", "getBuiltinTemplate", "listBuiltinTemplates", "isTemplate", "renderTemplateToSvg", "describeTemplateParams", "templateParamsJsonSchema", "validateTemplateParams", "templatePackageName"],
    verbs: ["template"],
    tests: ["src/templates/templates.test.ts"],
  },
  {
    id: "templates.builtins",
    behavior: "The seven built-in template generators.",
    doc: "docs/70-template-system.md",
    exports: ["lowerThirdTemplate", "chartTemplate", "chatTemplate", "subscribeTemplate", "kineticTextTemplate", "backgroundLoopTemplate", "deviceMockupTemplate"],
    tests: ["src/templates/templates.test.ts"],
  },

  // ── Terminal ───────────────────────────────────────────────────────────
  {
    id: "terminal.cast",
    behavior: "Parse an asciinema v2 .cast → term frames → animated terminal SVG.",
    doc: "docs/67-terminal-capture.md",
    exports: ["parseCast", "castToTermFrames", "castToAnimatedSvg"],
    verbs: ["term"],
    tests: ["src/terminal/terminal.test.ts"],
  },
  {
    id: "terminal.emulator",
    behavior: "Headless xterm emulator → cell grid → HTML, with a stable per-grid signature.",
    doc: "docs/67-terminal-capture.md",
    exports: ["TerminalEmulator", "xterm256ToHex", "gridSignature", "gridToHtml"],
    tests: ["src/terminal/terminal.test.ts", "src/terminal/pty.test.ts"],
  },
  {
    id: "terminal.theme",
    behavior: "Terminal color themes + theme-spec resolution.",
    doc: "docs/67-terminal-capture.md",
    exports: ["THEMES", "resolveThemeSpec"],
    tests: ["src/terminal/theme.test.ts"],
  },

  // ── Device chrome ──────────────────────────────────────────────────────
  {
    id: "device-chrome",
    behavior: "Wrap a rendered page in a phone / browser / window bezel (light/dark).",
    doc: "docs/65-device-chrome.md",
    exports: ["wrapInDeviceChrome", "DEVICE_CHROMES", "isDeviceChrome", "CHROME_THEMES", "isChromeTheme"],
    tests: ["src/render/device-chrome.test.ts"],
  },

  // ── Geometry helpers ───────────────────────────────────────────────────
  {
    id: "geometry.box",
    behavior: "Border-box / content-box rects for a captured element.",
    doc: "docs/ai/code-summary.md",
    exports: ["borderBox", "contentBox"],
    tests: ["src/capture/content-box.test.ts"],
  },

  // ── Programmatic recorder ──────────────────────────────────────────────
  {
    id: "recorder.demo",
    behavior: "DemoRecorder — the high-level programmatic capture→animate recorder used by the example scripts.",
    doc: "docs/ai/code-summary.md",
    exports: ["DemoRecorder"],
    tests: ["tests/examples-use-real-pipelines.test.ts"],
  },

  // ── Published bins beyond `domotion` ───────────────────────────────────
  {
    id: "bin.svg-to-video",
    behavior: "Render an animated SVG to MP4/WebM (frame-stepped, ffmpeg-piped) with audio/captions/scale.",
    doc: "docs/ai/code-summary.md",
    verbs: ["svg-to-video"],
    tests: ["src/cli/svg-to-video-core.test.ts"],
  },
  {
    id: "bin.svg-to-image",
    behavior: "Rasterize a still/animated SVG to PNG/JPEG/PDF/WebP/AVIF/TIFF (--at samples a frame).",
    doc: "docs/78-svg-to-image.md",
    verbs: ["svg-to-image"],
    tests: ["src/cli/svg-to-image-core.test.ts"],
  },
  {
    id: "bin.svg-review",
    behavior: "Single-fixture diff-review UI (expected/actual/diff, draggable regions → GitHub-issue markdown).",
    doc: "docs/54-svg-review-tool.md",
    verbs: ["svg-review"],
    tests: ["src/review/compare-pngs.test.ts", "src/review/region-overlay.test.ts", "src/review/server.test.ts"],
  },
  {
    id: "bin.svg-scrubber",
    behavior: "Animated-SVG timeline bench (play/scrub/trim/export-frame) + --review issue reporter (STATEFUL: review mode).",
    doc: "docs/82-svg-scrubber-review-mode.md",
    verbs: ["svg-scrubber"],
    tests: ["src/scrubber/trim.test.ts", "src/scrubber/crop.test.ts", "src/scrubber/ticket.test.ts", "src/scrubber/server.validation.test.ts"],
    transition: "POST /ticket + /export-frame are review-only routes (404 unless --review); the region overlay stays armed across multiple drags.",
  },
];

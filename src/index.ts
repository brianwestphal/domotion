// Public API surface for the `domotion-svg` npm package.
//
// Every export below is intentionally public. Anything not re-exported here is
// internal — consumers should not import from `domotion-svg/dist/*` directly.
// See `docs/api.md` for the canonical list with one-line descriptions.
//
// DM-622: the previous shape included ~14 internal helpers (test utilities,
// scroll executor internals, root-svg attribute helpers, etc.). Those were
// culled to reduce the surface and to make the package version (0.2.0+) honest
// about what's stable. Per-feature barrels (`./capture`, `./render`,
// `./animation`, `./scroll`, `./tree-ops`, `./post-processing`) each define
// their own curated public surface (`./capture` and `./scroll` through their
// `public.ts` subset) — this file is the consumer-facing aggregation of those
// barrels.

// ── Capture ────────────────────────────────────────────────────────────────
// `./capture/index.ts` is the subsystem's internal barrel; `./capture/public.ts`
// is its documented subset (also the `domotion-svg/capture` subpath).
export * from "./capture/public.js";

// ── Render ─────────────────────────────────────────────────────────────────
export * from "./render/index.js";

// ── Animation ──────────────────────────────────────────────────────────────
export * from "./animation/index.js";

// ── Scroll ─────────────────────────────────────────────────────────────────
// `./scroll/public.ts` is the documented subset of the scroll barrel, which
// also carries executor internals (also the `domotion-svg/scroll` subpath).
export * from "./scroll/public.js";

// ── Tree ops ───────────────────────────────────────────────────────────────
export * from "./tree-ops/index.js";

// ── Post-processing ────────────────────────────────────────────────────────
export * from "./post-processing/index.js";

// ── Domotion Studio project model ──────────────────────────────────────────
// The durable, versioned authoring source. Static scenes and recursive layer
// compositions lower onto the existing storyboard/composite render recipes;
// generated SVG/video artifacts remain outputs with recorded provenance.
export * from "./studio/index.js";
export * from "./scrubber/embed.js";

// ── Declarative animate pipeline (DM-1130) ───────────────────────────────────
// The JSON-config-driven animation pipeline that powers `domotion animate`,
// exposed so library callers can run it in-process instead of shelling out to
// the CLI or reimplementing it. `composeAnimateConfig(browser, cfg)` captures +
// composes every frame (anchors, actions, cursor `auto`, vars) into one animated
// SVG; `validateAnimateConfig` parses untrusted JSON into a typed `AnimateConfig`;
// `interpolateConfigVars` resolves `${vars}`. `configDir` (for resolving relative
// `input` / svg-overlay `src` paths) defaults to `process.cwd()`. See `docs/60`.
export {
  composeAnimateConfig,
  // DM-1137 (doc 62 §1): the frames-out variant — returns the assembled
  // `AnimationConfig` (mutate frames, then `generateAnimatedSvg` it) instead of a
  // rendered SVG. `composeAnimateConfig` is `generateAnimatedSvg(await this(…))`.
  composeAnimateFrames,
  // DM-1138 (doc 62 §2): the per-frame `onFrame` hook + its options-object form.
  type OnFrameHook,
  type ComposeAnimateOptions,
  validateAnimateConfig,
  interpolateConfigVars,
  type AnimateConfig,
  // DM-1140 (doc 63 §2): the declarative action runner + its typed union, so
  // imperative callers get the DOM-mutation vocabulary without a JSON config.
  runActions,
  type AnimateAction,
  // DM-1516 (docs/94): force real CSS pseudo-state (:hover / :active / :focus) on
  // selectors via CDP before capture, so the page's OWN interaction styling is
  // painted — the imperative twin of the animate config's per-frame `forceState`.
  applyForcedPseudoStates,
  type ForceState,
} from "./cli/animate.js";

// ── Terminal capture (DM-1225, doc 67) ───────────────────────────────────────
// Turn a recorded terminal session (asciinema v2 .cast) into an animated SVG, or
// into the individual terminal frames so callers can retime / wrap in chrome /
// re-transition before composing. `castToTermFrames` is the frames-out half;
// `castToAnimatedSvg` is `generateAnimatedSvg(await castToTermFrames(…))`. The
// lower-level primitives (parse / emulate / select / render) are re-exported too.
export {
  castToAnimatedSvg,
  castToTermFrames,
  type TermToSvgOptions,
  type TermToSvgResult,
  type TermFramesResult,
} from "./terminal/index.js";
export { parseCast, type ParsedCast, type CastHeader, type CastOutputEvent } from "./terminal/cast.js";
export { TerminalEmulator, gridSignature, type TermCell, type TermGrid } from "./terminal/emulator.js";
export {
  buildFrames,
  gridToHtml,
  type FrameBuildOptions,
  type TermFrame,
  type HtmlRenderOptions,
} from "./terminal/render.js";
export {
  THEMES,
  xterm256ToHex,
  resolveThemeSpec,
  type TerminalTheme,
  type TerminalThemeSpec,
} from "./terminal/theme.js";

// ── Templates (DM-1276, doc 70) ──────────────────────────────────────────────
// Parameterized generators that produce a self-contained SVG by driving the
// existing capture → compose pipeline (templates add NO new rendering code).
// `renderTemplateToSvg(template, params)` validates + renders; `loadTemplate`
// resolves a built-in or a `domotion-template-<name>` npm package; the `Template`
// contract lets third parties author and publish their own.
export {
  type Template,
  type TemplateOutput,
  type TemplateRenderContext,
  isTemplate,
  listBuiltinTemplates,
  getBuiltinTemplate,
  loadTemplate,
  templatePackageName,
  renderTemplateToSvg,
  validateTemplateParams,
  type RenderTemplateOptions,
  templateParamsJsonSchema,
  describeTemplateParams,
  type ParamInfo,
  FORMATS,
  resolveFormat,
  applyFormatSize,
  safeAreaPadding,
  formatScaleFactor,
  safeAreaGuideSvg,
  ADAPTIVE_REFERENCE,
  formatNames,
  type FormatPreset,
  type ResolvedFormat,
  type SafeInset,
  type EdgeInset,
  brandSchema,
  loadBrand,
  brandParams,
  brandSeriesColors,
  brandBackground,
  brandCustomProperties,
  brandRootCss,
  applyBrandDefaults,
  type Brand,
  lowerThirdTemplate,
  type LowerThirdParams,
  deviceMockupTemplate,
  type DeviceMockupParams,
  backgroundLoopTemplate,
  type BackgroundLoopParams,
  type BackgroundVariant,
  kineticTextTemplate,
  type KineticTextParams,
  type KineticVariant,
  chartTemplate,
  type ChartParams,
  type ChartType,
  chatTemplate,
  type ChatParams,
  type ChatMessage,
  subscribeTemplate,
  type SubscribeParams,
  titleCardTemplate,
  type TitleCardParams,
  quoteTemplate,
  type QuoteParams,
  captionTemplate,
  type CaptionParams,
  ctaTemplate,
  type CtaParams,
  counterTemplate,
  type CounterParams,
  statTemplate,
  type StatParams,
  compareTemplate,
  type CompareParams,
} from "./templates/index.js";

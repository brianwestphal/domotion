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
// their own curated public surface — this file is the consumer-facing
// aggregation of those barrels.

// ── Capture ────────────────────────────────────────────────────────────────
// Note: `./capture/index.ts` also re-exports several internal helpers used
// across the package (warning buffer, webfont tracker, embed pipeline). We
// import the curated subset by name rather than `export *` to keep the
// public surface honest. (DM-622 — leaving an audit of `capture/index.ts` as
// follow-up; for now `src/index.ts` is the source of truth.)
export {
  captureElementTree,
  captureElementTreeWithWarnings,
  DemoRecorder,
  launchChromium,
} from "./capture/index.js";
export type { CaptureOptions } from "./capture/index.js";
export {
  getLastCaptureWarnings,
  logCaptureWarnings,
} from "./capture/warnings.js";
export { embedRemoteImages } from "./capture/embed.js";
export type { CapturedElement, CaptureWarning } from "./capture/types.js";
// DM-1133: the padding-inset content box of a selector on a live page — where
// text actually starts inside a padded field, for imperative typing-overlay
// callers (and the building block for DM-1132's overlay resolver).
// DM-1139 (doc 63 §1): `borderBox` is the symmetric BORDER-box sibling, and
// `resolveCursorTarget` is the border-box-center sugar the CLI cursor uses — so
// imperative cursor choreography matches the declarative `cursor` resolution.
export { contentBox, boxAnchorPoint, borderBox, resolveCursorTarget } from "./capture/content-box.js";
export type { ContentBox, ContentBoxOptions, BoxAnchor, BorderBox, BorderBoxOptions } from "./capture/content-box.js";

// ── Render ─────────────────────────────────────────────────────────────────
export * from "./render/index.js";

// ── Animation ──────────────────────────────────────────────────────────────
export * from "./animation/index.js";

// ── Scroll ─────────────────────────────────────────────────────────────────
// `./scroll/index.ts` also re-exports internal executor helpers
// (`axisOfScroll`, `resolveAbsoluteTarget`, `resolveScrollAction`, plus
// page-state types). We import the curated subset by name to keep them
// internal-only.
export {
  parseScrollPattern,
  ScrollPatternError,
  executeScrollPattern,
  ScrollExecutionError,
  composeScrollSvg,
} from "./scroll/index.js";
export type {
  ScrollPattern,
  ScrollPatternSegment,
  ScrollPatternAction,
  ScrollAxis,
  BracketedSegment,
  FlatSegment,
  ScrollAction,
  PauseAction,
  ScrollTarget,
  DeltaTarget,
  AbsoluteTarget,
  Anchor,
  NamedAnchor,
  SelectorAnchor,
  SignedLength,
  Length,
  Easing,
  UntilClause,
  PositionUntil,
  CountUntil,
  ScrollExecutorOptions,
  ScrollComposerOptions,
} from "./scroll/index.js";

// ── Tree ops ───────────────────────────────────────────────────────────────
export * from "./tree-ops/index.js";

// ── Post-processing ────────────────────────────────────────────────────────
export * from "./post-processing/index.js";

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
export { buildFrames, gridToHtml, type FrameBuildOptions, type TermFrame, type HtmlRenderOptions } from "./terminal/render.js";
export { THEMES, xterm256ToHex, resolveThemeSpec, type TerminalTheme, type TerminalThemeSpec } from "./terminal/theme.js";

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
} from "./templates/index.js";

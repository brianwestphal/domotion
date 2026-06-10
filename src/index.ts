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
export { contentBox, boxAnchorPoint } from "./capture/content-box.js";
export type { ContentBox, ContentBoxOptions, BoxAnchor } from "./capture/content-box.js";

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
  validateAnimateConfig,
  interpolateConfigVars,
  type AnimateConfig,
} from "./cli/animate.js";

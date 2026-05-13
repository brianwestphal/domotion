/**
 * Scroll feature — pattern grammar parser, Playwright-side executor, and
 * animated-SVG composer. Three files; tight coupling between them, no other
 * consumers inside the package. See DM-604 / DM-605..611 for the design.
 *
 * Public surface re-exported from the package barrel via `src/index.ts`.
 */

export { parseScrollPattern, ScrollPatternError } from "./pattern.js";
export type {
  Pattern, Segment, BracketedSegment, FlatSegment,
  Action, ScrollAction, PauseAction,
  ScrollTarget, DeltaTarget, AbsoluteTarget,
  Anchor, NamedAnchor, SelectorAnchor,
  SignedLength, Length, Easing,
  UntilClause, PositionUntil, CountUntil,
} from "./pattern.js";

export {
  executeScrollPattern,
  ScrollExecutionError,
  axisOfScroll,
  resolveAbsoluteTarget,
  resolveScrollAction,
} from "./executor.js";
export type {
  ScrollExecutorOptions,
  ScrollSegmentCapture,
  Axis,
  PageStateSnapshot,
  SelectorBbox,
  PageQuery,
} from "./executor.js";

export { composeScrollSvg } from "./composer.js";
export type { ScrollComposerOptions } from "./composer.js";

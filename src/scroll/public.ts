/**
 * The documented public scroll surface.
 *
 * `./index.ts` also re-exports executor internals (`axisOfScroll`,
 * `resolveAbsoluteTarget`, `resolveScrollAction`, `assertScrollFrameOwnership`,
 * page-state types) that the CLI and composer share. This file is exactly the
 * subset `docs/api.md` documents, so the package root (`export *` from here)
 * and the `domotion-svg/scroll` subpath expose the same curated surface.
 * Adding a name here makes it public: document it in `docs/api.md` in the same
 * change.
 */

export {
  parseScrollPattern,
  ScrollPatternError,
  executeScrollPattern,
  ScrollExecutionError,
  composeScrollSvg,
} from "./index.js";
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
} from "./index.js";

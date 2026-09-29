/**
 * The documented public capture surface.
 *
 * `./index.ts` is the capture subsystem's internal barrel: besides the entry
 * points below it re-exports helpers the rest of the package shares (webfont
 * tracker, rasterization passes, baseline calibration, font-face parsers,
 * animated-image types). This file is exactly the subset `docs/api.md`
 * documents, so the package root (`export *` from here) and the
 * `domotion-svg/capture` subpath expose the same curated surface without a
 * hand-maintained list in `src/index.ts`. Adding a name here makes it public:
 * document it in `docs/api.md` in the same change.
 */

export {
  captureElementTree,
  captureElementTreeEnvelope,
  captureElementTreeSelfContained,
  captureElementTreeWithDebug,
  captureElementTreeWithWarnings,
  DemoRecorder,
  launchChromium,
  injectBrandVariables,
  installCaptureRafClock,
} from "./index.js";
export type {
  CaptureOptions,
  CaptureElementTreeOptions,
  CaptureElementTreeDebugResult,
  CaptureElementTreeResult,
} from "./index.js";
export { assembleCaptureDebugBundle } from "./debug-bundle.js";
export type { AssembleCaptureDebugBundleOptions, CaptureDebugArtifacts, CaptureDebugBundle } from "./debug-bundle.js";
export { reverifyAnimationsAtFrame, seekAnimationsToFrame } from "./animation-frame.js";
export type {
  SeekAnimationsToFrameOptions,
  StableAnimationDocumentState,
  StableAnimationFrameState,
  StableProgressTimelineState,
} from "./animation-frame.js";
export { reverifyCaptureRafClock, sampleCaptureRafClock } from "./raf-clock.js";
export type { CaptureRafClockHandle, CaptureRafTargetState, StableCaptureRafState } from "./raf-clock.js";
export type {
  ReplacedMediaDimensions,
  ReplacedMediaFrameOwner,
  ReplacedMediaKind,
  StableReplacedMediaFrameState,
} from "./replaced-media-frame.js";
export { getLastCaptureWarnings, logCaptureWarnings } from "./warnings.js";
export { embedRemoteImages } from "./embed.js";
export type {
  CapturedElement,
  CapturedFrameAccess,
  CapturedFrameScrollOwner,
  CapturedFrameScrollRecord,
  CapturedFrameScrollState,
  CapturedSessionGenericFamilies,
  CapturedTreeEnvelope,
  CapturedTreeInput,
  CaptureWarning,
} from "./types.js";
export { createCapturedTreeEnvelope, promoteCapturedSubtree } from "./tree-envelope.js";
// DM-1133: the padding-inset content box of a selector on a live page — where
// text actually starts inside a padded field, for imperative typing-overlay
// callers (and the building block for DM-1132's overlay resolver).
// DM-1139 (doc 63 §1): `borderBox` is the symmetric BORDER-box sibling, and
// `resolveCursorTarget` is the border-box-center sugar the CLI cursor uses — so
// imperative cursor choreography matches the declarative `cursor` resolution.
export { contentBox, boxAnchorPoint, borderBox, resolveCursorTarget } from "./content-box.js";
export type { ContentBox, ContentBoxOptions, BoxAnchor, BorderBox, BorderBoxOptions } from "./content-box.js";

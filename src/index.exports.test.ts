import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, it, expect } from "vitest";
import * as pkg from "./index.js";
import * as animation from "./animation/index.js";
import * as postProcessing from "./post-processing/index.js";
import * as render from "./render/index.js";
import * as studio from "./studio/index.js";
import * as templates from "./templates/index.js";
import * as treeOps from "./tree-ops/index.js";

/**
 * DM-1058: guard the published `domotion-svg` value-export surface against
 * drift. `src/index.ts` is the public barrel and `docs/api.md` is its canonical
 * description — when they fall out of sync, consumers get broken imports (the
 * doc-01 `domotion-svg/dom-to-svg` example bug) or undocumented exports (the
 * render/magic-move symbols this ticket added). This test pins the exact set of
 * runtime (value) exports, so adding/removing/renaming one fails here and forces
 * updating BOTH this list and the api.md table in the same change.
 *
 * Types can't be seen at runtime, so this list only covers value exports. The
 * "every root export has a docs/api.md row" test below closes that gap: it
 * enumerates the full root surface (values AND type-only exports) with the
 * TypeScript checker and requires each name in the first (Export) cell of a
 * docs/api.md table row.
 */

// Keep sorted. Every entry must have a row in docs/api.md.
const EXPECTED_VALUE_EXPORTS = [
  "ADAPTIVE_REFERENCE",
  "CHROME_THEMES",
  "CURSOR_CATEGORIES",
  "CURSOR_GLYPHS",
  "DEVICE_CHROMES",
  "DemoRecorder",
  "EASING_PRESETS",
  "FORMATS",
  "RENDER_TEXT_MODES",
  "STUDIO_TIMELINE_KINDS",
  "STUDIO_VIDEO_REVIEW_DIMENSIONS",
  "ScrollExecutionError",
  "ScrollPatternError",
  "StudioAgentToolError",
  "StudioAnnotationError",
  "StudioAuthoringError",
  "StudioHealingError",
  "StudioInteractionError",
  "StudioInteractionObservationError",
  "StudioInteractiveSceneError",
  "StudioProjectCompileError",
  "StudioProjectValidationError",
  "StudioRecordingError",
  "StudioTimelineError",
  "StudioTreatmentError",
  "StudioVideoReviewError",
  "THEMES",
  "TerminalEmulator",
  "acquireGlyphHelper",
  "acquireIcuCompanion",
  "addressableLength",
  "alignLineGlyphs",
  "annotateAnimatedProperties",
  "applyBrandDefaults",
  "applyForcedPseudoStates",
  "applyFormatSize",
  "applyStudioAnnotationCommand",
  "applyStudioAuthoringCommand",
  "applyStudioTimelineCommand",
  "applyStudioTreatments",
  "assembleCaptureDebugBundle",
  "assertNoFillBoxInClipOrMask",
  "backgroundLoopTemplate",
  "borderBox",
  "boxAnchorPoint",
  "brandBackground",
  "brandCustomProperties",
  "brandParams",
  "brandRootCss",
  "brandSchema",
  "brandSeriesColors",
  "buildFrames",
  "buildMagicMove",
  "buildStudioAgentToolRequestJsonSchema",
  "buildStudioCursorChoreography",
  "buildStudioProjectJsonSchema",
  "buildStudioTimeline",
  "captionTemplate",
  "captureElementTree",
  "captureElementTreeEnvelope",
  "captureElementTreeSelfContained",
  "captureElementTreeWithDebug",
  "captureElementTreeWithWarnings",
  "castToAnimatedSvg",
  "castToTermFrames",
  "chartTemplate",
  "chatTemplate",
  "clearEmbeddedFonts",
  "clearGlyphDefs",
  "clearTextEngineFonts",
  "clearWebfonts",
  "commitStudioAuthoringRevision",
  "compareTemplate",
  "compileStudioInteractiveProject",
  "compileStudioProject",
  "compileStudioProjectFile",
  "compileStudioSemanticTracks",
  "composeAnimateConfig",
  "composeAnimateFrames",
  "composeAnimatedLayers",
  "composeCompressedRun",
  "composeScrollSvg",
  "compressEmbeddedFontsToWoff2",
  "contentBox",
  "counterTemplate",
  "createCapturedTreeEnvelope",
  "createTextEngineSession",
  "ctaTemplate",
  "cullElementsOutsideViewBox",
  "cursorAtPoint",
  "cursorGlyphSvg",
  "cursorOverlayMarkup",
  "describeTemplateParams",
  "deviceMockupTemplate",
  "diffTrees",
  "easingPresetNames",
  "elementTreeToSvg",
  "elementTreeToSvgInner",
  "embedRemoteImages",
  "executeScrollPattern",
  "findAddressedElement",
  "findFillBoxInClipOrMask",
  "formatNames",
  "formatScaleFactor",
  "generateAnimatedSvg",
  "getBuiltinTemplate",
  "getEmbeddedFontFaceCss",
  "getGlyphDefs",
  "getLastCaptureWarnings",
  "getRenderTextMode",
  "gridSignature",
  "gridToHtml",
  "gzipSvg",
  "hoistDuplicateImagePayloads",
  "importStoryboardConfig",
  "importStudioInteractionRecording",
  "importSvgReviewRegionsAnnotation",
  "importSvgScrubberReviewAnnotation",
  "injectBrandVariables",
  "inspectStudioCursorTargets",
  "inspectStudioHealingPage",
  "installCaptureRafClock",
  "interpolateConfigVars",
  "isChromeTheme",
  "isDeviceChrome",
  "isRenderTextMode",
  "isScrubberEmbedCommand",
  "isScrubberEmbedEvent",
  "isTemplate",
  "kineticTextTemplate",
  "launchChromium",
  "listBuiltinTemplates",
  "loadBrand",
  "loadStudioProject",
  "loadTemplate",
  "logCaptureWarnings",
  "lowerThirdTemplate",
  "motionPresetNames",
  "moveStudioTimelineItems",
  "namespaceEmbeddedAnimatedSvg",
  "normalizeScrubberEmbedViewState",
  "normalizeStudioAnnotationTarget",
  "normalizeTransition",
  "observeStudioInteraction",
  "observeStudioSemanticStep",
  "offsetEmbeddedAnimatedSvgTimeline",
  "optimizeSvg",
  "parseCast",
  "parseScrollPattern",
  "parseStudioProjectJson",
  "parseSvgReviewRegions",
  "persistStudioRecordingEvidence",
  "planStudioCursorChoreography",
  "promoteCapturedSubtree",
  "quoteTemplate",
  "recordStudioInteractions",
  "registerTextEngineLocalFontAlias",
  "registerTextEngineWebfont",
  "registerWebfont",
  "renderAndReviewStudioVideo",
  "renderTemplateToSvg",
  "resizeEmbeddedImages",
  "resizeStudioTimelineItems",
  "resolveCaretPoint",
  "resolveCursorScript",
  "resolveCursorTarget",
  "resolveEasingPreset",
  "resolveFormat",
  "resolveMotionPreset",
  "resolveOverlays",
  "resolveRangeRects",
  "resolveStudioSemanticTarget",
  "resolveStudioTreatmentPlan",
  "resolveTextTrack",
  "resolveThemeSpec",
  "resumeStudioHealingLoop",
  "resumeStudioVideoReview",
  "reverifyAnimationsAtFrame",
  "reverifyCaptureRafClock",
  "runActions",
  "runStudioAgentTool",
  "runStudioHealingLoop",
  "runStudioSemanticPlan",
  "runStudioSemanticStep",
  "runStudioSemanticTracks",
  "safeAreaGuideSvg",
  "safeAreaPadding",
  "sampleCaptureRafClock",
  "saveStudioProject",
  "seekAnimationsToFrame",
  "serializeStudioProject",
  "setRenderTextMode",
  "statTemplate",
  "studioAgentProjectDigest",
  "studioAgentToolArtifactSchema",
  "studioAgentToolRequestSchema",
  "studioAgentToolResponseSchema",
  "studioAnnotationCommandSchema",
  "studioAnnotationRegionSchema",
  "studioAnnotationScopeSchema",
  "studioAnnotationTargetSchema",
  "studioAnnotationTimeSchema",
  "studioArtifactSchema",
  "studioCompositionSchema",
  "studioContentRevisionId",
  "studioIdSchema",
  "studioInteractionRecordingSchema",
  "studioLayerSchema",
  "studioNarrativeSchema",
  "studioProjectJsonSchemaText",
  "studioProjectSchema",
  "studioProjectToStoryboardConfig",
  "studioRecordedEventSchema",
  "studioRecordedTargetSchema",
  "studioReviewAnnotationSchema",
  "studioReviewAuthorSchema",
  "studioReviewHistorySchema",
  "studioReviewRevisionSchema",
  "studioSceneDurationMs",
  "studioSceneRenderSchema",
  "studioSceneSchema",
  "studioScriptHookSchema",
  "studioSemanticEventSchema",
  "studioSemanticTargetSchema",
  "studioSemanticTrackSchema",
  "studioTimelineCommandSchema",
  "studioTimelineTimingChangeSchema",
  "studioTreatmentLayerPrimitiveSchema",
  "studioTreatmentMaskPrimitiveSchema",
  "studioTreatmentOverlayPrimitiveSchema",
  "studioTreatmentSchema",
  "studioTreatmentTimingSchema",
  "studioTreatmentTransformPrimitiveSchema",
  "studioTreatmentsSchema",
  "studioVideoReviewFindingSchema",
  "studioVideoReviewReportSchema",
  "subscribeTemplate",
  "svgScrubberReviewTicketSchema",
  "templatePackageName",
  "templateParamsJsonSchema",
  "textTrackMarkup",
  "titleCardTemplate",
  "transitionSchema",
  "transitionTypeSchema",
  "validateAnimateConfig",
  "validateStudioProject",
  "validateTemplateParams",
  "withRenderTextMode",
  "withTextEngineDocument",
  "wrapInDeviceChrome",
  "wrapSvg",
  "xterm256ToHex",
] as const;

describe("public barrel export surface (DM-1058)", () => {
  it("exports exactly the documented set of value symbols (sorted)", () => {
    const actual = Object.keys(pkg)
      .filter(
        (k) =>
          typeof (pkg as Record<string, unknown>)[k] === "function" ||
          typeof (pkg as Record<string, unknown>)[k] === "object",
      )
      .sort();
    expect(actual).toEqual([...EXPECTED_VALUE_EXPORTS]);
  });

  it("the doc-01 warning-system example imports resolve from the package root", () => {
    // Regression guard for the broken `domotion-svg/dom-to-svg` example (DM-1056).
    expect(typeof pkg.captureElementTree).toBe("function");
    expect(typeof pkg.getLastCaptureWarnings).toBe("function");
    expect(typeof pkg.logCaptureWarnings).toBe("function");
  });

  // Every curated subpath in the package's `exports` map, with the exact
  // runtime export set of the barrel it resolves to. Everything reachable
  // through a subpath must also be a documented root export — and the very
  // same binding, since the root re-exports the same compiled module — so a
  // subpath narrows the surface and never widens it. Adding a subpath means
  // adding its row here, its row in the docs/api.md entry-point table, and its
  // import in scripts/pack-install-smoke.mjs.
  const SUBPATHS: ReadonlyArray<readonly [string, Record<string, unknown>, readonly string[]]> = [
    [
      "domotion-svg/render",
      render,
      [
        "CHROME_THEMES",
        "DEVICE_CHROMES",
        "RENDER_TEXT_MODES",
        "acquireGlyphHelper",
        "acquireIcuCompanion",
        "clearEmbeddedFonts",
        "clearGlyphDefs",
        "clearTextEngineFonts",
        "clearWebfonts",
        "createCapturedTreeEnvelope",
        "createTextEngineSession",
        "elementTreeToSvg",
        "elementTreeToSvgInner",
        "getEmbeddedFontFaceCss",
        "getGlyphDefs",
        "getRenderTextMode",
        "isChromeTheme",
        "isDeviceChrome",
        "isRenderTextMode",
        "promoteCapturedSubtree",
        "registerTextEngineLocalFontAlias",
        "registerTextEngineWebfont",
        "registerWebfont",
        "setRenderTextMode",
        "withRenderTextMode",
        "withTextEngineDocument",
        "wrapInDeviceChrome",
        "wrapSvg",
      ],
    ],
    [
      "domotion-svg/animation",
      animation,
      [
        "CARET_BLINK_MS",
        "CURSOR_CATEGORIES",
        "CURSOR_GLYPHS",
        "DEFAULT_SELECTION_COLOR",
        "EASING_PRESETS",
        "addressableLength",
        "alignLineGlyphs",
        "buildMagicMove",
        "composeAnimatedLayers",
        "composeCompressedRun",
        "cursorAtPoint",
        "cursorGlyphSvg",
        "cursorOverlayMarkup",
        "easingPresetNames",
        "findAddressedElement",
        "generateAnimatedSvg",
        "motionPresetNames",
        "namespaceEmbeddedAnimatedSvg",
        "normalizeTransition",
        "offsetEmbeddedAnimatedSvgTimeline",
        "resolveCaretPoint",
        "resolveCursorScript",
        "resolveEasingPreset",
        "resolveMotionPreset",
        "resolveOverlays",
        "resolveRangeRects",
        "resolveTextTrack",
        "textTrackMarkup",
        "transitionSchema",
        "transitionTypeSchema",
      ],
    ],
    [
      "domotion-svg/tree-ops",
      treeOps,
      ["annotateAnimatedProperties", "cullElementsOutsideViewBox", "diffTrees", "resizeEmbeddedImages"],
    ],
    [
      "domotion-svg/templates",
      templates,
      [
        "ADAPTIVE_REFERENCE",
        "FORMATS",
        "applyBrandDefaults",
        "applyFormatSize",
        "backgroundLoopTemplate",
        "brandBackground",
        "brandCustomProperties",
        "brandParams",
        "brandRootCss",
        "brandSchema",
        "brandSeriesColors",
        "captionTemplate",
        "chartTemplate",
        "chatTemplate",
        "compareTemplate",
        "counterTemplate",
        "ctaTemplate",
        "describeTemplateParams",
        "deviceMockupTemplate",
        "formatNames",
        "formatScaleFactor",
        "getBuiltinTemplate",
        "isTemplate",
        "kineticTextTemplate",
        "listBuiltinTemplates",
        "loadBrand",
        "loadTemplate",
        "lowerThirdTemplate",
        "quoteTemplate",
        "renderTemplateToSvg",
        "resolveFormat",
        "safeAreaGuideSvg",
        "safeAreaPadding",
        "statTemplate",
        "subscribeTemplate",
        "templatePackageName",
        "templateParamsJsonSchema",
        "titleCardTemplate",
        "validateTemplateParams",
      ],
    ],
    [
      "domotion-svg/studio",
      studio,
      [
        "STUDIO_AGENT_TOOL_VERSION",
        "STUDIO_INTERACTION_RECORDING_FORMAT",
        "STUDIO_INTERACTION_RECORDING_VERSION",
        "STUDIO_PROJECT_FORMAT",
        "STUDIO_PROJECT_SCHEMA_ID",
        "STUDIO_PROJECT_VERSION",
        "STUDIO_REDACTED_VALUE",
        "STUDIO_TIMELINE_KINDS",
        "STUDIO_VIDEO_REVIEW_DIMENSIONS",
        "StudioAgentToolError",
        "StudioAnnotationError",
        "StudioAuthoringError",
        "StudioHealingError",
        "StudioInteractionError",
        "StudioInteractionObservationError",
        "StudioInteractiveSceneError",
        "StudioProjectCompileError",
        "StudioProjectValidationError",
        "StudioRecordingError",
        "StudioTimelineError",
        "StudioTreatmentError",
        "StudioVideoReviewError",
        "applyStudioAnnotationCommand",
        "applyStudioAuthoringCommand",
        "applyStudioTimelineCommand",
        "applyStudioTreatments",
        "buildStudioAgentToolRequestJsonSchema",
        "buildStudioCursorChoreography",
        "buildStudioProjectJsonSchema",
        "buildStudioTimeline",
        "commitStudioAuthoringRevision",
        "compileStudioInteractiveProject",
        "compileStudioProject",
        "compileStudioProjectFile",
        "compileStudioSemanticTracks",
        "importStoryboardConfig",
        "importStudioInteractionRecording",
        "importSvgReviewRegionsAnnotation",
        "importSvgScrubberReviewAnnotation",
        "inspectStudioCursorTargets",
        "inspectStudioHealingPage",
        "loadStudioProject",
        "moveStudioTimelineItems",
        "normalizeStudioAnnotationTarget",
        "observeStudioInteraction",
        "observeStudioSemanticStep",
        "parseStudioProjectJson",
        "parseSvgReviewRegions",
        "persistStudioRecordingEvidence",
        "planStudioCursorChoreography",
        "recordStudioInteractions",
        "renderAndReviewStudioVideo",
        "resizeStudioTimelineItems",
        "resolveStudioSemanticTarget",
        "resolveStudioTreatmentPlan",
        "resumeStudioHealingLoop",
        "resumeStudioVideoReview",
        "runStudioAgentTool",
        "runStudioHealingLoop",
        "runStudioSemanticPlan",
        "runStudioSemanticStep",
        "runStudioSemanticTracks",
        "saveStudioProject",
        "serializeStudioProject",
        "studioAgentProjectDigest",
        "studioAgentToolArtifactSchema",
        "studioAgentToolRequestSchema",
        "studioAgentToolResponseSchema",
        "studioAnnotationCommandSchema",
        "studioAnnotationRegionSchema",
        "studioAnnotationScopeSchema",
        "studioAnnotationTargetSchema",
        "studioAnnotationTimeSchema",
        "studioArtifactSchema",
        "studioCompositionSchema",
        "studioContentRevisionId",
        "studioIdSchema",
        "studioInteractionRecordingSchema",
        "studioLayerSchema",
        "studioNarrativeSchema",
        "studioProjectJsonSchemaText",
        "studioProjectSchema",
        "studioProjectToStoryboardConfig",
        "studioRecordedEventSchema",
        "studioRecordedTargetSchema",
        "studioReviewAnnotationSchema",
        "studioReviewAuthorSchema",
        "studioReviewHistorySchema",
        "studioReviewRevisionSchema",
        "studioSceneDurationMs",
        "studioSceneRenderSchema",
        "studioSceneSchema",
        "studioScriptHookSchema",
        "studioSemanticEventSchema",
        "studioSemanticTargetSchema",
        "studioSemanticTrackSchema",
        "studioTimelineCommandSchema",
        "studioTimelineTimingChangeSchema",
        "studioTreatmentLayerPrimitiveSchema",
        "studioTreatmentMaskPrimitiveSchema",
        "studioTreatmentOverlayPrimitiveSchema",
        "studioTreatmentSchema",
        "studioTreatmentTimingSchema",
        "studioTreatmentTransformPrimitiveSchema",
        "studioTreatmentsSchema",
        "studioVideoReviewFindingSchema",
        "studioVideoReviewReportSchema",
        "svgScrubberReviewTicketSchema",
        "validateStudioProject",
      ],
    ],
    [
      "domotion-svg/post-processing",
      postProcessing,
      [
        "assertNoFillBoxInClipOrMask",
        "compressEmbeddedFontsToWoff2",
        "findFillBoxInClipOrMask",
        "gzipSvg",
        "hoistDuplicateImagePayloads",
        "optimizeSvg",
      ],
    ],
  ];

  it.each(SUBPATHS)("the %s subpath export is a strict subset of the root surface", (_name, mod, expected) => {
    const subpath = Object.keys(mod).sort();
    expect(subpath).toEqual([...expected]);
    for (const name of subpath) {
      expect(name in pkg).toBe(true);
      expect((pkg as Record<string, unknown>)[name]).toBe(mod[name]);
    }
  });

  it("every root export, value or type, has a row in docs/api.md", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const names = rootExportNames(repoRoot);
    // The checker really enumerated the surface, including type-only exports
    // that `Object.keys(pkg)` can never see.
    expect(names).toEqual(expect.arrayContaining([...EXPECTED_VALUE_EXPORTS, "CapturedElement", "Template"]));
    expect(names.length).toBeGreaterThan(EXPECTED_VALUE_EXPORTS.length);

    const documented = documentedExportNames(readFileSync(join(repoRoot, "docs/api.md"), "utf-8"));
    expect(names.filter((name) => !documented.has(name))).toEqual([]);
  });
});

/**
 * Every name `src/index.ts` exports, values and type-only exports alike, as the
 * TypeScript checker resolves them through the `export *` barrels.
 */
function rootExportNames(repoRoot: string): string[] {
  const configPath = join(repoRoot, "tsconfig.json");
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
  if (parsed == null) throw new Error(`could not parse ${configPath}`);
  const entry = join(repoRoot, "src/index.ts");
  const program = ts.createProgram([entry], { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  const moduleSymbol = source == null ? undefined : checker.getSymbolAtLocation(source);
  if (moduleSymbol == null) throw new Error("could not resolve the src/index.ts module symbol");
  return checker
    .getExportsOfModule(moduleSymbol)
    .map((symbol) => symbol.getName())
    .sort();
}

/**
 * The names docs/api.md documents: every backticked span in the first (Export)
 * cell of a table row. A mention in prose or in another row's description does
 * not count as a row.
 */
function documentedExportNames(markdown: string): Set<string> {
  const names = new Set<string>();
  for (const line of markdown.split("\n")) {
    const firstCell = /^\|([^|]*)\|/.exec(line);
    if (firstCell == null) continue;
    for (const span of firstCell[1].matchAll(/`([^`]+)`/g)) names.add(span[1].trim());
  }
  return names;
}

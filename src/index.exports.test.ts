import { describe, it, expect } from "vitest";
import * as pkg from "./index.js";

/**
 * DM-1058: guard the published `domotion-svg` value-export surface against
 * drift. `src/index.ts` is the public barrel and `docs/api.md` is its canonical
 * description — when they fall out of sync, consumers get broken imports (the
 * doc-01 `domotion-svg/dom-to-svg` example bug) or undocumented exports (the
 * render/magic-move symbols this ticket added). This test pins the exact set of
 * runtime (value) exports, so adding/removing/renaming one fails here and forces
 * updating BOTH this list and the api.md table in the same change.
 *
 * Types can't be checked at runtime, so this only covers value exports; the
 * api.md type rows are reviewed by hand alongside this list.
 */

// Keep sorted. Every entry must have a row in docs/api.md.
const EXPECTED_VALUE_EXPORTS = [
  "CHROME_THEMES",
  "CURSOR_CATEGORIES",
  "CURSOR_GLYPHS",
  "DEVICE_CHROMES",
  "DemoRecorder",
  "EASING_PRESETS",
  "FORMATS",
  "ScrollExecutionError",
  "ScrollPatternError",
  "THEMES",
  "TerminalEmulator",
  "acquireGlyphHelper",
  "applyBrandDefaults",
  "applyFormatSize",
  "assertNoFillBoxInClipOrMask",
  "backgroundLoopTemplate",
  "borderBox",
  "boxAnchorPoint",
  "brandBackground",
  "brandParams",
  "brandSchema",
  "brandSeriesColors",
  "buildFrames",
  "buildMagicMove",
  "captionTemplate",
  "captureElementTree",
  "captureElementTreeWithWarnings",
  "castToAnimatedSvg",
  "castToTermFrames",
  "chartTemplate",
  "chatTemplate",
  "clearEmbeddedFonts",
  "clearGlyphDefs",
  "clearWebfonts",
  "compareTemplate",
  "composeAnimateConfig",
  "composeAnimateFrames",
  "composeAnimatedLayers",
  "composeScrollSvg",
  "contentBox",
  "counterTemplate",
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
  "findFillBoxInClipOrMask",
  "formatNames",
  "generateAnimatedSvg",
  "getBuiltinTemplate",
  "getEmbeddedFontFaceCss",
  "getGlyphDefs",
  "getLastCaptureWarnings",
  "getRenderTextMode",
  "gridSignature",
  "gridToHtml",
  "gzipSvg",
  "interpolateConfigVars",
  "isChromeTheme",
  "isDeviceChrome",
  "isTemplate",
  "kineticTextTemplate",
  "launchChromium",
  "listBuiltinTemplates",
  "loadBrand",
  "loadTemplate",
  "logCaptureWarnings",
  "lowerThirdTemplate",
  "motionPresetNames",
  "namespaceEmbeddedAnimatedSvg",
  "offsetEmbeddedAnimatedSvgTimeline",
  "optimizeSvg",
  "parseCast",
  "parseScrollPattern",
  "quoteTemplate",
  "registerWebfont",
  "renderTemplateToSvg",
  "resizeEmbeddedImages",
  "resolveCursorScript",
  "resolveCursorTarget",
  "resolveEasingPreset",
  "resolveFormat",
  "resolveMotionPreset",
  "resolveOverlays",
  "resolveThemeSpec",
  "runActions",
  "safeAreaPadding",
  "setRenderTextMode",
  "statTemplate",
  "subscribeTemplate",
  "templatePackageName",
  "templateParamsJsonSchema",
  "titleCardTemplate",
  "validateAnimateConfig",
  "validateTemplateParams",
  "withRenderTextMode",
  "wrapInDeviceChrome",
  "wrapSvg",
  "xterm256ToHex",
] as const;

describe("public barrel export surface (DM-1058)", () => {
  it("exports exactly the documented set of value symbols (sorted)", () => {
    const actual = Object.keys(pkg)
      .filter((k) => typeof (pkg as Record<string, unknown>)[k] === "function" || typeof (pkg as Record<string, unknown>)[k] === "object")
      .sort();
    expect(actual).toEqual([...EXPECTED_VALUE_EXPORTS]);
  });

  it("the doc-01 warning-system example imports resolve from the package root", () => {
    // Regression guard for the broken `domotion-svg/dom-to-svg` example (DM-1056).
    expect(typeof pkg.captureElementTree).toBe("function");
    expect(typeof pkg.getLastCaptureWarnings).toBe("function");
    expect(typeof pkg.logCaptureWarnings).toBe("function");
  });
});

/**
 * Source-owned inputs for the independent SFNS terminal-mask evidence arms.
 *
 * This manifest declares requests and coordinate starts only. It deliberately
 * does not contain shaped advances, derived positions, packed phases, scaler
 * records, metrics, or mask bytes: proposal and validation must derive those
 * facts independently from their own execution.
 */
import { createHash } from "node:crypto";

export const SFNS_TERMINAL_MASK_MANIFEST_ABI =
  "domotion-sfns-terminal-mask-manifest-v1";

export const SFNS_TERMINAL_MASK_SCENARIO_IDS = [
  "zoom-2",
  "transform-scale-2",
  "zoom-2-transform-half",
  "optical-sizing-none",
  "opsz-26-mutation",
] as const;
export type SfnsTerminalMaskScenarioId =
  typeof SFNS_TERMINAL_MASK_SCENARIO_IDS[number];

export const SFNS_TERMINAL_MASK_CONTROL_IDS = [
  "subpixel-phase",
  "anti-aliasing",
  "hinting",
  "device-matrix",
  "optical-size",
  "surface-mask-format",
] as const;
export type SfnsTerminalMaskControlId =
  typeof SFNS_TERMINAL_MASK_CONTROL_IDS[number];

export type SfnsTerminalMaskCaseId = SfnsTerminalMaskScenarioId
  | `control-${SfnsTerminalMaskControlId}`;

export interface SfnsTerminalMaskCaseRequest {
  fontSize: number;
  axes: { wdth: number; opsz: number; GRAD: number; wght: number };
  font: {
    scaleX: number;
    skewX: number;
    subpixel: boolean;
    linearMetrics: boolean;
    embeddedBitmaps: boolean;
    edging: "alias" | "aa" | "subpixel";
    hinting: "none" | "slight" | "normal" | "full";
  };
  paint: { color: number; style: "fill" };
  surface: {
    flags: number;
    pixelGeometry: "unknown" | "rgb-h" | "bgr-h" | "rgb-v" | "bgr-v";
    textContrast: number;
    textGamma: number;
  };
  scalerContextFlags: number;
  run: {
    sourceStart: readonly [number, number];
    deviceStart: readonly [number, number];
    deviceBaseline: number;
    liveDeviceMatrix: readonly [
      number, number, number,
      number, number, number,
      number, number, number,
    ];
  };
  browserCss: {
    anchorLeft: number;
    anchorTop: number;
    zoom: number;
    transformScale: number;
    fontOpticalSizing: "auto" | "none";
    fontSmoothing: "auto" | "antialiased";
    textRendering: "auto" | "geometricPrecision";
    mixBlendMode: "normal" | "multiply";
  };
}
export interface SfnsTerminalMaskManifestCase {
  id: SfnsTerminalMaskCaseId;
  kind: "scenario" | "control";
  scenarioId: SfnsTerminalMaskScenarioId;
  controlId: "" | SfnsTerminalMaskControlId;
  baselineScenarioId: "" | "zoom-2";
  request: SfnsTerminalMaskCaseRequest;
}

const baseFont = {
  scaleX: 1,
  skewX: 0,
  subpixel: true,
  linearMetrics: true,
  embeddedBitmaps: false,
  edging: "subpixel",
  hinting: "normal",
} as const;
const basePaint = { color: 0xffffffff, style: "fill" } as const;
const baseSurface = {
  flags: 0,
  pixelGeometry: "rgb-h",
  textContrast: 0,
  textGamma: 0,
} as const;
const baseAxes = { wdth: 100, opsz: 17, GRAD: 400, wght: 700 } as const;
const baseCss = {
  anchorLeft: 37.25,
  anchorTop: 18.25,
  zoom: 2,
  transformScale: 1,
  fontOpticalSizing: "auto",
  fontSmoothing: "auto",
  textRendering: "auto",
  mixBlendMode: "normal",
} as const;

function request(
  overrides: Partial<SfnsTerminalMaskCaseRequest> & {
    run: SfnsTerminalMaskCaseRequest["run"];
  },
): SfnsTerminalMaskCaseRequest {
  return {
    fontSize: overrides.fontSize ?? 26,
    axes: { ...baseAxes, ...overrides.axes },
    font: { ...baseFont, ...overrides.font },
    paint: { ...basePaint, ...overrides.paint },
    surface: { ...baseSurface, ...overrides.surface },
    scalerContextFlags: overrides.scalerContextFlags ?? 3,
    run: overrides.run,
    browserCss: { ...baseCss, ...overrides.browserCss },
  };
}

const cases: readonly SfnsTerminalMaskManifestCase[] = [
  {
    id: "zoom-2", kind: "scenario", scenarioId: "zoom-2", controlId: "",
    baselineScenarioId: "",
    request: request({
      run: {
        sourceStart: [0, 0], deviceStart: [37.25, 43], deviceBaseline: 43,
        liveDeviceMatrix: [1, 0, 37.25, 0, 1, 43, 0, 0, 1],
      },
    }),
  },
  {
    id: "transform-scale-2", kind: "scenario", scenarioId: "transform-scale-2",
    controlId: "", baselineScenarioId: "",
    request: request({
      fontSize: 13,
      run: {
        sourceStart: [0, 0], deviceStart: [0, 26], deviceBaseline: 26,
        liveDeviceMatrix: [2, 0, 0, 0, 2, 26, 0, 0, 1],
      },
      browserCss: { ...baseCss, zoom: 1, transformScale: 2 },
    }),
  },
  {
    id: "zoom-2-transform-half", kind: "scenario",
    scenarioId: "zoom-2-transform-half", controlId: "", baselineScenarioId: "",
    request: request({
      run: {
        sourceStart: [0, 0], deviceStart: [0, 12.5], deviceBaseline: 12.5,
        liveDeviceMatrix: [0.5, 0, 0, 0, 0.5, 12.5, 0, 0, 1],
      },
      browserCss: { ...baseCss, transformScale: 0.5 },
    }),
  },
  {
    id: "optical-sizing-none", kind: "scenario", scenarioId: "optical-sizing-none",
    controlId: "", baselineScenarioId: "",
    request: request({
      run: {
        sourceStart: [0, 0], deviceStart: [37.25, 43], deviceBaseline: 43,
        liveDeviceMatrix: [1, 0, 37.25, 0, 1, 43, 0, 0, 1],
      },
      browserCss: { ...baseCss, fontOpticalSizing: "none" },
    }),
  },
  {
    id: "opsz-26-mutation", kind: "scenario", scenarioId: "opsz-26-mutation",
    controlId: "", baselineScenarioId: "",
    request: request({
      axes: { ...baseAxes, opsz: 26 },
      run: {
        sourceStart: [0, 0], deviceStart: [37.25, 43], deviceBaseline: 43,
        liveDeviceMatrix: [1, 0, 37.25, 0, 1, 43, 0, 0, 1],
      },
    }),
  },
  {
    id: "control-subpixel-phase", kind: "control", scenarioId: "zoom-2",
    controlId: "subpixel-phase", baselineScenarioId: "zoom-2",
    request: request({
      run: {
        sourceStart: [0, 0], deviceStart: [37.5, 43], deviceBaseline: 43,
        liveDeviceMatrix: [1, 0, 37.5, 0, 1, 43, 0, 0, 1],
      },
      browserCss: { ...baseCss, anchorLeft: 37.5 },
    }),
  },
  {
    id: "control-anti-aliasing", kind: "control", scenarioId: "zoom-2",
    controlId: "anti-aliasing", baselineScenarioId: "zoom-2",
    request: request({
      font: { ...baseFont, edging: "aa" },
      run: {
        sourceStart: [0, 0], deviceStart: [37.25, 43], deviceBaseline: 43,
        liveDeviceMatrix: [1, 0, 37.25, 0, 1, 43, 0, 0, 1],
      },
      browserCss: { ...baseCss, fontSmoothing: "antialiased" },
    }),
  },
  {
    id: "control-hinting", kind: "control", scenarioId: "zoom-2",
    controlId: "hinting", baselineScenarioId: "zoom-2",
    request: request({
      font: { ...baseFont, hinting: "none" },
      run: {
        sourceStart: [0, 0], deviceStart: [37.25, 43], deviceBaseline: 43,
        liveDeviceMatrix: [1, 0, 37.25, 0, 1, 43, 0, 0, 1],
      },
      browserCss: { ...baseCss, textRendering: "geometricPrecision" },
    }),
  },
  {
    id: "control-device-matrix", kind: "control", scenarioId: "zoom-2",
    controlId: "device-matrix", baselineScenarioId: "zoom-2",
    request: request({
      run: {
        sourceStart: [0, 0], deviceStart: [0, 31.25], deviceBaseline: 31.25,
        liveDeviceMatrix: [1.25, 0, 0, 0, 1.25, 31.25, 0, 0, 1],
      },
      browserCss: { ...baseCss, transformScale: 1.25 },
    }),
  },
  {
    id: "control-optical-size", kind: "control", scenarioId: "zoom-2",
    controlId: "optical-size", baselineScenarioId: "zoom-2",
    request: request({
      axes: { ...baseAxes, opsz: 26 },
      run: {
        sourceStart: [0, 0], deviceStart: [37.25, 43], deviceBaseline: 43,
        liveDeviceMatrix: [1, 0, 37.25, 0, 1, 43, 0, 0, 1],
      },
    }),
  },
  {
    id: "control-surface-mask-format", kind: "control", scenarioId: "zoom-2",
    controlId: "surface-mask-format", baselineScenarioId: "zoom-2",
    request: request({
      surface: { ...baseSurface, pixelGeometry: "unknown" },
      run: {
        sourceStart: [0, 0], deviceStart: [0.25, 25], deviceBaseline: 25,
        liveDeviceMatrix: [1, 0, 0.25, 0, 1, 25, 0, 0, 1],
      },
      browserCss: { ...baseCss, mixBlendMode: "multiply" },
    }),
  },
];

export const SFNS_TERMINAL_MASK_MANIFEST = {
  schemaVersion: 1,
  abi: SFNS_TERMINAL_MASK_MANIFEST_ABI,
  source: {
    chromiumRevision: "7d859f271cbda744098ac69f44978d4edfa62be3",
    skiaRevision: "62efacd37737505732dbe3d8daa62abd679626a1",
    otsRevision: "46bea9879127d0ff1c6601b078e2ce98e83fcd33",
  },
  corpus: {
    text: "zoom2!",
    fontPath: "/System/Library/Fonts/SFNS.ttf",
    sourceFontByteLength: 7_909_644,
    sourceFontSha256: "2bfd40dc72e6759e248f82a52a40d551338979fffc9b5c070e685b4b7ad19e66",
    decodedFontByteLength: 7_806_016,
    decodedFontSha256: "48eedcecfc1b0338a2b0deaac43b017df55b3023cff2c5e8ecc87570b4eacff4",
    collectionIndex: 0,
    glyphIds: [969, 815, 815, 795, 1310, 1377] as const,
    baseAxes,
  },
  cases,
} as const;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value != null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

export function sfnsTerminalMaskManifestDigest(): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(SFNS_TERMINAL_MASK_MANIFEST)))
    .digest("hex");
}

export function sfnsTerminalMaskCase(
  id: SfnsTerminalMaskCaseId,
): SfnsTerminalMaskManifestCase {
  const match = SFNS_TERMINAL_MASK_MANIFEST.cases.find((candidate) => candidate.id === id);
  if (match == null) throw new Error(`unknown SFNS terminal-mask manifest case: ${id}`);
  return match as SfnsTerminalMaskManifestCase;
}

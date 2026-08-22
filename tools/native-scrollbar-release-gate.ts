import { z } from "zod";

export const SCROLLBAR_GATE_SOURCE_REVISIONS = {
  chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
  skiaPinnedByChromium: "62efacd37737505732dbe3d8daa62abd679626a1",
} as const;

export const SCROLLBAR_GATE_PLATFORMS = ["darwin", "linux", "win32"] as const;
export const SCROLLBAR_GATE_DPRS = [1, 2] as const;
export const SCROLLBAR_GATE_ZOOMS = [1, 1.25, 2] as const;

/**
 * DM-2484's minimum release matrix. Every id is required at every DPR/zoom on
 * every platform; an unsupported platform state is evidence, not permission to
 * omit the row.
 */
export const SCROLLBAR_GATE_SCENARIOS = [
  "overflow-visible-negative",
  "overflow-hidden-negative",
  "overflow-clip-negative",
  "auto-no-overflow-negative",
  "width-none-scrolled",
  "custom-scroll-no-overflow",
  "custom-y-top",
  "custom-y-mid",
  "custom-y-max",
  "custom-x-mid",
  "custom-both-corner",
  "custom-rtl-logical-left",
  "custom-vertical-writing",
  "custom-border-radius-ancestor-clip",
  "custom-affine-transform",
  "custom-root-scroller",
  "custom-resizer-overlap",
  "native-auto-light",
  "native-auto-dark",
  "native-forced-colors",
  "native-thin-standard-colors",
  "native-gutter-auto",
  "native-gutter-stable",
  "native-gutter-both-edges",
  "native-root-scroller",
  "native-overlay-rest",
  "native-overlay-reveal",
  "native-overlay-hover",
  "native-overlay-press",
  "native-overlay-fade",
] as const;

const rectSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const boundsSchema = rectSchema.extend({ pixels: z.number().int().positive() });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const artifactSchema = z.object({
  role: z.enum(["source", "generated"]),
  part: z.enum(["horizontal", "vertical", "corner"]),
  path: z.string().min(1),
  sha256: sha256Schema,
  pngWidth: z.number().int().positive(),
  pngHeight: z.number().int().positive(),
  deviceRect: rectSchema,
  sourceFrameDeviceRect: rectSchema,
  sourceClipDeviceRect: rectSchema,
});

const pixelSchema = z.object({
  markerPixels: z.number().int().nonnegative(),
  markers: z.record(z.string(), boundsSchema.nullable()),
  vectorSentinel: boundsSchema,
});

const rowSchema = z.object({
  id: z.enum(SCROLLBAR_GATE_SCENARIOS),
  deviceScaleFactor: z.union([z.literal(1), z.literal(2)]),
  cssZoom: z.union([z.literal(1), z.literal(1.25), z.literal(2)]),
  expectedRoute: z.enum([
    "marker-free-control",
    "suppressed-captured-absence",
    "custom-vector",
    "custom-vector-current-gap",
    "native-raster",
    "native-platform-fingerprint",
  ]),
  capturedStatus: z.enum(["captured", "partial", "absent", "unavailable"]),
  missingFacts: z.array(z.string()),
  warnings: z.array(z.string()),
  sourcePixels: pixelSchema,
  generatedPixels: pixelSchema,
  artifacts: z.array(artifactSchema),
  noInk: z.boolean().default(false),
  legacyPillCount: z.number().int().nonnegative(),
  outputTransformApplications: z.number().int().nonnegative(),
  paintOrder: z.array(z.enum(["horizontal", "vertical", "corner", "resizer"])),
  sourceState: z.object({
    platformMode: z.enum(["classic", "overlay", "suppressed"]),
    scheme: z.enum(["light", "dark"]),
    forcedColors: z.boolean(),
    scrollOffset: z.number(),
    logicalSide: z.enum(["left", "right", "bottom", "none"]),
  }),
  pass: z.boolean(),
});

export const nativeScrollbarAuditReportSchema = z.object({
  schemaVersion: z.literal(2),
  sourceRevisions: z.object({
    chromium: z.string(),
    skiaPinnedByChromium: z.string(),
  }),
  environment: z.object({
    platform: z.enum(SCROLLBAR_GATE_PLATFORMS),
    architecture: z.string().min(1),
    osRelease: z.string().min(1),
    runnerImage: z.string().min(1),
    runnerImageVersion: z.string().min(1),
    chromiumVersion: z.string().min(1),
    chromiumRevision: z.string().min(1),
    playwrightVersion: z.string().min(1),
    launchArguments: z.array(z.string()),
    ignoredDefaultArguments: z.array(z.string()),
    hideScrollbarsDefaultRemoved: z.literal(true),
    scrollbarPreference: z.enum(["classic", "overlay", "mixed", "suppressed"]),
  }),
  matrix: z.object({
    deviceScaleFactors: z.array(z.number()),
    cssZooms: z.array(z.number()),
  }),
  rows: z.array(rowSchema),
});

export type NativeScrollbarAuditReport = z.infer<typeof nativeScrollbarAuditReportSchema>;
export type NativeScrollbarAuditRow = NativeScrollbarAuditReport["rows"][number];

export interface NativeScrollbarRasterEnvelope {
  id: string;
  reviewed: true;
  platform: NativeScrollbarAuditReport["environment"]["platform"];
  architecture: string;
  runnerImage: string;
  runnerImageVersion: string;
  chromiumRevision: string;
  rowId: string;
  deviceScaleFactor: number;
  cssZoom: number;
  part: "horizontal" | "vertical" | "corner";
  allowedPairs: Array<{ sourceSha256: string; generatedSha256: string }>;
}

export interface NativeScrollbarGateResult {
  ready: boolean;
  blockers: string[];
  summary: string;
}

function setEquals(actual: readonly number[], expected: readonly number[]): boolean {
  return actual.length === expected.length
    && expected.every((value) => actual.includes(value));
}

function rowKey(row: Pick<NativeScrollbarAuditRow, "id" | "deviceScaleFactor" | "cssZoom">): string {
  return `${row.id}@${row.deviceScaleFactor}x/z${row.cssZoom}`;
}

function boundsDelta(a: z.infer<typeof boundsSchema>, b: z.infer<typeof boundsSchema>): number {
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.width - b.width),
    Math.abs(a.height - b.height),
  );
}

function rectContains(outer: z.infer<typeof rectSchema>, inner: z.infer<typeof rectSchema>): boolean {
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

function envelopeMatches(
  report: NativeScrollbarAuditReport,
  row: NativeScrollbarAuditRow,
  source: NativeScrollbarAuditRow["artifacts"][number],
  generated: NativeScrollbarAuditRow["artifacts"][number],
  envelope: NativeScrollbarRasterEnvelope,
): boolean {
  const environment = report.environment;
  return envelope.reviewed
    && envelope.platform === environment.platform
    && envelope.architecture === environment.architecture
    && envelope.runnerImage === environment.runnerImage
    && envelope.runnerImageVersion === environment.runnerImageVersion
    && envelope.chromiumRevision === environment.chromiumRevision
    && envelope.rowId === row.id
    && envelope.deviceScaleFactor === row.deviceScaleFactor
    && envelope.cssZoom === row.cssZoom
    && envelope.part === source.part
    && envelope.allowedPairs.some((pair) => pair.sourceSha256 === source.sha256
      && pair.generatedSha256 === generated.sha256);
}

function validateArtifactPair(
  report: NativeScrollbarAuditReport,
  row: NativeScrollbarAuditRow,
  source: NativeScrollbarAuditRow["artifacts"][number],
  generated: NativeScrollbarAuditRow["artifacts"][number],
  envelopes: readonly NativeScrollbarRasterEnvelope[],
  blockers: string[],
): void {
  const key = `${report.environment.platform}/${rowKey(row)}/${source.part}`;
  for (const artifact of [source, generated]) {
    if (artifact.pngWidth !== artifact.deviceRect.width || artifact.pngHeight !== artifact.deviceRect.height) {
      blockers.push(`${key}: ${artifact.role} PNG dimensions do not equal its lossless crop`);
    }
    if (!rectContains(artifact.sourceFrameDeviceRect, artifact.deviceRect)) {
      blockers.push(`${key}: ${artifact.role} crop escapes its source-owned frame`);
    }
    if (!rectContains(artifact.sourceClipDeviceRect, artifact.deviceRect)) {
      blockers.push(`${key}: ${artifact.role} crop escapes OverflowControlsClip`);
    }
  }
  if (source.deviceRect.x !== generated.deviceRect.x
      || source.deviceRect.y !== generated.deviceRect.y
      || source.deviceRect.width !== generated.deviceRect.width
      || source.deviceRect.height !== generated.deviceRect.height) {
    blockers.push(`${key}: source/generated crops do not address the same device-pixel rectangle`);
  }
  if (row.expectedRoute !== "native-raster" || source.sha256 === generated.sha256) return;
  if (!envelopes.some((envelope) => envelopeMatches(report, row, source, generated, envelope))) {
    blockers.push(`${key}: native pixels differ without a reviewed platform/fingerprint-specific envelope`);
  }
}

function validateRow(
  report: NativeScrollbarAuditReport,
  row: NativeScrollbarAuditRow,
  envelopes: readonly NativeScrollbarRasterEnvelope[],
  blockers: string[],
): void {
  const key = `${report.environment.platform}/${rowKey(row)}`;
  if (!row.pass) blockers.push(`${key}: producer classified the row as failed`);
  if (row.warnings.length > 0) blockers.push(`${key}: warnings are forbidden (${row.warnings.join(", ")})`);
  if (row.missingFacts.length > 0) blockers.push(`${key}: missing facts (${row.missingFacts.join(", ")})`);
  if (row.legacyPillCount !== 0) blockers.push(`${key}: legacy 7px synthetic pill reappeared`);
  if (row.outputTransformApplications > 1) blockers.push(`${key}: scrollbar output transform applied more than once`);
  if (boundsDelta(row.sourcePixels.vectorSentinel, row.generatedPixels.vectorSentinel) > 1
      || row.sourcePixels.vectorSentinel.pixels !== row.generatedPixels.vectorSentinel.pixels) {
    blockers.push(`${key}: vector sibling was not preserved independently of scrollbar paint`);
  }

  const isPaint = row.expectedRoute === "custom-vector"
    || row.expectedRoute === "native-raster"
    || row.expectedRoute.endsWith("current-gap")
    || row.expectedRoute === "native-platform-fingerprint";
  if (isPaint && row.outputTransformApplications !== 1) {
    blockers.push(`${key}: painted scrollbar lacks one authoritative output transform application`);
  }
  if (row.expectedRoute.endsWith("current-gap") || row.expectedRoute === "native-platform-fingerprint") {
    blockers.push(`${key}: observational expected-gap route is not releasable`);
  }
  if (isPaint && row.capturedStatus !== "captured") {
    blockers.push(`${key}: paint route is ${row.capturedStatus}, not captured`);
  }
  if (!isPaint && !new Set(["absent", "captured"]).has(row.capturedStatus)) {
    blockers.push(`${key}: negative route is not authoritative (${row.capturedStatus})`);
  }

  if (row.expectedRoute === "custom-vector") {
    const sourceClasses = Object.entries(row.sourcePixels.markers)
      .filter(([, bounds]) => bounds != null).map(([name]) => name).sort();
    const generatedClasses = Object.entries(row.generatedPixels.markers)
      .filter(([, bounds]) => bounds != null).map(([name]) => name).sort();
    if (sourceClasses.join("|") !== generatedClasses.join("|")) {
      blockers.push(`${key}: custom marker classification differs (${sourceClasses} vs ${generatedClasses})`);
    }
    for (const name of sourceClasses) {
      const source = row.sourcePixels.markers[name];
      const generated = row.generatedPixels.markers[name];
      if (source != null && generated != null && boundsDelta(source, generated) > 1) {
        blockers.push(`${key}: ${name} bound delta exceeds 1 device pixel`);
      }
    }
  }

  const sourceArtifacts = new Map(row.artifacts
    .filter(({ role }) => role === "source").map((artifact) => [artifact.part, artifact]));
  const generatedArtifacts = new Map(row.artifacts
    .filter(({ role }) => role === "generated").map((artifact) => [artifact.part, artifact]));
  if (isPaint && !row.noInk && sourceArtifacts.size === 0) blockers.push(`${key}: missing isolated source strip crops`);
  for (const [part, source] of sourceArtifacts) {
    const generated = generatedArtifacts.get(part);
    if (generated == null) blockers.push(`${key}/${part}: missing generated strip crop`);
    else validateArtifactPair(report, row, source, generated, envelopes, blockers);
  }
  for (const part of generatedArtifacts.keys()) {
    if (!sourceArtifacts.has(part)) blockers.push(`${key}/${part}: generated strip has no source crop`);
  }

  if (row.id === "custom-resizer-overlap") {
    const corner = row.paintOrder.indexOf("corner");
    const resizer = row.paintOrder.indexOf("resizer");
    if (corner < 0 || resizer < 0 || corner >= resizer) {
      blockers.push(`${key}: corner must paint before overlapping resizer`);
    }
  }
  if (row.id === "custom-rtl-logical-left"
      && !(row.sourceState.logicalSide === "left" && row.sourceState.scrollOffset < 0)) {
    blockers.push(`${key}: RTL logical-left/negative-offset source state was not retained`);
  }
}

export function adjudicateNativeScrollbarReports(
  inputs: readonly unknown[],
  envelopes: readonly NativeScrollbarRasterEnvelope[] = [],
  artifactIntegrityBlockers: readonly string[] = [],
): NativeScrollbarGateResult {
  const blockers = [...artifactIntegrityBlockers];
  const reports: NativeScrollbarAuditReport[] = [];
  for (let index = 0; index < inputs.length; index++) {
    const parsed = nativeScrollbarAuditReportSchema.safeParse(inputs[index]);
    if (!parsed.success) {
      blockers.push(`report ${index + 1}: schema v2 rejected evidence: ${z.prettifyError(parsed.error)}`);
    } else {
      reports.push(parsed.data);
    }
  }

  const byPlatform = new Map<NativeScrollbarAuditReport["environment"]["platform"], NativeScrollbarAuditReport>();
  for (const report of reports) {
    const platform = report.environment.platform;
    if (byPlatform.has(platform)) blockers.push(`duplicate platform report: ${platform}`);
    byPlatform.set(platform, report);
  }
  for (const platform of SCROLLBAR_GATE_PLATFORMS) {
    if (!byPlatform.has(platform)) blockers.push(`missing native platform report: ${platform}`);
  }

  for (const report of reports) {
    const platform = report.environment.platform;
    if (report.sourceRevisions.chromium !== SCROLLBAR_GATE_SOURCE_REVISIONS.chromium
        || report.sourceRevisions.skiaPinnedByChromium !== SCROLLBAR_GATE_SOURCE_REVISIONS.skiaPinnedByChromium) {
      blockers.push(`${platform}: pinned Chromium/Skia source revision mismatch`);
    }
    if (!setEquals(report.matrix.deviceScaleFactors, SCROLLBAR_GATE_DPRS)
        || !setEquals(report.matrix.cssZooms, SCROLLBAR_GATE_ZOOMS)) {
      blockers.push(`${platform}: DPR/zoom matrix is not the required 1,2 × 1,1.25,2 Cartesian product`);
    }
    const rows = new Map<string, NativeScrollbarAuditRow>();
    for (const row of report.rows) {
      const key = rowKey(row);
      if (rows.has(key)) blockers.push(`${platform}: duplicate matrix row ${key}`);
      rows.set(key, row);
      validateRow(report, row, envelopes, blockers);
    }
    for (const id of SCROLLBAR_GATE_SCENARIOS) {
      for (const deviceScaleFactor of SCROLLBAR_GATE_DPRS) {
        for (const cssZoom of SCROLLBAR_GATE_ZOOMS) {
          const key = `${id}@${deviceScaleFactor}x/z${cssZoom}`;
          if (!rows.has(key)) blockers.push(`${platform}: missing Cartesian row ${key}`);
        }
      }
    }
    for (const deviceScaleFactor of SCROLLBAR_GATE_DPRS) {
      for (const cssZoom of SCROLLBAR_GATE_ZOOMS) {
        const positions = ["custom-y-top", "custom-y-mid", "custom-y-max"].map((id) =>
          rows.get(`${id}@${deviceScaleFactor}x/z${cssZoom}`)?.generatedPixels.markers.thumb?.y);
        if (positions.every((position) => position != null)
            && !(positions[0]! < positions[1]! && positions[1]! < positions[2]!)) {
          blockers.push(`${platform}: generated thumb is frozen across top/mid/max at ${deviceScaleFactor}x/z${cssZoom}`);
        }
      }
    }
  }

  const unique = [...new Set(blockers)];
  return {
    ready: unique.length === 0,
    blockers: unique,
    summary: `${unique.length === 0 ? "READY" : "NOT READY"}: ${unique.length} native scrollbar blocker(s)`,
  };
}

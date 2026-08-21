/**
 * Evidence-only macOS terminal-raster classifier (DM-2431).
 *
 * This never changes a visual verdict. It recognizes only the exact records
 * proven in Chromium run 32366223808 after all pre-raster facts agree, and
 * reports whether their residual stays inside the measured CoreText envelope.
 */
export const PINNED_RASTER_ENVIRONMENT = {
  chromium: "147.0.7727.15",
  skia: "62efacd3",
  run: 32366223808,
  platform: "darwin",
  fontSizePx: 32,
  paint: "fill:#111;stroke:none",
  subpixelPositionBits: 2,
} as const;

export interface TerminalRasterRecord {
  id: string;
  face: string;
  glyphs: Array<{ gid: number; cluster: number; advance: number }>;
  upem: number;
  fontSizePx: number;
  paint: string;
  sourceOutline: { commandCount: number };
  subsetOutline: { commandCount: number; maxCoordinateDelta: number };
  sourcePositionKey: [number, number];
  emittedPositionKey: [number, number];
  residual: { area: number; width: number; height: number; severity: number; maxEdgeDistance: number };
  expectedChanged: boolean;
}

const row = (
  id: string, face: string, gid: number, advance: number, upem: number,
  commands: number, area: number, width: number, height: number, severity: number,
  maxEdgeDistance: number, positionKey: [number, number], expectedChanged = true,
): TerminalRasterRecord => ({
  id, face, glyphs: [{ gid, cluster: 0, advance }], upem,
  fontSizePx: PINNED_RASTER_ENVIRONMENT.fontSizePx,
  paint: PINNED_RASTER_ENVIRONMENT.paint,
  sourceOutline: { commandCount: commands },
  subsetOutline: { commandCount: commands, maxCoordinateDelta: face === ".SFMalayalam-Regular" ? 1.4210854715202004e-14 : 0 },
  sourcePositionKey: positionKey, emittedPositionKey: positionKey,
  residual: { area, width, height, severity, maxEdgeDistance }, expectedChanged,
});

export const POSITIVE_RECORDS: TerminalRasterRecord[] = [
  row("malayalam-d13", "MalayalamSangamMN", 129, 2148, 2048, 122, 31, 18, 24, 56.86274337768555, 0, [1, 0]),
  row("malayalam-d5a", ".SFMalayalam-Regular", 120, 943, 1000, 45, 16, 23, 9, 81.96078491210938, 0, [0, 0]),
  row("malayalam-d76", ".SFMalayalam-Regular", 115, 1092, 1000, 53, 16, 21, 9, 83.52941131591797, 0, [2, 0]),
  row("sinhala-dd4", "SinhalaSangamMN", 651, 1188, 2048, 129, 47, 23, 23, 83.52941131591797, 0, [3, 0]),
  row("sinhala-dd6", "SinhalaSangamMN", 652, 1188, 2048, 143, 43, 23, 24, 61.17647171020508, 0, [3, 0]),
  row("myanmar-104f", "MyanmarSangamMN", 186, 1798, 2048, 112, 25, 19, 22, 56.86274337768555, 1, [0, 0]),
  row("apple-symbols-10167", "AppleSymbols", 1975, 1049, 2048, 22, 17, 11, 13, 78.4313735961914, 1, [3, 0]),
];

export const ZERO_DIFF_CONTROLS = [
  ["malayalam-d12", "MalayalamSangamMN", 128, 1302, 2048], ["malayalam-d15", "MalayalamSangamMN", 131, 1812, 2048],
  ["malayalam-d59", ".SFMalayalam-Regular", 119, 888, 1000], ["malayalam-d5b", ".SFMalayalam-Regular", 121, 789, 1000],
  ["malayalam-d77", ".SFMalayalam-Regular", 116, 1482, 1000], ["malayalam-d5d", ".SFMalayalam-Regular", 123, 1605, 1000],
  ["sinhala-dd3", "SinhalaSangamMN", 155, 1113, 2048], ["sinhala-dd2", "SinhalaSangamMN", 154, 1113, 2048],
  ["sinhala-dd8", "SinhalaSangamMN", 158, 770, 2048], ["myanmar-104e", "MyanmarSangamMN", 185, 1221, 2048],
  ["myanmar-104d", "MyanmarSangamMN", 184, 1509, 2048], ["apple-symbols-10166", "AppleSymbols", 1974, 1049, 2048],
  ["apple-symbols-10168", "AppleSymbols", 1976, 1049, 2048],
].map(([id, face, gid, advance, upem]) => row(id as string, face as string, gid as number, advance as number, upem as number, 1, 0, 0, 0, 0, 0, [0, 0], false));

const identity = (r: TerminalRasterRecord) => JSON.stringify({ face: r.face, glyphs: r.glyphs, upem: r.upem });
const known = new Map([...POSITIVE_RECORDS, ...ZERO_DIFF_CONTROLS].map((r) => [identity(r), r]));

export function classifyTerminalRaster(record: TerminalRasterRecord) {
  const expected = known.get(identity(record));
  const reasons: string[] = [];
  if (expected == null) reasons.push("unknown-face-glyph-cluster-advance-upem");
  if (record.fontSizePx !== PINNED_RASTER_ENVIRONMENT.fontSizePx) reasons.push("font-size");
  if (record.paint !== PINNED_RASTER_ENVIRONMENT.paint) reasons.push("paint");
  if (record.sourceOutline.commandCount !== record.subsetOutline.commandCount || record.subsetOutline.maxCoordinateDelta > 1.5e-14) reasons.push("outline");
  if (record.sourcePositionKey[0] !== record.emittedPositionKey[0] || record.sourcePositionKey[1] !== record.emittedPositionKey[1]) reasons.push("position-key");
  if (expected != null && JSON.stringify(record.sourcePositionKey) !== JSON.stringify(expected.sourcePositionKey)) reasons.push("unexpected-position-key");
  if (reasons.length > 0) return { classification: "unclassified" as const, reasons };
  const { residual } = record;
  const insideEnvelope = residual.maxEdgeDistance <= 1 && residual.area <= 47 && residual.width <= 23 && residual.height <= 24 && residual.severity <= 83.52941131591797;
  const controlExact = expected!.expectedChanged || (residual.area === 0 && residual.severity === 0);
  return { classification: insideEnvelope && controlExact ? "terminal-raster-evidence" as const : "envelope-violation" as const, reasons: [] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const records = [...POSITIVE_RECORDS, ...ZERO_DIFF_CONTROLS];
  const results = records.map((record) => ({ id: record.id, ...classifyTerminalRaster(record), residual: record.residual }));
  const failures = results.filter((result) => result.classification !== "terminal-raster-evidence");
  console.log(JSON.stringify({ schemaVersion: 1, environment: PINNED_RASTER_ENVIRONMENT, authority: "diagnostic-only", results }, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

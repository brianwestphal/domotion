/** Versioned persistence for the Windows Unicode font-route diagnostic. */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { outcomeSchema, reportEnvelopeSchema, writeReport } from "./lib/report.js";

export const UNICODE_FONT_ROUTE_TOOL = "unicode-font-route-trace";

const cellSchema = z
  .object({
    selector: z.string(),
    cp: z.number().int().nonnegative(),
    text: z.string(),
    fontFamily: z.string(),
    chrome: z.unknown(),
    hardcoded: z.unknown(),
    directWrite: z.unknown(),
    domotion: z.unknown(),
  })
  .passthrough();
const artifactSchema = z
  .object({
    schemaVersion: z.literal(2),
    generatedAt: z.iso.datetime({ offset: true }),
    platform: z.literal("win32"),
    fixture: z.string(),
    cells: z.array(cellSchema),
  })
  .passthrough();

export type UnicodeFontRouteArtifact = z.infer<typeof artifactSchema>;

export function readUnicodeFontRouteReport(path: string): UnicodeFontRouteArtifact {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (raw != null && typeof raw === "object" && ("tool" in raw || "data" in raw)) {
    const data = reportEnvelopeSchema(artifactSchema.extend({ outcome: outcomeSchema }), {
      tool: UNICODE_FONT_ROUTE_TOOL,
      schemaVersion: 1,
    }).parse(raw).data;
    if (data.outcome !== "pass") throw new Error("Unicode font-route report outcome mismatch");
    const { outcome: _outcome, ...artifact } = data;
    return artifact;
  }
  return artifactSchema.parse(raw);
}

export function writeUnicodeFontRouteReport(path: string, artifact: UnicodeFontRouteArtifact): void {
  artifactSchema.parse(artifact);
  writeReport(
    path,
    UNICODE_FONT_ROUTE_TOOL,
    { ...artifact, outcome: "pass" },
    {
      schemaVersion: 1,
      env: { platform: "win32" },
    },
  );
}

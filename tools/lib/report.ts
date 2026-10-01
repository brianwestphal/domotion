import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

export type Outcome = "pass" | "fail" | "skip" | "error";
export const outcomeSchema = z.enum(["pass", "fail", "skip", "error"]);

export interface ReportEnvelope<T> {
  schemaVersion: number;
  tool: string;
  generatedAt: string;
  env: Record<string, unknown>;
  data: T;
}

export function reportEnvelopeSchema<T extends z.ZodTypeAny>(
  data: T,
  options: { tool: string; schemaVersion: number },
) {
  return z.object({
    schemaVersion: z.literal(options.schemaVersion),
    tool: z.literal(options.tool),
    generatedAt: z.iso.datetime({ offset: true }),
    env: z.record(z.string(), z.unknown()),
    data,
  });
}

export function writeReport<T>(
  path: string,
  tool: string,
  data: T,
  options: { schemaVersion: number; generatedAt?: string; env?: Record<string, unknown>; flag?: "w" | "wx" },
): ReportEnvelope<T> {
  const report: ReportEnvelope<T> = {
    schemaVersion: options.schemaVersion,
    tool,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    env: options.env ?? {},
    data,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { flag: options.flag ?? "w" });
  return report;
}

export function readReport<T extends z.ZodTypeAny>(path: string, schema: T): z.infer<T> {
  return schema.parse(JSON.parse(readFileSync(path, "utf8"))) as z.infer<T>;
}

export function readReportData<T extends z.ZodTypeAny, L extends z.ZodType<z.infer<T>> = T>(
  path: string,
  dataSchema: T,
  options: { tool: string; schemaVersion: number; legacySchema?: L; legacySchemaVersion?: number },
): z.infer<T> {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (raw != null && typeof raw === "object" && ("tool" in raw || ("schemaVersion" in raw && "data" in raw))) {
    return reportEnvelopeSchema(dataSchema, options).parse(raw).data as z.infer<T>;
  }
  if (raw != null && typeof raw === "object" && "schemaVersion" in raw) {
    if (options.legacySchemaVersion == null || raw.schemaVersion !== options.legacySchemaVersion)
      throw new Error(`unsupported legacy ${options.tool} report version`);
  } else if (options.legacySchemaVersion != null) {
    throw new Error(`missing legacy ${options.tool} report version`);
  }
  if (options.legacySchema != null) return options.legacySchema.parse(raw) as z.infer<T>;
  throw new Error(`unversioned ${options.tool} report`);
}

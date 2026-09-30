import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { z } from "zod";

export type Outcome = "pass" | "fail" | "skip" | "error";

export interface ReportEnvelope<T> {
  schemaVersion: number;
  tool: string;
  generatedAt: string;
  env: Record<string, unknown>;
  data: T;
}

export function writeReport<T>(
  path: string,
  tool: string,
  data: T,
  options: { schemaVersion: number; generatedAt?: string; env?: Record<string, unknown> },
): ReportEnvelope<T> {
  const report: ReportEnvelope<T> = {
    schemaVersion: options.schemaVersion,
    tool,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    env: options.env ?? {},
    data,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export function readReport<T extends z.ZodTypeAny>(path: string, schema: T): z.infer<T> {
  return schema.parse(JSON.parse(readFileSync(path, "utf8"))) as z.infer<T>;
}

/**
 * Fail-closed CLI for the DM-2583 owner/resource truth adjudicator.
 *
 * The schema owns all logical validation and exact proposal/validation
 * comparisons. This wrapper only reopens retained JSON artifacts, invokes that
 * pure adjudicator, and optionally persists its verdict. It never launches a
 * browser, reads an image body, or changes production capture behavior.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  adjudicateAnimatedImageOwnerResourceTruth,
  animatedImageTruthSha256,
  type AnimatedImageTruthAdjudication,
  type AnimatedImageTruthRunReport,
} from "./animated-image-owner-resource-truth-schema.js";

interface AnimatedImageTruthAdjudicationInput {
  pathToken: string;
  byteLength: number;
  sha256: string;
}

export interface AnimatedImageTruthAdjudicationArtifact {
  schemaVersion: 1;
  ticket: "DM-2583";
  stage: "animated-image-owner-resource-truth-adjudication";
  inputs: AnimatedImageTruthAdjudicationInput[];
  adjudication: AnimatedImageTruthAdjudication;
  reportSha256: string;
}

function argumentValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
}

function argumentValues(argv: string[], flag: string): string[] {
  return argv.flatMap((value, index) =>
    value === flag && argv[index + 1] != null ? [argv[index + 1]] : []);
}

function readReport(path: string): {
  input: AnimatedImageTruthAdjudicationInput;
  report: unknown;
} {
  const bytes = readFileSync(resolve(path));
  return {
    input: {
      pathToken: basename(path),
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    report: JSON.parse(bytes.toString("utf8")),
  };
}

function reportSortKey(report: unknown): string {
  if (report == null || typeof report !== "object" || Array.isArray(report)) {
    return "~malformed";
  }
  const candidate = report as Record<string, unknown>;
  return typeof candidate.operatingSystem === "string" &&
      typeof candidate.evidenceRole === "string"
    ? `${candidate.operatingSystem}/${candidate.evidenceRole}`
    : "~malformed";
}

export function runAnimatedImageOwnerResourceTruthAdjudicator(
  artifactPaths: string[],
): AnimatedImageTruthAdjudicationArtifact {
  const inputs = artifactPaths.map(readReport).sort((left, right) =>
    reportSortKey(left.report).localeCompare(reportSortKey(right.report)));
  const payload = {
    schemaVersion: 1 as const,
    ticket: "DM-2583" as const,
    stage: "animated-image-owner-resource-truth-adjudication" as const,
    inputs: inputs.map((input) => input.input),
    adjudication: adjudicateAnimatedImageOwnerResourceTruth(
      inputs.map((input) => input.report) as AnimatedImageTruthRunReport[],
    ),
  };
  return { ...payload, reportSha256: animatedImageTruthSha256(payload) };
}

function runCli(): void {
  const argv = process.argv.slice(2);
  const artifactPaths = argumentValues(argv, "--artifact");
  if (artifactPaths.length === 0) {
    throw new Error("at least one --artifact path is required");
  }
  const report = runAnimatedImageOwnerResourceTruthAdjudicator(artifactPaths);
  const reportPath = argumentValue(argv, "--report");
  if (reportPath != null) {
    writeFileSync(
      resolve(reportPath),
      `${JSON.stringify(report, null, 2)}\n`,
      { flag: "wx" },
    );
  }
  console.log(
    `DM-2583 truth adjudication: ${report.adjudication.verdict}; `
      + `artifacts=${artifactPaths.length}; `
      + `failures=${report.adjudication.failures.length}; `
      + `report=${report.reportSha256}`,
  );
  if (report.adjudication.failures.length > 0) {
    console.error(report.adjudication.failures.join("\n"));
  }
  if (report.adjudication.verdict !== "proposal-validation-agreement" &&
      !argv.includes("--allow-withheld")) {
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] != null &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    runCli();
  } catch {
    // A malformed retained file may itself contain facts that are forbidden in
    // a denial artifact. Never echo its parser error, source text, or path.
    console.error("DM-2583 truth adjudication failed closed before verdict");
    process.exitCode = 1;
  }
}

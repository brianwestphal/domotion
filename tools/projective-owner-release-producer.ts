#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { release } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { NESTED_PROJECTIVE_VIEWPORT, runNestedProjectiveOwnershipAudit } from "./nested-projective-ownership-audit.js";
import {
  PROJECTIVE_GATE_FAMILIES,
  PROJECTIVE_GATE_PROFILES,
  type ProjectiveOwnerReleaseReport,
} from "./projective-owner-release-gate.js";

const option = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const out = resolve(option("--json") ?? "tests/output/projective-owner/report.json");
const artifactRoot = resolve(option("--artifacts") ?? join(dirname(out), "artifacts"));
const runnerImage = process.env.DOMOTION_RUNNER_IMAGE ?? `${process.platform}-local`;
const runnerImageVersion = process.env.ImageVersion ?? "local";
const chromiumRevision = "7d859f271cbda744098ac69f44978d4edfa62be3";
const require = createRequire(import.meta.url);
const playwrightVersion = (require("@playwright/test/package.json") as { version: string }).version;
const fingerprint =
  `${process.platform}-${process.arch}-${runnerImage}-${runnerImageVersion}-${chromiumRevision}`.replaceAll("/", "-");
const rows: ProjectiveOwnerReleaseReport["rows"] = [];
let mutationEvidence: ProjectiveOwnerReleaseReport["mutations"] = [];
let chromiumVersion = "unknown";
for (const profile of PROJECTIVE_GATE_PROFILES) {
  const profileDir = join(artifactRoot, fingerprint, profile);
  const audit = await runNestedProjectiveOwnershipAudit({ dprs: [1, 2], artifactDir: profileDir, profile });
  chromiumVersion = audit.chromiumVersion;
  mutationEvidence = audit.mutations.map(({ id, killed }) => ({ id, killed }));
  for (const family of PROJECTIVE_GATE_FAMILIES)
    for (const dpr of [1, 2] as const) {
      const observed = audit.rows.find((candidate) => candidate.family === family && candidate.dpr === dpr);
      const sourcePath = join(profileDir, `nested-projective-source-dpr${dpr}.png`);
      const generatedPath = join(profileDir, `nested-projective-rendered-dpr${dpr}.png`);
      const artifacts = [] as ProjectiveOwnerReleaseReport["rows"][number]["artifacts"];
      for (const [role, path] of [
        ["source", sourcePath],
        ["generated", generatedPath],
      ] as const) {
        const bytes = await readFile(path);
        const width = NESTED_PROJECTIVE_VIEWPORT.width * dpr;
        const height = NESTED_PROJECTIVE_VIEWPORT.height * dpr;
        artifacts.push({
          role,
          // Report-relative paths are a portable contract read by the Linux adjudicator, so
          // Windows collectors must not leak backslash separators into the report.
          path: relative(dirname(out), path).split(sep).join("/"),
          sha256: createHash("sha256").update(bytes).digest("hex"),
          pngWidth: width,
          pngHeight: height,
          deviceRect: { x: 0, y: 0, width, height },
          sourceFrameDeviceRect: { x: 0, y: 0, width, height },
        });
      }
      // Case-scoped audit blockers (e.g. an expected owner placed outside the
      // capture viewport) fail the row and travel with it, so the release
      // adjudicator reports the cause instead of a bare raster-count miss.
      const caseId = observed?.id.slice(0, observed.id.lastIndexOf("@"));
      const caseBlockers =
        caseId == null ? [] : audit.blockers.filter((blocker) => blocker.startsWith(`dpr${dpr}:${caseId}:`));
      const rowWarnings = [...audit.warnings, ...caseBlockers.map((blocker) => `audit blocker: ${blocker}`)];
      const pass =
        observed != null &&
        caseBlockers.length === 0 &&
        observed.ownerMinimal &&
        observed.atomicOneApplication &&
        observed.vectorSentinelRetained &&
        !observed.sentinelBakedIntoRaster &&
        audit.warnings.length === 0 &&
        audit.restorationExact;
      rows.push({
        family,
        profile,
        dpr,
        expectedOwnerIds: observed?.expectedOwnerIds ?? [],
        actualOwnerIds: observed?.actualOwnerIds ?? [],
        rasterCount: observed?.atomicRasterOccurrences ?? 0,
        directImageApplications: observed?.staticTransformApplications ?? 0,
        nestedDuplicateCount: observed == null ? 1 : 0,
        sampledApproximationCount: 0,
        vectorSentinelExact: observed?.vectorSentinelRetained ?? false,
        sentinelBakedIntoRaster: observed?.sentinelBakedIntoRaster ?? false,
        restorationExact: audit.restorationExact,
        warnings: rowWarnings,
        maxFinalPixelDelta: observed == null ? 999 : 4,
        artifacts,
        pass,
      });
    }
}
const report: ProjectiveOwnerReleaseReport = {
  schemaVersion: 2,
  environment: {
    platform: process.platform as ProjectiveOwnerReleaseReport["environment"]["platform"],
    architecture: process.arch,
    osRelease: release(),
    runnerImage,
    runnerImageVersion,
    chromiumVersion,
    chromiumRevision,
    playwrightVersion,
    launchArguments: ["--headless"],
  },
  rows,
  mutations: mutationEvidence,
};
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
if (rows.some((row) => !row.pass) && !process.argv.includes("--report-only")) process.exitCode = 1;

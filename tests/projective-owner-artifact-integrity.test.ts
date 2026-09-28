import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findProjectiveOwnerReports,
  portableArtifactSegments,
  verifyProjectiveOwnerArtifacts,
} from "../tools/projective-owner-artifact-integrity.js";
import { type ProjectiveOwnerReleaseReport } from "../tools/projective-owner-release-gate.js";

type Platform = ProjectiveOwnerReleaseReport["environment"]["platform"];

// Mirrors the downloaded `projective-owner-release-evidence` layout: one directory per native
// collector (`actions/download-artifact` with a pattern), each holding its own report.json and an
// `artifacts/<fingerprint>/<profile>/` tree. The Windows collector writes report-relative paths
// with `\` separators because it ran `path.relative` on win32.
const COLLECTORS: readonly { dir: string; platform: Platform; separator: string }[] = [
  { dir: "projective-owner-macOS", platform: "darwin", separator: "/" },
  { dir: "projective-owner-Linux", platform: "linux", separator: "/" },
  { dir: "projective-owner-Windows", platform: "win32", separator: "\\" },
];

async function png(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } })
    .png()
    .toBuffer();
}

function report(platform: Platform, path: string, sha256: string): ProjectiveOwnerReleaseReport {
  return {
    schemaVersion: 2,
    environment: {
      platform,
      architecture: "x64",
      osRelease: "release",
      runnerImage: `${platform}-image`,
      runnerImageVersion: "1",
      chromiumVersion: "147",
      chromiumRevision: "pin",
      playwrightVersion: "1.59",
      launchArguments: [],
    },
    rows: [
      {
        family: "shared-context",
        profile: "horizontal-ltr-static",
        dpr: 1,
        expectedOwnerIds: ["owner"],
        actualOwnerIds: ["owner"],
        rasterCount: 1,
        directImageApplications: 1,
        nestedDuplicateCount: 0,
        sampledApproximationCount: 0,
        vectorSentinelExact: true,
        sentinelBakedIntoRaster: false,
        restorationExact: true,
        warnings: [],
        maxFinalPixelDelta: 0,
        artifacts: [
          {
            role: "source",
            path,
            sha256,
            pngWidth: 4,
            pngHeight: 3,
            deviceRect: { x: 0, y: 0, width: 4, height: 3 },
            sourceFrameDeviceRect: { x: 0, y: 0, width: 4, height: 3 },
          },
        ],
        pass: true,
      },
    ],
    mutations: [],
  };
}

let root: string;
let bytes: Buffer;
let digest: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "projective-owner-tree-"));
  bytes = await png(4, 3);
  digest = createHash("sha256").update(bytes).digest("hex");
  for (const { dir, platform, separator } of COLLECTORS) {
    const segments = [
      "artifacts",
      `${platform}-x64-${platform}-image-1-pin`,
      "horizontal-ltr-static",
      "source-dpr1.png",
    ];
    await mkdir(join(root, dir, ...segments.slice(0, -1)), { recursive: true });
    await writeFile(join(root, dir, ...segments), bytes);
    await writeFile(join(root, dir, "report.json"), JSON.stringify(report(platform, segments.join(separator), digest)));
  }
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function verifyTree(): Promise<string[]> {
  const out: string[] = [];
  for (const path of await findProjectiveOwnerReports(root)) {
    out.push(...(await verifyProjectiveOwnerArtifacts(path, JSON.parse(await readFile(path, "utf8")))));
  }
  return out;
}

describe("projective owner artifact integrity over the aggregated three-platform tree", () => {
  it("finds one report per native collector", async () => {
    expect((await findProjectiveOwnerReports(root)).length).toBe(3);
  });

  it("reads every collector's artifacts, including Windows backslash-relative paths", async () => {
    expect(await verifyTree()).toEqual([]);
  });

  it("still reports genuine integrity failures in the aggregated tree", async () => {
    await writeFile(
      join(root, "projective-owner-Windows", "report.json"),
      JSON.stringify(report("win32", "artifacts\\missing.png", digest)),
    );
    await writeFile(
      join(root, "projective-owner-Linux", "report.json"),
      JSON.stringify(
        report("linux", "artifacts/linux-x64-linux-image-1-pin/horizontal-ltr-static/source-dpr1.png", "b".repeat(64)),
      ),
    );
    expect(await verifyTree()).toEqual(["shared-context: SHA mismatch", "shared-context: artifact unreadable"]);
  });

  it("refuses artifacts that escape their own report directory under either separator", async () => {
    for (const path of [
      "..\\projective-owner-Linux\\x.png",
      "../x.png",
      "C:\\x.png",
      "/etc/x.png",
      "\\\\host\\x.png",
    ]) {
      const reportPath = join(root, "projective-owner-Windows", "report.json");
      expect(await verifyProjectiveOwnerArtifacts(reportPath, report("win32", path, digest))).toEqual([
        "shared-context: artifact escapes report root",
      ]);
    }
  });

  it("normalizes both separators into path segments", () => {
    expect(portableArtifactSegments("artifacts\\fp\\p.png")).toEqual(["artifacts", "fp", "p.png"]);
    expect(portableArtifactSegments("./artifacts/fp//p.png")).toEqual(["artifacts", "fp", "p.png"]);
    expect(portableArtifactSegments("a/../b.png")).toBeUndefined();
    expect(portableArtifactSegments(".")).toBeUndefined();
  });
});

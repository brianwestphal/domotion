import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { readReportData, writeReport } from "../tools/lib/report.js";
import {
  checkNativeScrollbarRelease,
  readNativeScrollbarAuditReport,
} from "../tools/check-native-scrollbar-release.js";
import {
  adjudicateNativeScrollbarReports,
  SCROLLBAR_GATE_DPRS,
  SCROLLBAR_GATE_PLATFORMS,
  SCROLLBAR_GATE_SCENARIOS,
  SCROLLBAR_GATE_SOURCE_REVISIONS,
  SCROLLBAR_GATE_ZOOMS,
  type NativeScrollbarAuditReport,
  NATIVE_SCROLLBAR_AUDIT_ENVELOPE_VERSION,
  NATIVE_SCROLLBAR_AUDIT_REPORT_TOOL,
  nativeScrollbarAuditEnvelopeDataSchema,
  nativeScrollbarAuditLegacyDataSchema,
} from "../tools/native-scrollbar-release-gate.js";
import { scrollbarAuditSceneGeometry } from "../tools/native-scrollbar-ownership-audit.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function report(
  platform: (typeof SCROLLBAR_GATE_PLATFORMS)[number],
  evidenceRole: "proposal" | "validation",
): NativeScrollbarAuditReport {
  const rows = SCROLLBAR_GATE_SCENARIOS.flatMap((id) =>
    SCROLLBAR_GATE_DPRS.flatMap((deviceScaleFactor) =>
      SCROLLBAR_GATE_ZOOMS.map((cssZoom) => ({
        id,
        axis: `${id} exact ownership`,
        expectedRoute: id.startsWith("custom-")
          ? ("custom-vector" as const)
          : id.startsWith("native-")
            ? ("native-raster" as const)
            : id === "width-none-scrolled" || id === "native-stable-both-edges"
              ? ("suppressed-captured-absence" as const)
              : ("marker-free-control" as const),
        deviceScaleFactor,
        cssZoom,
        captured: { missingFacts: [] },
        warnings: [],
        pass: true as const,
        artifacts: [
          {
            role: "source" as const,
            path: `artifacts/${id}-source.png`,
            sha256: "1".repeat(64),
            pngWidth: 10,
            pngHeight: 10,
          },
          {
            role: "generated" as const,
            path: `artifacts/${id}-generated.png`,
            sha256: "2".repeat(64),
            pngWidth: 10,
            pngHeight: 10,
          },
        ],
      })),
    ),
  );
  const artifactManifest = rows.flatMap((row) =>
    row.artifacts.map((artifact) => ({ row: `${row.id}@${row.deviceScaleFactor}x/z${row.cssZoom}`, ...artifact })),
  );
  return {
    schemaVersion: 2,
    evidenceRole,
    observationId: randomUUID(),
    provenance: {
      githubRunId: "42",
      githubRunAttempt: "1",
      githubJob: `${platform}-${evidenceRole}`,
      runnerName: `${platform}-${evidenceRole}`,
      runnerImage: `${platform}-image`,
      runnerImageVersion: "20260824.1",
      workflowRef: "owner/repo/.github/workflows/native-scrollbar-parity.yml@sha",
      bootId: `${platform}-${evidenceRole}-boot`,
    },
    logicalRowsSha256: hash(
      rows.map(({ id, axis, expectedRoute, deviceScaleFactor, cssZoom, captured }) => ({
        id,
        axis,
        expectedRoute,
        deviceScaleFactor,
        cssZoom,
        captured,
      })),
    ),
    rowSetSha256: hash(rows),
    artifactSetSha256: hash(artifactManifest),
    dynamicFadeClassification: "separate-platform-terminal-not-observed",
    browserLaunch: { headless: true, ignoredDefaultArguments: ["--hide-scrollbars"] },
    chromiumExecutableSha256: "3".repeat(64),
    sourceRevisions: SCROLLBAR_GATE_SOURCE_REVISIONS,
    host: { platform, architecture: "x64", release: "release" },
    chromiumVersion: "147",
    playwrightVersion: "1.59.1",
    rows,
    controls: { exact: true },
    mutations: { active: true },
    platformFingerprints: [],
    verdict: "authoritative-capture-and-source-owned-paint-exact",
  };
}
function complete(): NativeScrollbarAuditReport[] {
  return SCROLLBAR_GATE_PLATFORMS.flatMap((platform) => {
    const proposal = report(platform, "proposal");
    const validation = report(platform, "validation");
    validation.logicalRowsSha256 = proposal.logicalRowsSha256;
    return [proposal, validation];
  });
}

describe("native scrollbar six-role release adjudicator", () => {
  it("reads envelope and reviewed flat v2 reports, preserving domain hashes", () => {
    const dir = mkdtempSync(join(tmpdir(), "native-scrollbar-envelope-"));
    const flat = report("darwin", "proposal");
    const legacyPath = join(dir, "legacy.json");
    const envelopePath = join(dir, "envelope.json");
    writeFileSync(legacyPath, JSON.stringify(flat));
    writeReport(
      envelopePath,
      NATIVE_SCROLLBAR_AUDIT_REPORT_TOOL,
      { ...flat, outcome: "pass" },
      {
        schemaVersion: NATIVE_SCROLLBAR_AUDIT_ENVELOPE_VERSION,
        env: flat.host,
      },
    );
    expect(readNativeScrollbarAuditReport(legacyPath)).toEqual(flat);
    expect(readNativeScrollbarAuditReport(envelopePath)).toEqual(flat);
    expect(
      readReportData(envelopePath, nativeScrollbarAuditEnvelopeDataSchema, {
        tool: NATIVE_SCROLLBAR_AUDIT_REPORT_TOOL,
        schemaVersion: 1,
        legacySchema: nativeScrollbarAuditLegacyDataSchema,
        legacySchemaVersion: 2,
      }).outcome,
    ).toBe("pass");
    writeReport(
      envelopePath,
      NATIVE_SCROLLBAR_AUDIT_REPORT_TOOL,
      { ...flat, outcome: "fail" },
      {
        schemaVersion: 1,
        env: flat.host,
      },
    );
    expect(() => readNativeScrollbarAuditReport(envelopePath)).toThrow(/not release evidence/);
    const unknownEnvelope = { ...JSON.parse(readFileSync(envelopePath, "utf8")), schemaVersion: 3 };
    writeFileSync(envelopePath, JSON.stringify(unknownEnvelope));
    expect(() => readNativeScrollbarAuditReport(envelopePath)).toThrow();
    writeFileSync(legacyPath, JSON.stringify({ ...flat, schemaVersion: 3 }));
    expect(() => readNativeScrollbarAuditReport(legacyPath)).toThrow(/unsupported legacy/);
  });

  it("resolves nested report-relative PNG paths and rejects escapes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "native-scrollbar-nested-"));
    const reportDir = join(dir, "nested", "proposal");
    const stripDir = join(reportDir, "strips");
    mkdirSync(stripDir, { recursive: true });
    const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: "red" } })
      .png()
      .toBuffer();
    const evidence = report("darwin", "proposal");
    evidence.rows = [evidence.rows[0]];
    for (const artifact of evidence.rows[0].artifacts) {
      artifact.path = `strips\\${artifact.role}.png`;
      artifact.sha256 = createHash("sha256").update(png).digest("hex");
      artifact.pngWidth = 2;
      artifact.pngHeight = 2;
      writeFileSync(join(stripDir, `${artifact.role}.png`), png);
    }
    evidence.rowSetSha256 = hash(evidence.rows);
    evidence.logicalRowsSha256 = hash(
      evidence.rows.map(({ id, axis, expectedRoute, deviceScaleFactor, cssZoom, captured }) => ({
        id,
        axis,
        expectedRoute,
        deviceScaleFactor,
        cssZoom,
        captured,
      })),
    );
    evidence.artifactSetSha256 = hash(
      evidence.rows.flatMap((row) =>
        row.artifacts.map((artifact) => ({ row: `${row.id}@${row.deviceScaleFactor}x/z${row.cssZoom}`, ...artifact })),
      ),
    );
    const reportPath = join(reportDir, "report.json");
    const save = () =>
      writeReport(
        reportPath,
        NATIVE_SCROLLBAR_AUDIT_REPORT_TOOL,
        { ...evidence, outcome: "pass" },
        {
          schemaVersion: 1,
          env: evidence.host,
        },
      );
    save();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await checkNativeScrollbarRelease(["--reports", dir, "--report-only"])).toBe(0);
      expect(log.mock.calls.flat().join("\n")).not.toMatch(/strip artifact|path escapes/);
      log.mockClear();
      evidence.rows[0].artifacts[0].path = "..\\outside.png";
      evidence.rowSetSha256 = hash(evidence.rows);
      evidence.artifactSetSha256 = hash(
        evidence.rows.flatMap((row) =>
          row.artifacts.map((artifact) => ({
            row: `${row.id}@${row.deviceScaleFactor}x/z${row.cssZoom}`,
            ...artifact,
          })),
        ),
      );
      save();
      expect(await checkNativeScrollbarRelease(["--reports", dir, "--report-only"])).toBe(0);
      expect(log.mock.calls.flat().join("\n")).toMatch(/artifact path escapes its report directory/);
    } finally {
      log.mockRestore();
    }
  });
  it("labels artifact integrity failures from the schema-v2 host identity", () => {
    const source = readFileSync("tools/check-native-scrollbar-release.ts", "utf8");
    expect(source).toContain("parsed.data.host.platform");
    expect(source).not.toContain("parsed.data.environment.platform");
    expect(source).toContain('artifact.path.replaceAll("\\\\", "/")');
  });
  it("accepts a complete independent and hash-authenticated Cartesian set", () => {
    expect(adjudicateNativeScrollbarReports(complete())).toMatchObject({ ready: true, blockers: [] });
  });
  it("rejects missing roles, corrupt canonical hashes, and artifact corruption", () => {
    const reports = complete().slice(0, 5);
    reports[0].rowSetSha256 = "f".repeat(64);
    const result = adjudicateNativeScrollbarReports(reports, [], ["darwin/proposal: artifact SHA mismatch"]);
    expect(result.blockers.join("\n")).toMatch(
      /missing role-bound report|canonical row-set hash mismatch|artifact SHA mismatch/,
    );
  });
  it("rejects reused boot identities, observations, and logical drift", () => {
    const reports = complete();
    const proposal = reports[0];
    const validation = reports[1];
    validation.observationId = proposal.observationId;
    validation.provenance.bootId = proposal.provenance.bootId;
    validation.logicalRowsSha256 = "e".repeat(64);
    expect(adjudicateNativeScrollbarReports(reports).blockers.join("\n")).toMatch(
      /observation ids|boot ids|logical rows disagree/,
    );
  });
  it("allows hosted image patch rollover only when stable identity and logical rows agree", () => {
    const reports = complete();
    const proposal = reports[0];
    const validation = reports[1];
    validation.provenance.runnerImageVersion = "20260901.2";
    validation.host.release = "26.6.0";
    expect(adjudicateNativeScrollbarReports(reports).ready).toBe(true);
    validation.provenance.runnerImage = "different-image-family";
    expect(adjudicateNativeScrollbarReports(reports).blockers.join("\n")).toMatch(
      /stable environment identities differ/,
    );
  });
  it("rejects observational schemas and inactive controls", () => {
    const reports = complete();
    reports[0].controls.exact = false;
    const result = adjudicateNativeScrollbarReports([{}, ...reports]);
    expect(result.blockers.join("\n")).toMatch(/schema v2 rejected|controls are not all active/);
  });
});

describe("native scrollbar Cartesian scene", () => {
  it("keeps every release zoom fully inside the authenticated viewport", () => {
    for (const zoom of SCROLLBAR_GATE_ZOOMS) {
      const scene = scrollbarAuditSceneGeometry(zoom);
      expect(scene.clip.x + scene.clip.width).toBeLessThanOrEqual(scene.viewport.width);
      expect(scene.clip.y + scene.clip.height).toBeLessThanOrEqual(scene.viewport.height);
      expect(scene.targetVisual.width).toBeLessThan(scene.clip.width);
      expect(scene.targetVisual.height).toBeLessThan(scene.clip.height);
    }
  });

  it("rejects off-contract zooms instead of silently clipping the probe", () => {
    expect(() => scrollbarAuditSceneGeometry(0)).toThrow(/unsupported scrollbar audit zoom/);
    expect(() => scrollbarAuditSceneGeometry(2.01)).toThrow(/unsupported scrollbar audit zoom/);
  });
});

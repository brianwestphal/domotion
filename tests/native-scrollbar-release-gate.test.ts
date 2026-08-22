import { describe, expect, it } from "vitest";
import {
  adjudicateNativeScrollbarReports,
  SCROLLBAR_GATE_DPRS,
  SCROLLBAR_GATE_PLATFORMS,
  SCROLLBAR_GATE_SCENARIOS,
  SCROLLBAR_GATE_SOURCE_REVISIONS,
  SCROLLBAR_GATE_ZOOMS,
  type NativeScrollbarAuditReport,
  type NativeScrollbarAuditRow,
  type NativeScrollbarRasterEnvelope,
} from "../tools/native-scrollbar-release-gate.js";

const SOURCE_SHA = "1".repeat(64);
const GENERATED_SHA = "2".repeat(64);

function routeFor(id: string): NativeScrollbarAuditRow["expectedRoute"] {
  if (id.startsWith("custom-")) return "custom-vector";
  if (id.startsWith("native-")) return "native-raster";
  return id === "width-none-scrolled" ? "suppressed-captured-absence" : "marker-free-control";
}

function artifact(role: "source" | "generated", part: "horizontal" | "vertical" | "corner", sha256: string) {
  return {
    role, part, path: `artifacts/${role}-${part}.png`, sha256,
    pngWidth: 10, pngHeight: 10,
    deviceRect: { x: 5, y: 5, width: 10, height: 10 },
    sourceFrameDeviceRect: { x: 0, y: 0, width: 20, height: 20 },
    sourceClipDeviceRect: { x: 0, y: 0, width: 20, height: 20 },
  } as const;
}

function fixtureRow(id: typeof SCROLLBAR_GATE_SCENARIOS[number], deviceScaleFactor: 1 | 2, cssZoom: 1 | 1.25 | 2): NativeScrollbarAuditRow {
  const expectedRoute = routeFor(id);
  const paint = expectedRoute === "custom-vector" || expectedRoute === "native-raster";
  const noInk = id === "native-overlay-rest" || id === "native-overlay-fade";
  const thumbY = id === "custom-y-top" ? 3 : id === "custom-y-mid" ? 9 : id === "custom-y-max" ? 15 : 7;
  const markers = expectedRoute === "custom-vector"
    ? {
        track: { x: 2, y: 2, width: 12, height: 40, pixels: 480 },
        thumb: { x: 4, y: thumbY, width: 8, height: 10, pixels: 80 },
        ...(id.includes("corner") || id.includes("resizer")
          ? { corner: { x: 14, y: 42, width: 8, height: 8, pixels: 64 } }
          : {}),
      }
    : {};
  const sourceSha = expectedRoute === "native-raster" ? SOURCE_SHA : SOURCE_SHA;
  const generatedSha = expectedRoute === "native-raster" ? SOURCE_SHA : GENERATED_SHA;
  return {
    id, deviceScaleFactor, cssZoom, expectedRoute,
    capturedStatus: paint ? "captured" : "absent",
    missingFacts: [], warnings: [],
    sourcePixels: {
      markerPixels: Object.values(markers).reduce((sum, value) => sum + value.pixels, 0),
      markers,
      vectorSentinel: { x: 230, y: 12, width: 16, height: 13, pixels: 208 },
    },
    generatedPixels: {
      markerPixels: Object.values(markers).reduce((sum, value) => sum + value.pixels, 0),
      markers: structuredClone(markers),
      vectorSentinel: { x: 230, y: 12, width: 16, height: 13, pixels: 208 },
    },
    artifacts: paint && !noInk
      ? [artifact("source", "vertical", sourceSha), artifact("generated", "vertical", generatedSha)]
      : [],
    noInk,
    legacyPillCount: 0,
    outputTransformApplications: paint ? 1 : 0,
    paintOrder: id === "custom-resizer-overlap"
      ? ["horizontal", "vertical", "corner", "resizer"]
      : ["horizontal", "vertical", "corner"],
    sourceState: {
      platformMode: id.includes("overlay") ? "overlay" : "classic",
      scheme: id.includes("dark") ? "dark" : "light",
      forcedColors: id.includes("forced"),
      scrollOffset: id === "custom-rtl-logical-left" ? -47 : id.includes("mid") ? 60 : id.includes("max") ? 120 : 0,
      logicalSide: id === "custom-rtl-logical-left" ? "left" : paint ? "right" : "none",
    },
    pass: true,
  };
}

function fixtureReport(platform: typeof SCROLLBAR_GATE_PLATFORMS[number]): NativeScrollbarAuditReport {
  const rows = SCROLLBAR_GATE_SCENARIOS.flatMap((id) => SCROLLBAR_GATE_DPRS.flatMap((deviceScaleFactor) =>
    SCROLLBAR_GATE_ZOOMS.map((cssZoom) => fixtureRow(id, deviceScaleFactor, cssZoom))));
  return {
    schemaVersion: 2,
    sourceRevisions: SCROLLBAR_GATE_SOURCE_REVISIONS,
    environment: {
      platform,
      architecture: platform === "darwin" ? "arm64" : "x64",
      osRelease: `${platform}-release`,
      runnerImage: `${platform}-image`,
      runnerImageVersion: "20260822.1",
      chromiumVersion: "147.0.7727.15",
      chromiumRevision: "stable-1234567",
      playwrightVersion: "1.59.1",
      launchArguments: ["--headless"],
      ignoredDefaultArguments: ["--hide-scrollbars"],
      hideScrollbarsDefaultRemoved: true,
      scrollbarPreference: "classic",
    },
    matrix: { deviceScaleFactors: [...SCROLLBAR_GATE_DPRS], cssZooms: [...SCROLLBAR_GATE_ZOOMS] },
    rows,
  };
}

function completeReports(): NativeScrollbarAuditReport[] {
  return SCROLLBAR_GATE_PLATFORMS.map(fixtureReport);
}

function row(report: NativeScrollbarAuditReport, id: string): NativeScrollbarAuditRow {
  return report.rows.find((candidate) => candidate.id === id
    && candidate.deviceScaleFactor === 1 && candidate.cssZoom === 1)!;
}

describe("DM-2484 native scrollbar release adjudicator", () => {
  it("accepts a complete exact same-run three-platform matrix", () => {
    expect(adjudicateNativeScrollbarReports(completeReports())).toMatchObject({ ready: true, blockers: [] });
  });

  it("rejects the observational DM-2481 report schema instead of relabeling it green", () => {
    const result = adjudicateNativeScrollbarReports([{ sourceRevisions: SCROLLBAR_GATE_SOURCE_REVISIONS, rows: [] }]);
    expect(result.ready).toBe(false);
    expect(result.blockers.join("\n")).toMatch(/schema v2 rejected|missing native platform/);
  });

  it("fails partial/warning/missing-fact expected-gap rows", () => {
    const reports = completeReports();
    const target = row(reports[0], "custom-y-mid");
    target.expectedRoute = "custom-vector-current-gap";
    target.capturedStatus = "partial";
    target.warnings.push("dynamic cascade unavailable");
    target.missingFacts.push("dynamic-scrollbar-pseudo-cascade");
    expect(adjudicateNativeScrollbarReports(reports).blockers.join("\n"))
      .toMatch(/expected-gap route|not captured|warnings are forbidden|missing facts/);
  });

  it("fails missing strips/parts and a crop escaping its source frame by one pixel", () => {
    const reports = completeReports();
    const target = row(reports[0], "native-auto-light");
    target.artifacts = target.artifacts.filter(({ role }) => role === "source");
    const crop = row(reports[1], "native-auto-light").artifacts[0];
    crop.deviceRect.x = 11;
    expect(adjudicateNativeScrollbarReports(reports).blockers.join("\n"))
      .toMatch(/missing generated strip crop|crop escapes its source-owned frame/);
  });

  it("fails double transforms, wrong corner order, frozen thumbs, and the legacy pill", () => {
    const reports = completeReports();
    row(reports[0], "custom-affine-transform").outputTransformApplications = 2;
    row(reports[0], "custom-resizer-overlap").paintOrder = ["resizer", "corner"];
    row(reports[0], "custom-y-mid").generatedPixels.markers.thumb!.y = 3;
    row(reports[0], "native-auto-light").legacyPillCount = 1;
    expect(adjudicateNativeScrollbarReports(reports).blockers.join("\n"))
      .toMatch(/more than once|corner must paint before|thumb is frozen|legacy 7px/);
  });

  it("fails custom marker-class drift and a greater-than-one-device-pixel bound delta", () => {
    const reports = completeReports();
    const target = row(reports[0], "custom-y-mid");
    target.generatedPixels.markers.extra = { x: 0, y: 0, width: 2, height: 2, pixels: 4 };
    target.generatedPixels.markers.thumb!.x += 2;
    expect(adjudicateNativeScrollbarReports(reports).blockers.join("\n"))
      .toMatch(/marker classification differs|bound delta exceeds 1 device pixel/);
  });

  it("never shares a native raster envelope across fingerprints", () => {
    const reports = completeReports();
    const target = row(reports[0], "native-auto-light");
    target.artifacts.find(({ role }) => role === "generated")!.sha256 = GENERATED_SHA;
    const environment = reports[0].environment;
    const envelope: NativeScrollbarRasterEnvelope = {
      id: "reviewed-on-wrong-image",
      reviewed: true,
      platform: environment.platform,
      architecture: environment.architecture,
      runnerImage: "different-image",
      runnerImageVersion: environment.runnerImageVersion,
      chromiumRevision: environment.chromiumRevision,
      rowId: target.id,
      deviceScaleFactor: target.deviceScaleFactor,
      cssZoom: target.cssZoom,
      part: "vertical",
      allowedPairs: [{ sourceSha256: SOURCE_SHA, generatedSha256: GENERATED_SHA }],
    };
    expect(adjudicateNativeScrollbarReports(reports, [envelope]).blockers.join("\n"))
      .toMatch(/without a reviewed platform\/fingerprint-specific envelope/);
  });

  it("fails a missing platform and externally verified artifact corruption", () => {
    const reports = completeReports().slice(0, 2);
    const result = adjudicateNativeScrollbarReports(reports, [], ["darwin/custom-y-top: SHA mismatch"]);
    expect(result.blockers).toContain("missing native platform report: win32");
    expect(result.blockers).toContain("darwin/custom-y-top: SHA mismatch");
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readUnicodeFontRouteReport,
  writeUnicodeFontRouteReport,
  type UnicodeFontRouteArtifact,
} from "../tools/unicode-font-route-report.js";

const artifact: UnicodeFontRouteArtifact = {
  schemaVersion: 2,
  generatedAt: "2026-09-02T02:00:16.464Z",
  platform: "win32",
  fixture: "C:\\fixtures\\unicode.html",
  cells: [
    {
      selector: "x:nth-of-type(1) > g",
      cp: 0x2603,
      text: "☃",
      fontFamily: "Segoe UI Symbol, sans-serif",
      chrome: { familyName: "Segoe UI Symbol", glyphId: 42 },
      hardcoded: { priority: "text", candidates: [] },
      directWrite: { answer: null },
      domotion: { routeKey: "winfam:Segoe UI Symbol", glyphId: 42 },
    },
  ],
};

describe("Windows Unicode font-route report", () => {
  it("writes a versioned envelope while preserving inner v2 facts", () => {
    const directory = mkdtempSync(join(tmpdir(), "unicode-route-report-"));
    try {
      const path = join(directory, "route.json");
      writeUnicodeFontRouteReport(path, artifact);
      const saved = JSON.parse(readFileSync(path, "utf8"));
      expect(saved).toMatchObject({
        schemaVersion: 1,
        tool: "unicode-font-route-trace",
        env: { platform: "win32" },
        data: { ...artifact, outcome: "pass" },
      });
      expect(readUnicodeFontRouteReport(path)).toEqual(artifact);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts explicit flat v2 and rejects unknown versions, wrong tools, and non-pass outcomes", () => {
    const directory = mkdtempSync(join(tmpdir(), "unicode-route-legacy-"));
    try {
      const path = join(directory, "route.json");
      writeFileSync(path, JSON.stringify(artifact));
      expect(readUnicodeFontRouteReport(path)).toEqual(artifact);
      writeUnicodeFontRouteReport(path, artifact);
      const envelope = JSON.parse(readFileSync(path, "utf8"));
      for (const bad of [
        { ...artifact, schemaVersion: 3 },
        { ...envelope, schemaVersion: 2 },
        { ...envelope, tool: "other" },
        { ...envelope, data: { ...artifact, outcome: "fail" } },
        { ...envelope, data: { ...artifact, schemaVersion: 3, outcome: "pass" } },
        { ...envelope, data: { ...artifact, cells: [{ cp: "not-a-number" }], outcome: "pass" } },
      ]) {
        writeFileSync(path, JSON.stringify(bad));
        expect(() => readUnicodeFontRouteReport(path)).toThrow();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

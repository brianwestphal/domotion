import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  LINUX_TERMINAL_MASK_CASES,
  LINUX_TERMINAL_MASK_VARIANTS,
  linuxTerminalMaskMatrix,
  validateLinuxTerminalMaskResults,
} from "../tools/linux-terminal-mask-oracle.js";

describe("Linux terminal-mask oracle contract (DM-2623)", () => {
  it("covers the ticket surfaces and fallback-stack controls at every quarter-pixel phase", () => {
    const matrix = linuxTerminalMaskMatrix();
    expect(LINUX_TERMINAL_MASK_CASES.map((testCase) => testCase.id)).toEqual([
      "ui-meta-13", "mono-label-17", "ui-header-20", "ui-cjk-32",
      "freesans-malayalam-32", "unifont-malayalam-32",
    ]);
    expect(matrix).toHaveLength(96);
    for (const testCase of LINUX_TERMINAL_MASK_CASES) {
      const rows = matrix.filter((row) => row.id === testCase.id);
      expect(new Set(rows.map((row) => `${row.phaseX},${row.phaseY}`))).toEqual(new Set([
        "0,0", "0.25,0", "0.5,0", "0.75,0",
        "0,0.25", "0.25,0.25", "0.5,0.25", "0.75,0.25",
        "0,0.5", "0.25,0.5", "0.5,0.5", "0.75,0.5",
        "0,0.75", "0.25,0.75", "0.5,0.75", "0.75,0.75",
      ]));
    }
  });

  it("uses native rendering only as a reference and keeps every candidate embedded", () => {
    expect(LINUX_TERMINAL_MASK_VARIANTS[0]).toMatchObject({ id: "native-reference", embedded: false });
    expect(LINUX_TERMINAL_MASK_VARIANTS.slice(1).every((variant) => variant.embedded)).toBe(true);
    expect(LINUX_TERMINAL_MASK_VARIANTS.slice(1).every((variant) => variant.bytes != null)).toBe(true);
  });

  it("deconfounds cmap, hinting, and each browser-controlled text-rendering arm", () => {
    expect(LINUX_TERMINAL_MASK_VARIANTS.map((variant) => variant.id)).toEqual([
      "native-reference",
      "source-cmap-webfont",
      "pua-only",
      "pua-with-source-cmap",
      "pua-production-policy",
      "pua-target-hinted-full",
      "pua-target-hinted-y",
      "pua-geometric-precision",
      "pua-optimize-legibility",
      "pua-optimize-speed",
      "pua-no-hinting",
    ]);
  });

  it("runs the causal gate in the pinned Linux fidelity workflow", () => {
    const workflow = readFileSync(".github/workflows/test-linux.yml", "utf8");
    const scripts = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(scripts.scripts["fonts:linux-terminal-mask"]).toBe("tsx tools/linux-terminal-mask-oracle.ts");
    expect(workflow).toContain("npm run fonts:linux-terminal-mask -- --gate");
    expect(workflow).toContain("mcr.microsoft.com/playwright:v1.59.1-noble");
  });

  it("gates the causal result without pinning architecture-specific percentages", () => {
    const row = (id: string, diffPct: number, sha256: string, deltas: number[], embedded = true) => ({
      id, embedded, sha256, global: { diffPct },
      cases: LINUX_TERMINAL_MASK_CASES.map((testCase, index) => ({
        id: testCase.id,
        totalChannelDelta: deltas[index],
        phases: [{ phaseX: 0, phaseY: 0, totalChannelDelta: deltas[index] }],
      })),
    });
    const controlDeltas = [100, 200, 300, 400, 0, 0];
    const results = [
      { id: "native-reference", embedded: false, sha256: "native" },
      row("source-cmap-webfont", 0.23, "control", controlDeltas),
      row("pua-only", 0.23, "control", controlDeltas),
      row("pua-with-source-cmap", 0.23, "control", controlDeltas),
      row("pua-production-policy", 0.18, "production", [70, 80, 250, 300, 0, 0]),
      row("pua-target-hinted-full", 0.17, "target-full", [70, 1, 250, 300, 0, 0]),
      row("pua-target-hinted-y", 0.17, "target-y", [70, 1, 250, 300, 0, 0]),
      row("pua-geometric-precision", 0.22, "geometric", [70, 80, 250, 300, 50, 60]),
      row("pua-optimize-legibility", 0.23, "control", controlDeltas),
      row("pua-optimize-speed", 0.23, "control", controlDeltas),
      row("pua-no-hinting", 0.25, "unhinted", [101, 201, 301, 500, 1, 1]),
    ];
    expect(validateLinuxTerminalMaskResults(results)).toEqual([]);
    results[4] = row("pua-production-policy", 0.20, "production", [70, 210, 250, 300, 1, 0]);
    expect(validateLinuxTerminalMaskResults(results)).toEqual([
      "production-policy aggregate improvement is below 15% (0.23 -> 0.2)",
      "mono-label-17: production policy did not reduce terminal-mask delta",
      "mono-label-17: production phase 0,0 regressed terminal-mask delta",
      "freesans-malayalam-32: excluded production face moved",
    ]);
  });
});

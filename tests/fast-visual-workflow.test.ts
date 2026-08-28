import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = readFileSync(
  resolve(__dirname, "..", ".github", "workflows", "fast-visual-tests.yml"),
  "utf8",
);
const driver = readFileSync(
  resolve(__dirname, "..", "scripts", "ci-run-fast-visuals.mjs"),
  "utf8",
);
const baselineDriver = readFileSync(
  resolve(__dirname, "..", "scripts", "ci-fast-baselines.mjs"),
  "utf8",
);

describe("all-platform fast visual workflow", () => {
  const jobs = (() => {
    const parsed: Record<string, string> = {};
    let current: string | null = null;
    let lines: string[] = [];
    for (const line of workflow.split("\n")) {
      const match = /^ {2}([a-zA-Z0-9_-]+):\s*$/.exec(line);
      if (match != null) {
        if (current != null) parsed[current] = lines.join("\n");
        current = match[1];
        lines = [];
      } else if (current != null) lines.push(line);
    }
    if (current != null) parsed[current] = lines.join("\n");
    return parsed;
  })();

  it("runs on all three supported platforms with their native helper", () => {
    expect(workflow).toContain("test-macos:");
    expect(workflow).toContain("macos-glyph-extractor");
    expect(workflow).toContain("test-linux:");
    expect(workflow).toContain("linux-glyph-extractor");
    expect(workflow).toContain("test-windows:");
    expect(workflow).toContain("win32-glyph-extractor");
  });

  it("caps every job so a runner defect cannot consume capacity indefinitely", () => {
    expect(jobs["test-macos"]).toContain("timeout-minutes: 120");
    expect(jobs["test-linux"]).toContain("timeout-minutes: 120");
    expect(jobs["test-windows"]).toContain("timeout-minutes: 120");
  });

  it("records provenance before rendering and uploads evidence even after failure", () => {
    for (const os of ["macos", "linux", "windows"]) {
      const block = jobs[`test-${os}`];
      expect(block).toBeDefined();
      expect(block.indexOf("run-env.mjs")).toBeLessThan(block.indexOf("demos:test:ci-fast"));
      expect(block).toContain("continue-on-error: true");
      expect(block).toContain("if: always()");
      expect(block).toContain(`fast-visuals-${os}`);
    }
  });

  it("continues through and records every non-sharded demo suite", () => {
    for (const script of [
      "demos:test",
      "demos:test:showcase",
      "demos:test:snapshot-isolation",
      "demos:test:animate",
      "demos:test:real-world",
    ]) {
      expect(driver).toContain(`\"${script}\"`);
    }
    expect(driver).toContain("fast-visual-completeness.json");
    expect(driver).toContain("results.every");
    expect(driver).toContain('shell: process.platform === "win32"');
    expect(driver).toContain("run.error?.message");
  });

  it("compares committed per-platform baselines and can emit review candidates", () => {
    expect(workflow).toContain("update_baseline:");
    expect(workflow.match(/ci-fast-baselines\.mjs --os/g)).toHaveLength(3);
    expect(baselineDriver).toContain("diff-against-baseline.mjs");
    expect(baselineDriver).toContain("write-baseline.mjs");
    expect(baselineDriver).toContain("showcase-results.json");
    expect(baselineDriver).toContain('"real-world", "results.json"');
  });
});

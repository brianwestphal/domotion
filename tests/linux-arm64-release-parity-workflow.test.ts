import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/linux-arm64-release-parity.yml", "utf8");

describe("DM-2353 Linux arm64 release parity workflow", () => {
  it("runs only when requested on a native Noble arm64 release consumer", () => {
    expect(workflow).toMatch(/on:\s*\n\s*workflow_dispatch:/);
    expect(workflow).not.toMatch(/\n\s*(push|pull_request):/);
    expect(workflow).toContain("runs-on: ubuntu-22.04-arm");
    expect(workflow).toContain("mcr.microsoft.com/playwright:v1.59.1-noble");
    expect(workflow).toContain("node-version: 22.21.0");
    expect(workflow).toMatch(/defaults:\s*\n\s*run:\s*\n\s*shell: bash/);
    for (const [key, revision] of Object.entries({
      DOMOTION_CHROMIUM_REVISION: "7d859f271cbda744098ac69f44978d4edfa62be3",
      DOMOTION_HARFBUZZ_REVISION: "4de187dd0a915d13c976fa8bd474c084229f3aab",
      DOMOTION_SKIA_REVISION: "62efacd37737505732dbe3d8daa62abd679626a1",
      DOMOTION_ICU_SOURCE_REVISION: "d578f2e8b7bd5938e21cfb6bf15c079e0aa5b738",
    })) {
      expect(workflow).toContain(`${key}: ${revision}`);
    }
  });

  it("acquires published artifacts into a clean cache without building helpers", () => {
    expect(workflow).toContain("linux-arm64-release-evidence.ts acquire");
    expect(workflow).toContain("$RUNNER_TEMP");
    expect(workflow).toContain("--cache-root");
    expect(workflow).toContain("--github-env \"$GITHUB_ENV\"");
    expect(workflow).not.toMatch(/linux-glyph-extractor\/(build\.sh|CMakeLists)/);
    expect(workflow).not.toMatch(/icu-helper\/(build-unix|cmake)/i);
  });

  it("runs every required gate with no tolerance override", () => {
    for (const id of ["helper", "icu", "font_selection", "shaping", "decoration", "paint", "html", "unicode"]) {
      expect(workflow, `missing step id ${id}`).toMatch(new RegExp(`id: ${id}\\b`));
    }
    expect(workflow).toContain("assert-linux-helper-in-loop.ts");
    expect(workflow).toContain("icu-conformance.ts");
    expect(workflow.indexOf("font-conformance-synthetic-stacks.ts")).toBeLessThan(
      workflow.indexOf("font-conformance.ts"),
    );
    expect(workflow).toContain("font-conformance-stacks.synthetic.json");
    // The synthetic corpus defines 13 as exactly one CSS-initial row per
    // generic family. The 351-stack single-axis and 50,544-stack exhaustive
    // matrices belong to their dedicated conformance workflows; --max-rows
    // limits report examples, not execution.
    expect(workflow).toContain("--max-stacks 13");
    expect(workflow).toContain("--variable-control-fixture tests/fixtures/variable-axis/variable-axis.html");
    expect(workflow).toContain("--tracking-control-fixture tests/fixtures/exact-shaping/TRAK.ttf.base64");
    expect(workflow).toMatch(/name: Same-DPR decoration geometry oracle[\s\S]*node --import tsx tools\/decoration-oracle\.ts[\s\S]*--json "\$EVIDENCE_DIR\/decoration\.json"/);
    expect(workflow).not.toMatch(/decoration-oracle\.ts[^\n]*(--no-gate|--tolerance)/);
    expect(workflow).toContain("paint-geometry-browser-oracle.ts");
    expect(workflow).toContain("tests/html-test-suite.tsx");
    expect(workflow).not.toMatch(/--tolerance|--threshold|--max-diff|TOLERANCE\s*=/i);
  });

  it("preserves failed-leg evidence before enforcing the aggregate verdict", () => {
    expect(workflow.match(/continue-on-error: true/g)?.length).toBeGreaterThanOrEqual(10);
    expect(workflow).toContain("linux-arm64-release-evidence.ts finalize");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).toContain("include-hidden-files: true");
    expect(workflow).toContain("exact-arm64-release-parity");
    expect(workflow.indexOf("actions/upload-artifact@v4")).toBeLessThan(workflow.lastIndexOf("exact-arm64-release-parity"));
  });
});

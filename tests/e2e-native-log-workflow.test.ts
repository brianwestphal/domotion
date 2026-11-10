import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { expect, it } from "vitest";

type WorkflowStep = Record<string, unknown>;
function macOsBrowserSteps(): WorkflowStep[] {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
    jobs: Record<string, { steps: WorkflowStep[] }>;
  };
  const job = workflow.jobs["visual-macos"];
  expect(job).toBeDefined();
  return job!.steps;
}
function verifyProjectiveEvidence(steps: WorkflowStep[]): void {
  const producer = steps.find((step) => step["name"] === "Run browser-driven e2e tests (capture/layout assertions)");
  const upload = steps.find((step) => step["name"] === "Upload visual and browser-E2E results");
  expect(producer).toBeDefined();
  expect(upload).toBeDefined();
  expect(producer!["run"]).toBe("npm run test:e2e");
  for (const step of [producer!, upload!]) {
    expect(step["if"]).toBe("always()");
    expect([undefined, false]).toContain(step["continue-on-error"]);
  }
  expect(String(upload!["uses"])).toMatch(/^actions\/upload-artifact@/);
  const options = upload!["with"] as Record<string, unknown>;
  expect(
    String(options["path"])
      .split(/\r?\n/)
      .map((path) => path.trim()),
  ).toContain("tests/output/webgl-projective-preflight/");
  expect(options["if-no-files-found"]).toBe("error");
  expect(steps.indexOf(upload!)).toBeGreaterThan(steps.indexOf(producer!));
}

it("DM-1MVXDB: retains projective source PNG/JSON after ordinary browser failures", () => {
  verifyProjectiveEvidence(macOsBrowserSteps());
});
it("DM-1MVXDB: permits growing browser steps and artifact selections", () => {
  const grown = structuredClone(macOsBrowserSteps());
  grown.unshift({ name: "Additional native coverage", run: "echo synthetic-control" });
  const upload = grown.find((step) => step["name"] === "Upload visual and browser-E2E results")!;
  const options = upload["with"] as Record<string, unknown>;
  options["path"] = String(options["path"]) + "\ntests/output/additional-native-evidence/\n";
  verifyProjectiveEvidence(grown);
});
it.each(["missing-directory", "success-only-upload"])("DM-1MVXDB: rejects %s retention regression", (mutation) => {
  const changed = structuredClone(macOsBrowserSteps());
  const upload = changed.find((step) => step["name"] === "Upload visual and browser-E2E results")!;
  if (mutation === "success-only-upload") upload["if"] = "success()";
  else {
    const options = upload["with"] as Record<string, unknown>;
    options["path"] = String(options["path"])
      .split(/\r?\n/)
      .filter((path) => path.trim() !== "tests/output/webgl-projective-preflight/")
      .join("\n");
  }
  expect(() => verifyProjectiveEvidence(changed)).toThrow();
});

it("DM-95ECD3: retains filtered lane logs and source failure artifacts in the ordinary macOS lane", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const step = workflow
    .split("- name: Run browser-driven e2e tests (capture/layout assertions)")[1]
    .split("- name:")[0];
  expect(step).toContain("if: always()");
  expect(step).toContain("DOMOTION_E2E_NATIVE_LOG_DIR: tests/output/native-browser-logs");
  expect(step).toContain("run: npm run test:e2e");
  expect(step).not.toMatch(/DEBUG:|use-angle|DOMOTION_E2E_LANE:/);
  const upload = workflow.split("- name: Upload visual and browser-E2E results")[1].split(/\n  \S/)[0];
  expect(upload).toContain("if: always()");
  expect(upload).toContain("tests/output/native-browser-logs/");
  expect(upload).toContain("tests/output/webgl-startup-e2e/");
  expect(upload).toContain("tests/output/opaque-font-family/");
  expect(upload).toContain("tests/output/owned-ui-server/");
  const controls = workflow.split("- name: Upload owned UI process controls")[1].split(/\n  \S/)[0];
  expect(controls).toContain("if: always()");
  expect(controls).toContain("path: tests/output/owned-ui-server/");
});

it("DM-3CJSK2: runs strict process and UI controls and retains evidence on native platforms", () => {
  for (const [name, output] of [
    ["windows-fidelity.yml", "tests/output"],
    ["test-linux.yml", "tests/output-linux"],
  ]) {
    const workflow = readFileSync(`.github/workflows/${name}`, "utf8");
    for (const title of [
      "Verify owned UI process controls (DM-3CJSK2)",
      "Require every owned UI process assertion",
      "Verify native client UI lifecycle",
      "Require every native client UI assertion",
    ]) {
      const step = workflow.split(`- name: ${title}`)[1].split("- name:")[0];
      expect(step).toContain("if: always()");
    }
    expect(workflow).toContain(`--browser-results ${output}/owned-ui-server/controls.json --minimum-passed 13`);
    expect(workflow).toContain(`--browser-results ${output}/owned-ui-server/native-ui.json --minimum-passed 11`);
    expect(workflow).toContain(`            ${output}/owned-ui-server/`);
  }
});

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
type Step = Record<string, unknown>;
function contract(steps: Step[], root: string) {
  const producer = steps.find(
    (step) => step["name"] === "Verify native author-shadow capability ownership (DM-QKGJQ5)",
  );
  const gate = steps.find((step) => step["name"] === "Require every native author-shadow capability assertion");
  const upload = steps.find(
    (step) =>
      String(step["uses"]).startsWith("actions/upload-artifact@") &&
      String((step["with"] as Record<string, unknown>)?.["path"])
        .split(/\r?\n/)
        .map((path) => path.trim())
        .includes(`${root}/author-shadow-context/`),
  );
  expect(producer).toBeDefined();
  expect(gate).toBeDefined();
  expect(upload).toBeDefined();
  for (const step of [producer!, gate!, upload!]) {
    expect(step["if"]).toBe("always()");
    expect([undefined, false]).toContain(step["continue-on-error"]);
  }
  expect(producer!["run"]).toContain("tests/author-shadow-context.e2e.test.ts");
  expect(producer!["run"]).toContain(`--outputFile=${root}/author-shadow-context/results.json`);
  expect((producer!["env"] as Record<string, unknown>)["DOMOTION_OUTPUT_DIR"]).toBe(root);
  expect(gate!["run"]).toContain(`--browser-results ${root}/author-shadow-context/results.json --minimum-passed 32`);
  expect(steps.indexOf(upload!)).toBeGreaterThan(steps.indexOf(gate!));
}
describe.each([
  ["test-linux.yml", "tests/output-linux"],
  ["windows-fidelity.yml", "tests/output"],
])("%s author-context retention", (file, root) => {
  const workflow = parse(readFileSync(`.github/workflows/${file}`, "utf8")) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
  it("runs strict native assertions and retains evidence even on failure", () => contract(steps, root));
  it.each(["missing-artifact", "weakened-gate", "success-only"])("rejects %s regression", (mutation) => {
    const changed = structuredClone(steps);
    if (mutation === "weakened-gate") {
      const gate = changed.find((step) => step["name"] === "Require every native author-shadow capability assertion")!;
      gate["run"] = String(gate["run"]).replace("--minimum-passed 32", "--minimum-passed 1");
    } else
      for (const step of changed) {
        if (
          mutation === "success-only" &&
          step["name"] === "Verify native author-shadow capability ownership (DM-QKGJQ5)"
        )
          step["if"] = "success()";
        if (mutation === "missing-artifact" && String(step["uses"]).startsWith("actions/upload-artifact@")) {
          const options = step["with"] as Record<string, unknown>;
          options["path"] = String(options["path"])
            .split(/\r?\n/)
            .filter((path) => path.trim() !== `${root}/author-shadow-context/`)
            .join("\n");
        }
      }
    expect(() => contract(changed, root)).toThrow();
  });
});

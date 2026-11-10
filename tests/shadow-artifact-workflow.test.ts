import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

type Step = Record<string, unknown>;
const object = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
const platforms = [
  { file: "test-linux.yml", output: "tests/output-linux" },
  { file: "windows-fidelity.yml", output: "tests/output" },
];
function verifyShadowRetention(steps: Step[], output: string): void {
  const producer = steps.find((step) => step["name"] === "Verify native shadow knockout and root boundaries");
  const strict = steps.find((step) => step["name"] === "Require every native shadow assertion");
  const upload = steps.find((step) => step["name"] === "Upload expected/actual/diff PNGs");
  expect(producer).toBeDefined();
  expect(strict).toBeDefined();
  expect(upload).toBeDefined();
  const report = `${output}/shadow-knockout/results.json`;
  const run = String(producer!["run"]);
  expect(run).toContain("--reporter=json");
  expect(run).toContain(`--outputFile=${report}`);
  for (const file of [
    "box-shadow-border-knockout",
    "box-shadow-native-contour-authority",
    "capture-selected-shadow-root",
    "range-pseudo-box-shadow",
    "resize-handle",
  ])
    expect(run).toContain(`tests/${file}.e2e.test.ts`);
  const gate = String(strict!["run"]);
  expect(gate).toContain("tools/helper-release-consumer.ts");
  expect(gate).toContain(`--browser-results ${report}`);
  const minimum = /--minimum-passed\s+(\d+)\b/.exec(gate);
  expect(minimum).not.toBeNull();
  // Preserve the established floor without freezing a growing native selection.
  expect(Number(minimum![1])).toBeGreaterThanOrEqual(54);
  expect(gate).not.toMatch(/\|\||exit\s+0/);
  for (const step of [producer!, strict!, upload!]) {
    expect(step["if"]).toBe("always()");
    expect([undefined, false]).toContain(step["continue-on-error"]);
  }
  expect(String(upload!["uses"])).toMatch(/^actions\/upload-artifact@/);
  const options = object(upload!["with"]);
  const paths = String(options["path"])
    .split(/\r?\n/)
    .map((path) => path.trim());
  expect(paths).toContain(`${output}/shadow-knockout/`);
  expect(options["if-no-files-found"]).toBe("error");
  expect(steps.indexOf(upload!)).toBeGreaterThan(steps.indexOf(strict!));
}

describe.each(platforms)("$file native shadow evidence retention (DM-0SAYFX)", ({ file, output }) => {
  const workflow = object(parse(readFileSync(`.github/workflows/${file}`, "utf8")));
  const steps = object(object(workflow["jobs"])["regression"])["steps"] as Step[];
  it("retains the producing JSON/PNG directory after the strict native gate, including failures", () => {
    verifyShadowRetention(steps, output);
  });
  it("allows the selection to grow without changing its evidence path contract", () => {
    const grown = structuredClone(steps);
    const gate = grown.find((step) => step["name"] === "Require every native shadow assertion")!;
    gate["run"] = String(gate["run"]).replace(/--minimum-passed\s+\d+/, "--minimum-passed 81");
    verifyShadowRetention(grown, output);
  });
  it.each(["missing-directory", "success-only-upload", "tolerated-gate", "weakened-floor"])(
    "rejects %s retention regressions",
    (mutation) => {
      const changed = structuredClone(steps);
      const gate = changed.find((step) => step["name"] === "Require every native shadow assertion")!;
      const upload = changed.find((step) => step["name"] === "Upload expected/actual/diff PNGs")!;
      if (mutation === "missing-directory") {
        const options = object(upload["with"]);
        options["path"] = String(options["path"])
          .split(/\r?\n/)
          .filter((path) => path.trim() !== `${output}/shadow-knockout/`)
          .join("\n");
      } else if (mutation === "success-only-upload") upload["if"] = "success()";
      else if (mutation === "tolerated-gate") gate["continue-on-error"] = true;
      else gate["run"] = String(gate["run"]).replace(/--minimum-passed\s+\d+/, "--minimum-passed 1");
      expect(() => verifyShadowRetention(changed, output)).toThrow();
    },
  );
});

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

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
});

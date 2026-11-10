import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { verifyWorkerBootstrapReport } from "../tools/check-worker-bootstrap-report.js";
const record = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
const enabled = (value: unknown, inputs: Record<string, boolean>, event = "workflow_dispatch"): boolean =>
  String(value ?? "true")
    .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .split("&&")
    .every((raw) => {
      const term = raw.trim();
      if (term === "true") return true;
      if (term === "github.event_name == 'workflow_dispatch'") return event === "workflow_dispatch";
      if (term === "github.event_name != 'pull_request'") return event !== "pull_request";
      const match = term.match(/^(!?)inputs\.([a-z0-9_]+)$/);
      if (match == null) throw new Error(`Unexpected profile condition: ${term}`);
      return match[1] === "!" ? !inputs[match[2]!] : inputs[match[2]!] === true;
    });

describe.each([
  { file: "test-linux.yml", platform: "Linux", other: "image_root_metrics_only" },
  { file: "windows-fidelity.yml", platform: "Windows", other: "arm64_family_match" },
])("$platform native worker diagnostic profile", ({ file, platform, other }) => {
  const workflow = record(parse(readFileSync(`.github/workflows/${file}`, "utf8")));
  const jobs = record(workflow["jobs"]),
    worker = record(jobs["worker-bootstrap"]),
    conflict = record(jobs["reject-conflicting-worker-profile"]);
  const inputs = record(record(record(workflow["on"])["workflow_dispatch"])["inputs"]);
  it("keeps full/default gate selection and gives the focused job a distinct name", () => {
    expect(record(inputs["worker_bootstrap_only"])["default"]).toBe(false);
    expect(enabled(record(jobs["regression"])["if"], { worker_bootstrap_only: false, [other]: false })).toBe(true);
    expect(enabled(record(jobs["regression"])["if"], { worker_bootstrap_only: true, [other]: false })).toBe(false);
    expect(worker["name"]).toBe(`${platform} worker bootstrap diagnostics`);
    if (platform === "Linux") expect(enabled(record(jobs["regression"])["if"], {}, "pull_request")).toBe(true);
  });
  it("runs only the manual worker profile and rejects conflicting flags", () => {
    expect(enabled(worker["if"], { worker_bootstrap_only: true, [other]: false })).toBe(true);
    expect(enabled(worker["if"], { worker_bootstrap_only: false, [other]: false })).toBe(false);
    expect(enabled(worker["if"], { worker_bootstrap_only: true, [other]: false }, "pull_request")).toBe(false);
    expect(enabled(worker["if"], { worker_bootstrap_only: true, [other]: true })).toBe(false);
    expect(enabled(conflict["if"], { worker_bootstrap_only: true, [other]: true })).toBe(true);
  });
  it("uses static native commands, enforces no skips and retains scoped evidence", () => {
    const steps = worker["steps"] as Array<Record<string, unknown>>;
    const run = steps.map((step) => String(step["run"] ?? "")).join("\n");
    for (const file of [
      "real-world-cdp",
      "real-world-shared-worker-bootstrap",
      "real-world-worker-startup-diagnostics",
      "real-world-browser-signals",
      "real-world-webgl-worker-lifecycle",
      "real-world-webgl-freeze",
    ])
      expect(run).toContain(`tests/${file}.e2e.test.ts`);
    expect(run).toContain("check-worker-bootstrap-report.ts");
    expect(run).toContain("--reporter=json");
    expect(JSON.stringify(steps)).toContain(`${platform.toLowerCase()}-worker-bootstrap`);
    if (platform === "Linux") expect(record(worker["env"])["DOMOTION_OUTPUT_DIR"]).toBe("tests/output-linux");
  });
});

const report = () => ({
  success: true,
  numFailedTests: 0,
  numTotalTests: 1,
  numPendingTests: 0,
  testResults: [{ assertionResults: [{ status: "passed" }] }],
});
const fingerprint = () => ({
  schemaVersion: 1,
  profile: "worker-bootstrap-only",
  platform: process.platform,
  sourceCommit: "commit",
  browser: { product: "HeadlessChrome/147", revision: "@exact" },
  launch: { provenance: "public-launchServer-scout", scoutLaunches: 1, debuggingPipeRetained: true },
  startup: { nativeInImport: false, nativeAtStart: false, nativeNow: false, pixel: [0, 0, 0, 0] },
});
describe("native worker diagnostic evidence gate", () => {
  it("accepts complete native startup evidence without implying full fidelity", () => {
    expect(() => verifyWorkerBootstrapReport(report(), fingerprint(), process.platform, "commit")).not.toThrow();
  });
  it("rejects skips, empty selection, wrong platform/ref/profile, full Chrome or escaped cached calls", () => {
    const skipped = report();
    skipped.numPendingTests = 1;
    expect(() => verifyWorkerBootstrapReport(skipped, fingerprint(), process.platform)).toThrow("skipped");
    const empty = report();
    empty.numTotalTests = 0;
    expect(() => verifyWorkerBootstrapReport(empty, fingerprint(), process.platform)).toThrow("empty");
    expect(() =>
      verifyWorkerBootstrapReport(report(), { ...fingerprint(), platform: "another" }, process.platform),
    ).toThrow("another platform");
    expect(() => verifyWorkerBootstrapReport(report(), fingerprint(), process.platform, "wrong")).toThrow(
      "commit mismatch",
    );
    expect(() =>
      verifyWorkerBootstrapReport(report(), { ...fingerprint(), profile: "full" }, process.platform),
    ).toThrow("scope");
    expect(() =>
      verifyWorkerBootstrapReport(
        report(),
        { ...fingerprint(), browser: { product: "Chrome/147", revision: "@exact" } },
        process.platform,
      ),
    ).toThrow("headless-shell");
    expect(() =>
      verifyWorkerBootstrapReport(
        report(),
        { ...fingerprint(), startup: { ...fingerprint().startup, nativeInImport: true } },
        process.platform,
      ),
    ).toThrow("cached native");
    expect(() =>
      verifyWorkerBootstrapReport(
        report(),
        { ...fingerprint(), startup: { ...fingerprint().startup, pixel: [255, 0, 0, 255] } },
        process.platform,
      ),
    ).toThrow("escaped");
  });
});

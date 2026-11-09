import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const object = (value: unknown): Record<string, unknown> => {
  assert(value != null && typeof value === "object", "Expected diagnostic JSON object");
  return value as Record<string, unknown>;
};

/** A focused native diagnostic is never evidence of the full fidelity gate. */
export function verifyWorkerBootstrapReport(
  reportValue: unknown,
  fingerprintValue: unknown,
  platform: string,
  commit?: string,
): void {
  const report = object(reportValue),
    fingerprint = object(fingerprintValue);
  assert(report.success === true && report.numFailedTests === 0, "Worker bootstrap tests did not succeed");
  assert(typeof report.numTotalTests === "number" && report.numTotalTests > 0, "Worker bootstrap selection was empty");
  assert(report.numPendingTests === 0, "Worker bootstrap diagnostics skipped tests");
  assert(Array.isArray(report.testResults) && report.testResults.length > 0, "Missing selected test files");
  for (const raw of report.testResults as unknown[]) {
    const suite = object(raw);
    assert(Array.isArray(suite.assertionResults) && suite.assertionResults.length > 0, "Missing selected assertions");
    for (const result of suite.assertionResults as unknown[])
      assert(object(result).status === "passed", "Every selected diagnostic must run and pass");
  }
  assert(
    fingerprint.schemaVersion === 1 && fingerprint.profile === "worker-bootstrap-only",
    "Wrong diagnostic evidence scope",
  );
  assert(fingerprint.platform === platform, "Diagnostic evidence came from another platform");
  if (commit != null) assert(fingerprint.sourceCommit === commit, "Diagnostic source commit mismatch");
  const browser = object(fingerprint.browser),
    launch = object(fingerprint.launch),
    startup = object(fingerprint.startup);
  assert(
    typeof browser.product === "string" && browser.product.startsWith("HeadlessChrome/"),
    "Default headless-shell was not measured",
  );
  assert(typeof browser.revision === "string" && browser.revision.length > 1, "Missing exact Chromium revision");
  assert(
    launch.provenance === "public-launchServer-scout" &&
      launch.scoutLaunches === 1 &&
      launch.debuggingPipeRetained === true,
    "Wrong launch provenance",
  );
  assert(
    startup.nativeInImport === false && startup.nativeAtStart === false && startup.nativeNow === false,
    "Worker startup cached native WebGL methods",
  );
  assert.deepEqual(startup.pixel, [0, 0, 0, 0], "Cached native clear escaped startup interception");
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [reportPath, fingerprintPath] = process.argv.slice(2);
  assert(
    reportPath != null && fingerprintPath != null,
    "Usage: check-worker-bootstrap-report <report.json> <fingerprint.json>",
  );
  verifyWorkerBootstrapReport(
    JSON.parse(readFileSync(reportPath, "utf8")),
    JSON.parse(readFileSync(fingerprintPath, "utf8")),
    process.platform,
    process.env["GITHUB_SHA"],
  );
  console.log(
    `Worker-bootstrap-only diagnostics verified on ${process.platform}/${process.arch}; full fidelity gates remain separate.`,
  );
}

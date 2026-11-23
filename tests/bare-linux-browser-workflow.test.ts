import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseDocument } from "yaml";

// GitHub uses the OS matrix value in published check names such as
// "git-install (ubuntu-latest)". The physical runner must support the locked Chromium.
const nativeMatrixRunner = "${{ matrix.os == 'ubuntu-latest' && 'ubuntu-24.04' || matrix.os }}";

it.each([
  ["composed-parity-corpus", "corpus", nativeMatrixRunner],
  ["transformed-flex-geometry-parity", "logical-geometry", nativeMatrixRunner],
  ["repeating-linear-px-stop-parity", "source-geometry", nativeMatrixRunner],
  ["projective-owner-release", "collect", nativeMatrixRunner],
  ["wrapped-decoration-fragments", "logical-ownership", nativeMatrixRunner],
  ["ci", "git-install", nativeMatrixRunner],
  ["ci", "build", "ubuntu-24.04"],
  ["release", "npm-dry-run", "ubuntu-24.04"],
])("%s selects a compatible Linux runner for %s", (file, job, runner) => {
  const workflow = parseDocument(readFileSync(`.github/workflows/${file}.yml`, "utf8"));
  expect(workflow.getIn(["jobs", job, "runs-on"])).toBe(runner);
});

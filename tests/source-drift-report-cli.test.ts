import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function run(cwd: string, command: string, args: string[]) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}

function sourceRepo(root: string, path: string): void {
  const directory = join(root, path);
  mkdirSync(directory, { recursive: true });
  expect(run(root, "git", ["init", "-q", directory]).status).toBe(0);
  writeFileSync(join(directory, "source.txt"), path);
  expect(run(directory, "git", ["add", "source.txt"]).status).toBe(0);
  expect(
    run(directory, "git", [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ]).status,
  ).toBe(0);
}

describe("source drift report CLI", () => {
  it("writes an envelope and compares it with an equivalent legacy report", () => {
    const root = mkdtempSync(join(tmpdir(), "source-drift-cli-"));
    try {
      sourceRepo(root, "external/chromium");
      sourceRepo(root, "external/harfbuzz");
      sourceRepo(root, "external/chromium/third_party/icu");
      const harfbuzzReadme = join(root, "external/chromium/third_party/harfbuzz-ng/README.chromium");
      mkdirSync(join(root, "external/chromium/third_party/harfbuzz-ng"), { recursive: true });
      writeFileSync(harfbuzzReadme, "Revision: pinned-harfbuzz\n");
      for (const [name, contents] of [
        ["icu.dat", "icu bytes"],
        ["helper.bin", "helper bytes"],
        ["classifier.ts", "classifier bytes"],
        ["unicode.json", "[]"],
        ["shaping.json", "[]"],
      ])
        writeFileSync(join(root, name), contents);
      const producer = resolve("tools/source-drift-evidence.ts");
      const comparator = resolve("tools/compare-roll-evidence.ts");
      const tsxLoader = resolve("node_modules/tsx/dist/loader.mjs");
      const evidencePath = join(root, "evidence.json");
      const produced = run(root, process.execPath, [
        "--import",
        tsxLoader,
        producer,
        "--mode",
        "representative",
        "--icu-data",
        "icu.dat",
        "--helper",
        "helper.bin",
        "--classifier",
        "classifier.ts",
        "--unicode",
        "unicode.json",
        "--shaping",
        "shaping.json",
        "--out",
        evidencePath,
      ]);
      expect(produced.status, produced.stderr).toBe(0);
      const envelope = JSON.parse(readFileSync(evidencePath, "utf8"));
      expect(envelope).toMatchObject({
        schemaVersion: 1,
        tool: "source-drift-evidence",
        data: { mode: "representative", outcome: "pass" },
      });
      const oldDirectory = join(root, "old");
      const newDirectory = join(root, "new");
      mkdirSync(oldDirectory);
      mkdirSync(newDirectory);
      const { outcome: _outcome, ...legacy } = envelope.data;
      writeFileSync(join(oldDirectory, "evidence.json"), JSON.stringify(legacy));
      writeFileSync(join(newDirectory, "evidence.json"), JSON.stringify(envelope));
      const manifest = {
        environmentFingerprint: { host: "fixture" },
        reports: [{ area: "icu-harfbuzz-source-drift", status: "passed", reportFile: "evidence.json" }],
      };
      const oldManifest = join(oldDirectory, "manifest.json");
      const newManifest = join(newDirectory, "manifest.json");
      writeFileSync(oldManifest, JSON.stringify(manifest));
      writeFileSync(newManifest, JSON.stringify(manifest));
      const resultPath = join(root, "comparison.json");
      const compare = () =>
        run(root, process.execPath, [
          "--import",
          tsxLoader,
          comparator,
          "--old",
          oldManifest,
          "--new",
          newManifest,
          "--out",
          resultPath,
        ]);
      const equal = compare();
      expect(equal.status, equal.stderr).toBe(0);
      expect(JSON.parse(readFileSync(resultPath, "utf8"))).toMatchObject({
        pass: true,
        stageChanges: [],
        sourceDrift: { verdict: "comparable" },
      });
      writeFileSync(join(newDirectory, "evidence.json"), JSON.stringify({ ...envelope, schemaVersion: 2 }));
      const invalid = compare();
      expect(invalid.status, invalid.stderr).toBe(1);
      expect(JSON.parse(readFileSync(resultPath, "utf8")).sourceDrift.blockers).toEqual([
        "invalid-source-drift-payload",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

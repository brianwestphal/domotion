import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  budgetForCpuWork,
  describeChild,
  runBoundedChild,
  testTimeoutFor,
  type BoundedChildResult,
} from "./bounded-child.js";

// Measured inside a loaded full suite (docs/tool-child-process-test-bounds.md):
// each fixture repository command used under 0.01 s of CPU, the evidence
// producer 0.22 s plus three revision lookups it starts itself, and the
// comparator 0.21 s. The whole test took 51 s against the 30 s timeout.
const REPOSITORY_BUDGET_MS = budgetForCpuWork(50);
const PRODUCER_BUDGET_MS = budgetForCpuWork(300, 4);
const COMPARATOR_BUDGET_MS = budgetForCpuWork(300);
const REPOSITORY_COMMANDS = 9;

function run(cwd: string, command: string, args: string[], budgetMs: number): Promise<BoundedChildResult> {
  return runBoundedChild(command, args, { cwd, budgetMs });
}

async function sourceRepo(root: string, path: string): Promise<void> {
  const directory = join(root, path);
  mkdirSync(directory, { recursive: true });
  const init = await run(root, "git", ["init", "-q", directory], REPOSITORY_BUDGET_MS);
  expect(init.status, describeChild(init)).toBe(0);
  writeFileSync(join(directory, "source.txt"), path);
  const add = await run(directory, "git", ["add", "source.txt"], REPOSITORY_BUDGET_MS);
  expect(add.status, describeChild(add)).toBe(0);
  const commit = await run(
    directory,
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"],
    REPOSITORY_BUDGET_MS,
  );
  expect(commit.status, describeChild(commit)).toBe(0);
}

describe("source drift report CLI", () => {
  it(
    "writes an envelope and compares it with an equivalent legacy report",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "source-drift-cli-"));
      try {
        await sourceRepo(root, "external/chromium");
        await sourceRepo(root, "external/harfbuzz");
        await sourceRepo(root, "external/chromium/third_party/icu");
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
        const produced = await run(
          root,
          process.execPath,
          [
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
          ],
          PRODUCER_BUDGET_MS,
        );
        expect(produced.status, describeChild(produced)).toBe(0);
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
          run(
            root,
            process.execPath,
            ["--import", tsxLoader, comparator, "--old", oldManifest, "--new", newManifest, "--out", resultPath],
            COMPARATOR_BUDGET_MS,
          );
        const equal = await compare();
        expect(equal.status, describeChild(equal)).toBe(0);
        expect(JSON.parse(readFileSync(resultPath, "utf8"))).toMatchObject({
          pass: true,
          stageChanges: [],
          sourceDrift: { verdict: "comparable" },
        });
        writeFileSync(join(newDirectory, "evidence.json"), JSON.stringify({ ...envelope, schemaVersion: 2 }));
        const invalid = await compare();
        expect(invalid.status, describeChild(invalid)).toBe(1);
        expect(JSON.parse(readFileSync(resultPath, "utf8")).sourceDrift.blockers).toEqual([
          "invalid-source-drift-payload",
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    testTimeoutFor(
      ...Array<number>(REPOSITORY_COMMANDS).fill(REPOSITORY_BUDGET_MS),
      PRODUCER_BUDGET_MS,
      COMPARATOR_BUDGET_MS,
      COMPARATOR_BUDGET_MS,
    ),
  );
});

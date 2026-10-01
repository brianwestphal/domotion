import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCandidates, selectCohort, writeCohort } from "../scripts/select-font-conformance-cohort.mjs";
import { mergeShards } from "../scripts/merge-font-conformance-shards.mjs";

const sha = "a".repeat(40);
const workflow = ".github/workflows/font-conformance.yml";
const roots: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "font-cohort-"));
  roots.push(root);
  return root;
}

function addShard(
  root: string,
  runId: number,
  stack: number,
  imageVersion: string,
  options: {
    stackTotal?: number;
    cp?: number;
    cpTotal?: number;
    workflowPath?: string;
    sourceSha?: string;
    synthetic?: boolean;
    rotationOrdinal?: string;
    sampleByte?: string;
  } = {},
) {
  const stackTotal = options.stackTotal ?? 6;
  const cpTotal = options.cpTotal ?? 1;
  const cp = options.cp ?? 1;
  const runDir = join(root, `run-${runId}`);
  const artifact = `font-conformance-${options.synthetic ? "synthetic-" : ""}windows-shard-${stack}${options.synthetic ? "" : `-cp${cp}`}`;
  const dir = join(runDir, artifact);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(runDir, "provenance.json"),
    JSON.stringify({ runId, headSha: options.sourceSha ?? sha, workflowPath: options.workflowPath ?? workflow }),
  );
  const report = {
    schemaVersion: 1,
    tool: "font-conformance",
    env: { imageVersion },
    data: {
      outcome: "pass",
      meta: {
        platform: "win32",
        arch: "x64",
        node: "v22.21.0",
        chromium: "147.0.7727.15",
        unicode: "16.0",
        icu: "77.1",
        stacksFile: "tools/font-conformance-stacks.win32.json",
        stackCorpusGeneratedAt: "harvested:v2:abc",
        stackCorpusPlatform: "win32",
        includePua: true,
        strictAlias: false,
        lang: "en",
        stackFilter: null,
        sampleByte: options.synthetic ? (options.sampleByte ?? "00") : null,
        ranges: null,
        oracleIsolation: "renderer-per-locale",
        parityEnvironment: { image: "windows2025-x64", imageVersion, fontInventory: { digest: "font-a" } },
        rotationRevision: null,
        rotationOrdinal: options.rotationOrdinal ?? null,
        rotationStackBucket: null,
        stackShard: [stack, stackTotal],
        shard: cpTotal === 1 ? null : [cp, cpTotal],
        stacks: 1,
        codepoints: 100,
      },
      summary: { mismatchTotal: stack, comparisons: 100 },
    },
  };
  writeFileSync(join(dir, "report.json"), JSON.stringify(report));
  writeFileSync(join(dir, "runner-image.txt"), "windows2025-x64\n");
  writeFileSync(join(dir, "font-inventory.json"), JSON.stringify({ digest: "font-a", count: 147 }));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("authenticated font conformance cohorts", () => {
  it("wires both Windows aggregates through authenticated selection", () => {
    const full = readFileSync(".github/workflows/font-conformance.yml", "utf8");
    const synthetic = readFileSync(".github/workflows/font-conformance-synthetic.yml", "utf8");
    for (const workflowText of [full, synthetic]) {
      expect(workflowText).toContain("scripts/ci-collect-font-cohort.sh");
      expect(workflowText).toContain("scripts/select-font-conformance-cohort.mjs");
      expect(workflowText).toContain("--source-sha");
      expect(workflowText).toContain("--workflow-path");
      expect(workflowText).toContain("cohort-manifest.json");
    }
    expect(synthetic).toContain("cohort_rotation_ordinal is required when pairing synthetic runs");
    expect(synthetic).toContain('anchor="$COHORT_ROTATION_ORDINAL"');
    expect(synthetic).toContain('if [ -n "$COHORT_RUN_IDS" ]');
    expect(synthetic).not.toContain('anchor="${{ inputs.cohort_rotation_ordinal }}"');
    expect(synthetic).toContain("FONT_CONFORMANCE_ROTATION_ORDINAL: ${{ inputs.cohort_rotation_ordinal");
  });

  it("assembles six full Windows shards from split-image runs without changing topology", () => {
    const root = fixtureRoot();
    for (let stack = 1; stack <= 4; stack++) addShard(root, 101, stack, "new-image");
    for (let stack = 5; stack <= 6; stack++) addShard(root, 101, stack, "old-image");
    for (let stack = 1; stack <= 4; stack++) addShard(root, 102, stack, "old-image");
    const cohort = selectCohort(readCandidates(root, { sourceSha: sha, workflowPath: workflow, os: "windows" }), {
      stackTotal: 6,
    });
    expect(
      cohort.selected.map((s: { report: { meta: { stackShard: number[] } } }) => s.report.meta.stackShard[0]),
    ).toEqual([1, 2, 3, 4, 5, 6]);
    expect(cohort.selected.map((s: { runId: number }) => s.runId)).toEqual([102, 102, 102, 102, 101, 101]);
    expect(cohort.identity.imageVersion).toBe("old-image");
    const selectedDir = join(root, "selected");
    const manifestPath = join(root, "manifest.json");
    writeCohort(cohort, selectedDir, manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.provenance).toHaveLength(6);
    const merged = mergeShards(cohort.selected, { expected: 6, os: "windows" });
    expect(merged.meta.complete).toBe(true);
    expect(merged.meta.envConflicts).toEqual([]);
    expect(merged.meta.slice.stacks).toBe(6);
  });

  it("repairs the two-shard synthetic split only from the same sampled question", () => {
    const root = fixtureRoot();
    const syntheticWorkflow = ".github/workflows/font-conformance-synthetic.yml";
    addShard(root, 201, 1, "new-image", {
      stackTotal: 2,
      synthetic: true,
      workflowPath: syntheticWorkflow,
      rotationOrdinal: "51",
    });
    addShard(root, 201, 2, "old-image", {
      stackTotal: 2,
      synthetic: true,
      workflowPath: syntheticWorkflow,
      rotationOrdinal: "51",
    });
    addShard(root, 202, 1, "old-image", {
      stackTotal: 2,
      synthetic: true,
      workflowPath: syntheticWorkflow,
      rotationOrdinal: "52",
    });
    expect(() =>
      selectCohort(readCandidates(root, { sourceSha: sha, workflowPath: syntheticWorkflow, os: "windows" }), {
        stackTotal: 2,
      }),
    ).toThrow(/no complete same-environment/);
    addShard(root, 202, 1, "old-image", {
      stackTotal: 2,
      synthetic: true,
      workflowPath: syntheticWorkflow,
      rotationOrdinal: "51",
    });
    const cohort = selectCohort(
      readCandidates(root, { sourceSha: sha, workflowPath: syntheticWorkflow, os: "windows" }),
      {
        stackTotal: 2,
      },
    );
    expect(cohort.selected.map((s: { runId: number }) => s.runId)).toEqual([202, 201]);
  });

  it("rejects foreign source commits and incomplete image fingerprints", () => {
    const root = fixtureRoot();
    addShard(root, 301, 1, "old-image", { sourceSha: "b".repeat(40) });
    expect(() => readCandidates(root, { sourceSha: sha, workflowPath: workflow, os: "windows" })).toThrow(
      /source commit or workflow/,
    );
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root);
    addShard(root, 302, 1, "", { stackTotal: 1 });
    expect(() =>
      selectCohort(readCandidates(root, { sourceSha: sha, workflowPath: workflow, os: "windows" }), {
        stackTotal: 1,
      }),
    ).toThrow(/runner image version/);
  });

  it("requires every cell of a two-axis topology and never substitutes a duplicate", () => {
    const root = fixtureRoot();
    addShard(root, 401, 1, "same", { stackTotal: 2, cpTotal: 2, cp: 1 });
    addShard(root, 401, 2, "same", { stackTotal: 2, cpTotal: 2, cp: 1 });
    addShard(root, 402, 1, "same", { stackTotal: 2, cpTotal: 2, cp: 2 });
    expect(() =>
      selectCohort(readCandidates(root, { sourceSha: sha, workflowPath: workflow, os: "windows" }), {
        stackTotal: 2,
        cpTotal: 2,
        cpIndices: [1, 2],
      }),
    ).toThrow(/no complete same-environment/);
    addShard(root, 402, 2, "same", { stackTotal: 2, cpTotal: 2, cp: 2 });
    const cohort = selectCohort(readCandidates(root, { sourceSha: sha, workflowPath: workflow, os: "windows" }), {
      stackTotal: 2,
      cpTotal: 2,
      cpIndices: [1, 2],
    });
    expect(cohort.selected).toHaveLength(4);
  });
});

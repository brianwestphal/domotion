import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

const WORKFLOW = resolve(__dirname, "..", ".github", "workflows", "release-helpers.yml");
const source = readFileSync(WORKFLOW, "utf8");
interface Step {
  name?: string;
  id?: string;
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
}
interface Job {
  needs?: string | string[];
  outputs?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, { inputs: Record<string, { required?: boolean; type: string }> }>;
  jobs: Record<string, Job>;
}
const workflow = parse(source) as Workflow;
const builders = [
  "macos-glyph-extractor",
  "linux-glyph-extractor",
  "linux-arm64-glyph-extractor",
  "windows-glyph-extractor",
  "windows-arm64-glyph-extractor",
];
const assets = [
  "domotion-glyph-paths-darwin-universal",
  "domotion-glyph-paths-linux-x64",
  "domotion-glyph-paths-linux-arm64",
  "domotion-glyph-paths-win32-x64.exe",
  "domotion-glyph-paths-win32-arm64.exe",
];
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function script(job: string, name: string): string {
  const run = workflow.jobs[job].steps.find((step) => step.name === name)?.run;
  const embedded = run?.match(/node <<'NODE'\n([\s\S]*?)\nNODE/);
  if (embedded == null) throw new Error(`Missing executable validation step: ${name}`);
  return embedded[1];
}
const resolveScript = script("resolve-source", "Resolve and validate the helper source");
const verifyScript = script("attach-binaries", "Verify the complete helper set and commit provenance");
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Domotion Tests",
      "-c",
      "user.email=ci@domotion.invalid",
      "-c",
      "commit.gpgSign=false",
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();
}
function fixture(version = "0.35.0") {
  const root = mkdtempSync(join(tmpdir(), "domotion-helper-release-"));
  roots.push(root);
  const cwd = join(root, "source");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ version }));
  git(cwd, "init", "-q");
  git(cwd, "add", "package.json");
  git(cwd, "commit", "-qm", "source");
  const provenance = join(root, "domotion-helper-provenance.json");
  const output = join(root, "output");
  const commit = git(cwd, "rev-parse", "HEAD");
  const env = {
    ...process.env,
    TAG: "v0.35.0",
    SOURCE_REF: "main",
    SOURCE_OVERRIDE: "main",
    PROVENANCE_PATH: provenance,
    GITHUB_OUTPUT: output,
    GITHUB_REPOSITORY: "example/domotion",
    WORKFLOW_SHA: "a".repeat(40),
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
  };
  return { root, cwd, provenance, output, commit, env };
}
function execute(code: string, cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["-e", code], { cwd, env, encoding: "utf8" });
}
function stagedFixture() {
  const f = fixture();
  const resolved = execute(resolveScript, f.cwd, f.env);
  expect(resolved.status, resolved.stderr).toBe(0);
  const dir = join(f.root, "assets");
  mkdirSync(dir);
  copyFileSync(f.provenance, join(dir, "domotion-helper-provenance.json"));
  for (const [index, asset] of assets.entries()) {
    const binary = Buffer.from(`native helper ${asset}`);
    writeFileSync(join(dir, asset), binary);
    const digest = createHash("sha256").update(binary).digest("hex");
    // Both shasum's text format and Windows coreutils' binary marker are valid.
    writeFileSync(join(dir, asset + ".sha256"), `${digest}  ${index === 4 ? "*" : ""}${asset}\n`);
  }
  return { ...f, dir, verifyEnv: { ...f.env, ASSET_DIR: dir, SOURCE_SHA: f.commit, SOURCE_PACKAGE_VERSION: "0.35.0" } };
}

describe("release-helpers.yml source and publication contract", () => {
  it("permits a manual same-version source ref while reusable releases default to the tag", () => {
    expect(workflow.on.workflow_call.inputs.tag.required).toBe(true);
    expect(workflow.on.workflow_call.inputs.source_ref).toBeUndefined();
    expect(workflow.on.workflow_dispatch.inputs.source_ref).toEqual({
      description: expect.any(String),
      required: false,
      type: "string",
    });
    expect(source).not.toMatch(/^ {2}push:/m);
    expect(source).not.toMatch(/npm publish|git tag|gh release create/);
    const checkout = workflow.jobs["resolve-source"].steps.find((step) => step.uses === "actions/checkout@v4");
    expect(checkout?.with?.ref).toBe("${{ inputs.source_ref || inputs.tag }}");
    for (const name of builders) {
      expect(workflow.jobs[name].needs).toBe("resolve-source");
      expect(workflow.jobs[name].steps.find((step) => step.uses === "actions/checkout@v4")?.with?.ref).toBe(
        "${{ needs.resolve-source.outputs.source_sha }}",
      );
    }
  });
  it("retains signed native products and verifies the whole set before the only upload", () => {
    for (const name of builders)
      expect(workflow.jobs[name].steps.some((step) => step.uses === "actions/upload-artifact@v4")).toBe(true);
    expect(workflow.jobs["attach-binaries"].needs).toEqual(["resolve-source", ...builders]);
    const steps = workflow.jobs["attach-binaries"].steps;
    const verify = steps.findIndex((step) => step.name === "Verify the complete helper set and commit provenance");
    const retained = steps.findIndex((step) => step.name === "Retain verified commit and checksum provenance");
    const upload = steps.findIndex((step) => step.run?.includes("gh release upload"));
    expect(verify).toBeGreaterThan(-1);
    expect(retained).toBeGreaterThan(verify);
    expect(upload).toBeGreaterThan(retained);
    expect([...source.matchAll(/gh release upload/g)]).toHaveLength(1);
    expect(source).toContain('gh release view "$TAG" >/dev/null');
    expect(source).toContain("pattern: release-helper-*");
    expect(source).toContain("name: release-helper-source");
    expect(source).toContain("name: helper-release-provenance-verified");
    expect(source).toContain("codesign --verify --strict");
    expect(source).toContain("apple-actions/import-codesign-certs@v3");
    for (const name of ["linux-glyph-extractor", "linux-arm64-glyph-extractor"])
      expect(workflow.jobs[name].steps.find((step) => step.name === "Install build dependencies")?.run).toContain(
        "libfontconfig-dev",
      );
  });
  it("pins an immutable source commit even when its requested branch later moves", () => {
    const f = fixture();
    const result = execute(resolveScript, f.cwd, f.env);
    expect(result.status, result.stderr).toBe(0);
    writeFileSync(join(f.cwd, "later.txt"), "new main");
    git(f.cwd, "add", "later.txt");
    git(f.cwd, "commit", "-qm", "move branch");
    const provenance = JSON.parse(readFileSync(f.provenance, "utf8")) as {
      sourceCommit: string;
      sourcePackageVersion: string;
      requestedSourceRef: string;
    };
    expect(provenance.sourceCommit).toBe(f.commit);
    expect(provenance.sourceCommit).not.toBe(git(f.cwd, "rev-parse", "HEAD"));
    expect(provenance.sourcePackageVersion).toBe("0.35.0");
    expect(provenance.requestedSourceRef).toBe("main");
    expect(readFileSync(f.output, "utf8")).toBe(`source_sha=${f.commit}\nsource_package_version=0.35.0\n`);
  });
  it("rejects mismatched source versions and malformed tags before emitting build outputs", () => {
    for (const [version, tag] of [
      ["0.36.0", "v0.35.0"],
      ["0.35.0", "main"],
      ["0.35.0", "v0.35.0\nsource_sha=evil"],
    ]) {
      const f = fixture(version);
      const result = execute(resolveScript, f.cwd, { ...f.env, TAG: tag });
      expect(result.status).not.toBe(0);
      expect(existsSync(f.output)).toBe(false);
      expect(existsSync(f.provenance)).toBe(false);
    }
  });
  it("preserves only the existing default-tag beta base-version compatibility", () => {
    const f = fixture();
    const tag = "v0.35.0-beta.2";
    const result = execute(resolveScript, f.cwd, { ...f.env, TAG: tag, SOURCE_REF: tag, SOURCE_OVERRIDE: "" });
    expect(result.status, result.stderr).toBe(0);
    const provenance = JSON.parse(readFileSync(f.provenance, "utf8")) as {
      sourcePackageVersion: string;
      targetVersion: string;
      versionPolicy: string;
    };
    expect(provenance).toMatchObject({
      sourcePackageVersion: "0.35.0",
      targetVersion: "0.35.0-beta.2",
      versionPolicy: "default-tag-beta-base",
    });
    for (const [version, target, ref, override] of [
      ["0.36.0", tag, tag, ""],
      ["0.35.0", tag, "main", "main"],
      ["0.35.0", tag, tag, tag],
      ["0.35.0", "v0.35.0-rc.2", "v0.35.0-rc.2", ""],
      ["0.35.0", "v0.35.0-beta.bad", "v0.35.0-beta.bad", ""],
    ]) {
      const bad = fixture(version);
      expect(
        execute(resolveScript, bad.cwd, { ...bad.env, TAG: target, SOURCE_REF: ref, SOURCE_OVERRIDE: override }).status,
      ).not.toBe(0);
      expect(existsSync(bad.output)).toBe(false);
    }
    const missing = fixture();
    writeFileSync(join(missing.cwd, "package.json"), "{}");
    expect(
      execute(resolveScript, missing.cwd, { ...missing.env, SOURCE_REF: missing.env.TAG, SOURCE_OVERRIDE: "" }).status,
    ).not.toBe(0);
    const exact = fixture("0.35.0-beta.2");
    expect(execute(resolveScript, exact.cwd, { ...exact.env, TAG: tag }).status).toBe(0);
  });

  it("records all five verified checksums with their pinned commit before attachment", () => {
    const f = stagedFixture();
    const result = execute(verifyScript, f.cwd, f.verifyEnv);
    expect(result.status, result.stderr).toBe(0);
    const content = readFileSync(join(f.dir, "domotion-helper-provenance.json"));
    const proof = JSON.parse(content.toString()) as {
      sourceCommit: string;
      assets: Record<string, { sha256: string; bytes: number }>;
    };
    expect(proof.sourceCommit).toBe(f.commit);
    expect(Object.keys(proof.assets)).toEqual(assets);
    for (const asset of assets) {
      expect(proof.assets[asset].sha256).toBe(
        createHash("sha256")
          .update(readFileSync(join(f.dir, asset)))
          .digest("hex"),
      );
      expect(proof.assets[asset].bytes).toBeGreaterThan(0);
    }
    expect(readFileSync(join(f.dir, "domotion-helper-provenance.json.sha256"), "utf8")).toBe(
      `${createHash("sha256").update(content).digest("hex")}  domotion-helper-provenance.json\n`,
    );
  });
  it("rejects missing, empty, extra, corrupted and mixed-source products before publication", () => {
    for (const mutate of [
      (f: ReturnType<typeof stagedFixture>) => rmSync(join(f.dir, assets[4])),
      (f: ReturnType<typeof stagedFixture>) => writeFileSync(join(f.dir, assets[0]), ""),
      (f: ReturnType<typeof stagedFixture>) => writeFileSync(join(f.dir, "unexpected"), "asset"),
      (f: ReturnType<typeof stagedFixture>) => writeFileSync(join(f.dir, assets[1]), "tampered"),
      (f: ReturnType<typeof stagedFixture>) =>
        writeFileSync(join(f.dir, assets[2] + ".sha256"), `${"a".repeat(64)}  ${assets[2]}\n`),
      (f: ReturnType<typeof stagedFixture>) => {
        f.verifyEnv.SOURCE_SHA = "b".repeat(40);
      },
    ]) {
      const f = stagedFixture();
      mutate(f);
      const result = execute(verifyScript, f.cwd, f.verifyEnv);
      expect(result.status).not.toBe(0);
      expect(existsSync(join(f.dir, "domotion-helper-provenance.json.sha256"))).toBe(false);
    }
  });
});

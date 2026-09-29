import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The `domotion` exit-code contract as a user sees it: 2 = the invocation was wrong (bad or
 * missing flag, conflicting options, a config that does not exist or validate), 1 = the work
 * itself failed. Every case below fails BEFORE any browser launches, so the suite needs neither
 * Chromium nor network. The CLI runs as a child process — the built `dist/cli/index.js` when
 * present, else the TypeScript entry through tsx.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DIST_CLI = resolve(REPO_ROOT, "dist/cli/index.js");
const CLI_ARGV = existsSync(DIST_CLI) ? [DIST_CLI] : ["--import", "tsx", resolve(REPO_ROOT, "src/cli/index.ts")];

function run(...args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [...CLI_ARGV, ...args], { encoding: "utf8", timeout: 60_000 });
  return { status: r.status, stderr: r.stderr };
}

describe("domotion exit codes", () => {
  it("animate with no config is a usage error (2)", () => {
    const r = run("animate");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/missing <config\.json>/);
  });

  it("conflicting capture flags are a usage error (2)", () => {
    const r = run("capture", "x.html", "--optimize", "--no-optimize");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/mutually exclusive/);
  });

  it("a non-integer numeric flag is a usage error (2), and --wait 0 is accepted as a value", () => {
    expect(run("capture", "x.html", "--width", "abc").status).toBe(2);
    // Reaches input handling (missing file -> usage 2) rather than rejecting the flag itself.
    const r = run("capture", "definitely-not-here.html", "--wait", "0");
    expect(r.stderr).not.toMatch(/--wait expects/);
  });

  it("an unknown flag is a usage error (2)", () => {
    expect(run("capture", "x.html", "--no-such-flag").status).toBe(2);
    expect(run("animate", "--no-such-flag").status).toBe(2);
  });

  it("a missing animate config file is a usage error (2)", () => {
    expect(run("animate", "definitely-not-here.json").status).toBe(2);
  });

  it("composite and storyboard configs that fail validation exit 2 and report EVERY issue", () => {
    const dir = mkdtempSync(join(tmpdir(), "domotion-exit-"));
    try {
      const bad = join(dir, "bad.json");
      writeFileSync(bad, JSON.stringify({ layers: [{}, {}] }));
      const composite = run("composite", bad);
      expect(composite.status).toBe(2);
      expect(composite.stderr).toMatch(/composite:/);

      const storyboard = run("storyboard", bad);
      expect(storyboard.status).toBe(2);
      expect(storyboard.stderr).toMatch(/storyboard:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("term validates --mode and numeric flags before doing any work (2)", () => {
    const mode = run("term", "--cast", "nope.cast", "--mode", "sideways");
    expect(mode.status).toBe(2);
    expect(mode.stderr).toMatch(/--mode must be/);
    const cols = run("term", "--cast", "nope.cast", "--cols=-5");
    expect(cols.status).toBe(2);
    expect(cols.stderr).toMatch(/--cols expects a positive integer/);
  });
});

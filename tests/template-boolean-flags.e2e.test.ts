import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Boolean template params through the real `domotion template` CLI. A default-`true` param used to be
 * impossible to switch off: the flag layer only had presence flags and `z.coerce.boolean()` turned the
 * string "false" into `true`. This drives the built CLI (the same entry users run) and checks that
 * `--no-pulse` actually removes the CTA's infinite pulse from the rendered SVG, and that conflicting or
 * unparseable boolean input is a usage error (exit 2) rather than a silent `true`.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DIST_CLI = resolve(REPO_ROOT, "dist/cli/index.js");
const CLI_ARGV = existsSync(DIST_CLI) ? [DIST_CLI] : ["--import", "tsx", resolve(REPO_ROOT, "src/cli/index.ts")];
/** The pulse is the only looping, alternating animation in the cta output (the reveal loops with the whole SVG). */
const PULSE = /infinite alternate/;
const work = mkdtempSync(join(tmpdir(), "domotion-tmpl-bool-"));

afterAll(() => rmSync(work, { recursive: true, force: true }));

function run(...args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [...CLI_ARGV, ...args], { encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stderr: r.stderr };
}

function renderCta(name: string, ...extra: string[]): string {
  const out = join(work, `${name}.svg`);
  const r = run("template", "cta", "--cta", "Go", "--width", "640", "--height", "360", "--quiet", ...extra, "-o", out);
  expect(r.status, r.stderr).toBe(0);
  return readFileSync(out, "utf8");
}

describe("template boolean params on the CLI", () => {
  it("--no-pulse turns off a default-true param in the rendered SVG", () => {
    expect(renderCta("default")).toMatch(PULSE);
    expect(renderCta("no-pulse", "--no-pulse")).not.toMatch(PULSE);
    // A string "false" from JSON is honored too (it used to coerce to true).
    expect(renderCta("json-false", "--params", '{"pulse":"false"}')).not.toMatch(PULSE);
  }, 120_000);

  it("conflicting or unparseable boolean input is a usage error (2)", () => {
    const both = run("template", "cta", "--cta", "Go", "--pulse", "--no-pulse");
    expect(both.status).toBe(2);
    expect(both.stderr).toMatch(/--pulse and --no-pulse are mutually exclusive/);
    expect(run("template", "cta", "--cta", "Go", "--params", '{"pulse":"maybe"}').status).toBe(2);
  });
});

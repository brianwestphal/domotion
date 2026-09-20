import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(entry: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", resolve(ROOT, entry), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, DOMOTION_NO_OPEN: "1" },
  });
}

function expectStudioHelp(result: ReturnType<typeof run>): void {
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("domotion-studio — local visual workspace");
  expect(result.stdout).toContain("domotion studio [project.json] [options]");
  expect(result.stdout).toContain("--workspace <dir>");
  expect(result.stdout).toContain("--port <n>");
  expect(result.stdout).toContain("--no-open");
  expect(result.stdout).not.toContain("capture options:");
}

describe("Studio CLI help routing", () => {
  it("routes umbrella-command help to the Studio command", () => {
    expectStudioHelp(run("src/cli/index.ts", ["studio", "--help"]));
  });

  it("prints the same command help from the standalone entrypoint", () => {
    const umbrella = run("src/cli/index.ts", ["studio", "--help"]);
    const standalone = run("src/cli/studio.ts", ["--help"]);
    expectStudioHelp(standalone);
    expect(standalone.stdout).toBe(umbrella.stdout);
  });
});

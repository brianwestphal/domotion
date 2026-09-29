import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function run(args: string[]): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", "tools/font-conformance.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error != null) throw result.error;
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

describe("font-conformance CLI preflight", () => {
  it("rejects an out-of-range shard with usage status before launching Chromium", () => {
    const result = run(["--shard", "0/8"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("out of range");
    expect(result.stdout).not.toContain("codepoints ×");
  });

  it("rejects zero selected codepoints and stacks instead of reporting agreement", () => {
    const noCodepoints = run(["--range", "0041", "--shard", "2/2"]);
    expect(noCodepoints.status).toBe(2);
    expect(noCodepoints.stderr).toContain("refusing an empty sweep");

    const noStacks = run(["--max-stacks", "1", "--stack-shard", "2/2"]);
    expect(noStacks.status).toBe(2);
    expect(noStacks.stderr).toContain("refusing an empty sweep");
  });

  it("rejects malformed batch size without entering the sweep loop", () => {
    const result = run(["--batch", "abc"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--batch needs an integer");
  });
});

/**
 * The shard script's job is to turn workflow inputs into oracle flags, and the
 * whole failure mode in this area is a flag that is silently *not* passed: the
 * sweep still runs, still prints a plausible number, and has measured something
 * other than what was asked for.
 *
 * Two of those have already happened. The script's own header records the first
 * (an unquoted string expansion that did not word-split, disarming every flag).
 * The second is the one these tests pin: `max_stacks` was documented as "empty =
 * the whole corpus", but **GitHub substitutes an input's default for an
 * empty-string `workflow_dispatch` value**, so a dispatch meant to sweep all 434
 * corpus stacks arrived as the canonical six and its run title said so in
 * passing. `all` / `0` are now the sentinels, and the empty case is pinned too
 * so the old spelling cannot start meaning something different by accident.
 *
 * The script is exercised for real — stubbed `npx`/`node` on PATH, and the
 * command line it echoes is the assertion surface. A test that re-implemented
 * the case statement in TypeScript would pass against a broken script.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts/ci-font-conformance-shard.sh");
let stubDir: string;

beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), "fc-shard-stub-"));
  // `npx` swallows the sweep; `node` swallows the two metadata recorders. Both
  // must exit 0 or the script's exit-code discipline fails the run before the
  // echoed command line can be read.
  for (const name of ["npx", "node"]) {
    const p = join(stubDir, name);
    writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(p, 0o755);
  }
});

/** Run the script and return the command line it says it will run. */
function argsFor(env: Record<string, string>): string {
  const out = execFileSync("bash", [SCRIPT], {
    cwd: ROOT,
    encoding: "utf-8",
    env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ""}`, SHARD: "1", TOTAL: "6", ...env },
  });
  const line = out.split("\n").find((l) => l.includes("npx tsx tools/font-conformance.ts"));
  expect(line, `the script must announce its command line:\n${out}`).toBeDefined();
  return line!.slice(line!.indexOf("npx tsx"));
}

describe("the conformance shard script passes exactly the flags it was asked for", () => {
  it("always carries the stack shard and the output dir", () => {
    expect(argsFor({})).toContain("--stack-shard 1/6");
  });

  it("caps the corpus when given a number", () => {
    expect(argsFor({ MAX_STACKS: "6" })).toContain("--max-stacks 6");
  });

  it.each(["all", "ALL", "0", ""])("sweeps the WHOLE corpus for MAX_STACKS=%j", (v) => {
    // The claim: no `--max-stacks` flag at all. Asserting the absence is the
    // point — a cap of "434" would also look like a full sweep today and would
    // silently truncate the moment the corpus grew.
    expect(argsFor({ MAX_STACKS: v })).not.toContain("--max-stacks");
  });

  it("omits the codepoint axis unless a second dimension was asked for", () => {
    // A gratuitous `--shard 1/1` makes a 1-D run look 2-D to the merge, which
    // keys its codepoint accounting off that field.
    expect(argsFor({ CP_TOTAL: "1", CP_SHARD: "1" })).not.toContain("--shard 1/1");
    expect(argsFor({ CP_TOTAL: "4", CP_SHARD: "3" })).toContain("--shard 3/4");
  });

  it("passes the boolean switches only when true", () => {
    expect(argsFor({ NO_PUA: "true" })).toContain("--no-pua");
    expect(argsFor({ NO_PUA: "false" })).not.toContain("--no-pua");
    expect(argsFor({ STRICT_ALIAS: "true" })).toContain("--strict-alias");
    expect(argsFor({ STRICT_ALIAS: "false" })).not.toContain("--strict-alias");
  });

  it("selects an alternate stack corpus when one is named", () => {
    // How the synthetic sweep shares this script without a second copy of it.
    expect(argsFor({ STACKS: "tools/font-conformance-stacks.synthetic.json" }))
      .toContain("--stacks tools/font-conformance-stacks.synthetic.json");
    expect(argsFor({})).not.toContain("--stacks");
  });
});

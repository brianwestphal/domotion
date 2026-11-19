import { describe, expect, it } from "vitest";
import { collectChangelog, formatChangelog } from "../scripts/changelog-analysis.mjs";
import { budgetForCpuWork, describeChild, runBoundedChild, testTimeoutFor } from "./bounded-child.js";

// The CLI over an empty range used 0.18 s of CPU idle and 0.28 s loaded, but
// it starts about 13 processes in sequence (Node, then one per git query), and
// each start waited to be scheduled under load
// (docs/tool-child-process-test-bounds.md).
const CLI_BUDGET_MS = budgetForCpuWork(300, 13);

describe("changelog analysis", () => {
  it("collects git evidence and formats it without changing its source", () => {
    const calls: string[] = [];
    const runGit = (args: string[]) => {
      calls.push(args.join(" "));
      if (args[0] === "log") return "abc 2026-01-01 change\n";
      if (args[0] === "rev-list") return "1\n";
      if (args[0] === "tag") return "v1.0.0\n";
      if (args.includes("--numstat")) return "2\t1\tsrc/cli/new.ts\n1\t0\tdocs/new.md\n";
      if (args.includes("--name-status")) return "A\tsrc/cli/new.ts\nA\tdocs/new.md\n";
      if (args[0] === "show") return '{"version":"1.0.0","bin":{}}';
      return "";
    };
    const analysis = collectChangelog(
      { base: "v1.0.0", head: "HEAD", next: "1.0.1" },
      { runGit, runGitOk: () => null },
    );
    expect(analysis.error).toBeUndefined();
    expect(analysis.prodAdd).toBe(2);
    expect(analysis.totAdd).toBe(3);
    expect(formatChangelog(analysis)).toContain("src/cli/new.ts");
    expect(formatChangelog(analysis)).toContain("PRODUCT CODE ONLY:  +2 / -1");
    expect(calls).toContain("diff --numstat --no-renames v1.0.0..HEAD");
  });

  it(
    "runs the CLI against a real git range",
    async () => {
      const result = await runBoundedChild(
        process.execPath,
        ["scripts/changelog-analysis.mjs", "--base", "HEAD", "--head", "HEAD"],
        { budgetMs: CLI_BUDGET_MS },
      );
      expect(result.status, describeChild(result)).toBe(0);
      expect(result.stdout).toContain("Range:             HEAD..HEAD   (0 commits)");
      expect(result.stdout).toContain("PRODUCT CODE ONLY:  +0 / -0");
    },
    testTimeoutFor(CLI_BUDGET_MS),
  );
});

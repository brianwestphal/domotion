import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// DM-NTN9EK: under the ci-staged strategy every verified ticket commit is
// pushed to `integration`, and `main` is fast-forwarded to green staged SHAs.
// Without a concurrency group, a run was queued for every superseded tip and
// the queue backed up for close to an hour. Only the newest green staged tip
// matters, because a later green tip promotes its ancestors with it, so each
// push-triggered staged workflow keeps one group per workflow and ref: the
// running run is never cancelled, and GitHub keeps only the newest pending run.
const WORKFLOWS = ".github/workflows";
const GROUP = "${{ github.workflow }}-${{ github.ref }}";

interface Workflow {
  on?: { push?: { branches?: unknown } } | string | string[];
  concurrency?: unknown;
}

function pushesToIntegration(workflow: Workflow): boolean {
  const on = workflow.on;
  if (on == null || typeof on !== "object" || Array.isArray(on)) return false;
  const branches = on.push?.branches;
  return Array.isArray(branches) && branches.includes("integration");
}

/** Returns why a staged push workflow violates the policy, or null when it complies or is not staged. */
function stagedConcurrencyProblem(source: string): string | null {
  const workflow = parse(source) as Workflow;
  if (!pushesToIntegration(workflow)) return null;
  const concurrency = workflow.concurrency;
  if (concurrency == null || typeof concurrency !== "object") return "missing top-level concurrency";
  const { group, "cancel-in-progress": cancel } = concurrency as Record<string, unknown>;
  if (group !== GROUP) return `concurrency group is ${JSON.stringify(group)}, expected ${GROUP}`;
  if (cancel !== false) return `cancel-in-progress is ${JSON.stringify(cancel)}, expected false`;
  return null;
}

describe("staged-branch workflow concurrency (DM-NTN9EK)", () => {
  const files = readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith(".yml"))
    .sort();
  const sources = new Map(files.map((f) => [f, readFileSync(join(WORKFLOWS, f), "utf8")]));
  const staged = files.filter((f) => pushesToIntegration(parse(sources.get(f)!) as Workflow));

  it("finds the staged push workflows, including ci.yml", () => {
    expect(staged).toContain("ci.yml");
    expect(staged.length).toBeGreaterThanOrEqual(31);
  });

  it("gives every staged push workflow one non-cancelling group per workflow and ref", () => {
    const problems = staged
      .map((f) => [f, stagedConcurrencyProblem(sources.get(f)!)] as const)
      .filter(([, problem]) => problem != null)
      .map(([f, problem]) => `${f}: ${problem}`);
    expect(problems).toEqual([]);
  });

  it("flags a staged workflow without the group, with another group, or that cancels in progress", () => {
    const on = "on:\n  push:\n    branches: [main, integration]\njobs: {}\n";
    expect(stagedConcurrencyProblem(on)).toBe("missing top-level concurrency");
    expect(stagedConcurrencyProblem(`${on}concurrency:\n  group: ci\n  cancel-in-progress: false\n`)).toMatch(
      /concurrency group is "ci"/,
    );
    expect(stagedConcurrencyProblem(`${on}concurrency:\n  group: ${GROUP}\n  cancel-in-progress: true\n`)).toMatch(
      /cancel-in-progress is true/,
    );
    expect(stagedConcurrencyProblem(`${on}concurrency:\n  group: ${GROUP}\n`)).toMatch(
      /cancel-in-progress is undefined/,
    );
    expect(stagedConcurrencyProblem(`${on}concurrency:\n  group: ${GROUP}\n  cancel-in-progress: false\n`)).toBeNull();
  });

  it("ignores workflows that do not push to the staging branch", () => {
    expect(stagedConcurrencyProblem("on:\n  push:\n    branches: [main]\njobs: {}\n")).toBeNull();
    expect(stagedConcurrencyProblem("on: workflow_dispatch\njobs: {}\n")).toBeNull();
  });
});

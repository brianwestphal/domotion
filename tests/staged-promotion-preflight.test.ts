import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { checkStagedPromotion } from "../scripts/check-staged-promotion.mjs";

const MAIN = "a".repeat(40);
const STAGED = "b".repeat(40);
const OTHER = "c".repeat(40);
const REPOSITORY = "brianwestphal/domotion";
const ACTIONS_APP = 15368;
const LINUX = "Linux fidelity regression";
const WINDOWS = "Windows fidelity regression";
const RUNS = `actions/workflows/ci.yml/runs?branch=integration&event=push&head_sha=${STAGED}&per_page=100`;
const PROTECTION = "branches/main/protection/required_status_checks";
const RULES = "rules/branches/main?per_page=100";
const CHECKS = `commits/${STAGED}/check-runs?filter=latest&per_page=100`;
const STATUSES = `commits/${STAGED}/status?per_page=100`;

function workflowRun(options: Record<string, unknown> = {}) {
  return {
    id: 42,
    run_number: 17,
    run_attempt: 2,
    status: "completed",
    conclusion: "success",
    head_sha: STAGED,
    head_branch: "integration",
    event: "push",
    path: ".github/workflows/ci.yml",
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    ...options,
  };
}

function checkRun(id: number, name: string, options: Record<string, unknown> = {}) {
  return {
    id,
    name,
    head_sha: STAGED,
    app: { id: ACTIONS_APP },
    status: "completed",
    conclusion: "success",
    ...options,
  };
}

function page(field: string, records: unknown[], total = records.length) {
  return { [field]: records, total_count: total };
}

function result(stdout: string, status = 0) {
  return { stdout, stderr: "unused", status, signal: null, pid: 1, output: [] };
}

function fixture(
  overrides: {
    api?: Record<string, unknown>;
    ancestor?: number;
    pushOrigin?: string;
    integration?: string;
    secondMain?: string;
    failEndpoint?: string;
    malformedEndpoint?: string;
  } = {},
) {
  const responses = {
    [RUNS]: [page("workflow_runs", [workflowRun()])],
    [PROTECTION]: {
      strict: true,
      contexts: [LINUX, WINDOWS],
      checks: [LINUX, WINDOWS].map((context) => ({ context, app_id: ACTIONS_APP })),
    },
    [RULES]: [[]],
    [CHECKS]: [page("check_runs", [checkRun(51, LINUX)], 2), page("check_runs", [checkRun(52, WINDOWS)], 2)],
    [STATUSES]: [{ sha: STAGED, ...page("statuses", []) }],
    ...overrides.api,
  } as Record<string, unknown>;
  let refReads = 0;
  const run = vi.fn((program: string, args: string[]) => {
    if (program === "git") {
      if (args.join(" ") === "remote get-url origin") return result(`git@github.com:${REPOSITORY}.git\n`);
      if (args.join(" ") === "remote get-url --push --all origin")
        return result(`${overrides.pushOrigin ?? `https://github.com/${REPOSITORY}.git`}\n`);
      if (args.join(" ") === "ls-remote --refs --exit-code origin refs/heads/main refs/heads/integration") {
        const main = refReads++ === 0 ? MAIN : (overrides.secondMain ?? MAIN);
        return result(`${main}\trefs/heads/main\n${overrides.integration ?? STAGED}\trefs/heads/integration\n`);
      }
      if (args.join(" ") === `merge-base --is-ancestor ${MAIN} ${STAGED}`) return result("", overrides.ancestor ?? 0);
    }
    if (program === "gh") {
      expect(args.slice(0, 5)).toEqual(["api", "--hostname", "github.com", "--method", "GET"]);
      const endpoint = args.at(-1)?.replace(`repos/${REPOSITORY}/`, "") ?? "";
      expect(args.at(-1)).toBe(`repos/${REPOSITORY}/${endpoint}`);
      expect(args.slice(5, -1)).toEqual(endpoint === PROTECTION ? [] : ["--paginate", "--slurp"]);
      if (endpoint === overrides.failEndpoint) return result(JSON.stringify(responses[endpoint]), 1);
      if (endpoint === overrides.malformedEndpoint) return result("{");
      if (Object.hasOwn(responses, endpoint)) return result(JSON.stringify(responses[endpoint]));
    }
    throw new Error(`unexpected command ${program} ${args.join(" ")}`);
  });
  return { run, check: (sha = STAGED) => checkStagedPromotion(sha, "/verification", run) };
}

describe("staged promotion preflight (DM-Q8ASR2)", () => {
  it("reports the live tips, exact staged workflow attempt and all paginated checks from the configured App", () => {
    const { check, run } = fixture();
    expect(check()).toEqual({
      status: "ready",
      repository: `github.com/${REPOSITORY}`,
      main: MAIN,
      integration: STAGED,
      stagedRun: { id: 42, attempt: 2, url: `https://github.com/${REPOSITORY}/actions/runs/42` },
      requiredChecks: [
        { context: LINUX, appId: ACTIONS_APP, checkRunIds: [51], commitStatusId: null },
        { context: WINDOWS, appId: ACTIONS_APP, checkRunIds: [52], commitStatusId: null },
      ],
    });
    expect(run.mock.calls.filter(([program, args]) => program === "git" && args[0] === "ls-remote")).toHaveLength(2);
  });

  it("rejects a short SHA before reading anything", () => {
    const { check, run } = fixture();
    expect(() => check(STAGED.slice(0, 8))).toThrow("full-integration-commit-sha");
    expect(run).not.toHaveBeenCalled();
  });

  it("returns a failing CLI exit code without a successful receipt when the exact SHA is missing", () => {
    const result = spawnSync(process.execPath, ["scripts/check-staged-promotion.mjs"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Staged promotion blocked");
  });

  it("runs the CLI when its absolute path goes through a directory alias", () => {
    const temp = mkdtempSync(join(tmpdir(), "domotion-staged-promotion-"));
    try {
      const alias = join(temp, "repo");
      symlinkSync(process.cwd(), alias, "junction");
      const script = join(alias, "scripts/check-staged-promotion.mjs");
      const outcome = spawnSync(process.execPath, [script], { encoding: "utf8" });
      expect(outcome.status).toBe(1);
      expect(outcome.stdout).toBe("");
      expect(outcome.stderr).toContain("full-integration-commit-sha");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("refuses a different live integration tip and a non-fast-forward ancestry result", () => {
    expect(() => fixture({ integration: OTHER }).check()).toThrow("is not the remote integration tip");
    expect(() => fixture({ ancestor: 1 }).check()).toThrow("prove a fast-forward");
  });

  it("refuses a different push repository and branch movement during the check", () => {
    expect(() => fixture({ pushOrigin: "git@github.com:elsewhere/domotion.git" }).check()).toThrow(
      "fetch and push destinations",
    );
    expect(() => fixture({ secondMain: OTHER }).check()).toThrow("origin branches moved");
  });

  it.each([
    { head_sha: OTHER },
    { head_branch: "main" },
    { event: "workflow_dispatch" },
    { path: ".github/workflows/other.yml" },
    { head_repository: { full_name: "elsewhere/domotion" } },
  ])("rejects a CI run with wrong identity %j", (identity) => {
    expect(() => fixture({ api: { [RUNS]: [page("workflow_runs", [workflowRun(identity)])] } }).check()).toThrow(
      "unexpected staged workflow run",
    );
  });

  it.each([
    ["in_progress", null],
    ["completed", "failure"],
    ["queued", null],
  ])("refuses a newer staged run in state %s/%s even when an older exact run passed", (status, conclusion) => {
    const runs = [workflowRun(), workflowRun({ id: 43, run_number: 18, status, conclusion })];
    expect(() => fixture({ api: { [RUNS]: [page("workflow_runs", runs)] } }).check()).toThrow(
      "latest exact staged ci.yml push run 43",
    );
  });

  it("rejects missing exact staged CI and malformed, incomplete or unauthorized API evidence", () => {
    expect(() => fixture({ api: { [RUNS]: [page("workflow_runs", [])] } }).check()).toThrow("no exact staged");
    expect(() => fixture({ malformedEndpoint: PROTECTION }).check()).toThrow("invalid JSON");
    expect(() => fixture({ failEndpoint: PROTECTION }).check()).toThrow(
      "read main's configured required status checks",
    );
    expect(() => fixture({ failEndpoint: RULES }).check()).toThrow("read main's active rulesets");
    expect(() => fixture({ api: { [CHECKS]: [page("check_runs", [checkRun(51, LINUX)], 2)] } }).check()).toThrow(
      "incomplete or duplicate check_runs records",
    );
  });

  it("demands the exact SHA and App for each required context", () => {
    for (const [wrong, message] of [
      [checkRun(52, WINDOWS, { head_sha: OTHER }), "check run for another commit"],
      [checkRun(52, WINDOWS, { app: { id: 9 } }), "is missing its exact-SHA check run"],
    ] as const) {
      expect(() => fixture({ api: { [CHECKS]: [page("check_runs", [checkRun(51, LINUX), wrong])] } }).check()).toThrow(
        message,
      );
    }
    expect(() =>
      fixture({
        api: {
          [PROTECTION]: { strict: true, contexts: [LINUX, WINDOWS], checks: [{ context: LINUX, app_id: ACTIONS_APP }] },
        },
      }).check(),
    ).toThrow("omitted App metadata");
  });

  it.each([
    ["queued", null],
    ["in_progress", null],
    ["completed", "failure"],
    ["completed", "skipped"],
    ["completed", "neutral"],
  ])("rejects a required App check in state %s/%s despite a different App's success", (status, conclusion) => {
    const records = [
      checkRun(51, LINUX),
      checkRun(52, WINDOWS, { status, conclusion }),
      checkRun(53, WINDOWS, { app: { id: 9 } }),
    ];
    expect(() => fixture({ api: { [CHECKS]: [page("check_runs", records)] } }).check()).toThrow("check run 52");
  });

  it("also enforces required contexts from active rulesets and supports an explicitly unbound legacy status", () => {
    const rule = {
      type: "required_status_checks",
      parameters: { required_status_checks: [{ context: "external scan" }] },
    };
    expect(() => fixture({ api: { [RULES]: [[rule]] } }).check()).toThrow("external scan");
    expect(
      fixture({
        api: {
          [RULES]: [[rule]],
          [STATUSES]: [{ sha: STAGED, ...page("statuses", [{ id: 61, context: "External Scan", state: "success" }]) }],
        },
      })
        .check()
        .requiredChecks.at(-1),
    ).toEqual({ context: "external scan", appId: null, checkRunIds: [], commitStatusId: 61 });
  });

  it("refuses an overlapping legacy status that cannot verify the configured App", () => {
    const status = { id: 61, context: WINDOWS, state: "success" };
    expect(() => fixture({ api: { [STATUSES]: [{ sha: STAGED, ...page("statuses", [status]) }] } }).check()).toThrow(
      "legacy commit status without verifiable GitHub App identity",
    );
  });
});

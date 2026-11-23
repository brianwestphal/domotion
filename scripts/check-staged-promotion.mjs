#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { githubOriginRepository, runCommand } from "./verified-worktree-cleanup.mjs";

const SHA = /^[a-f0-9]{40}$/;
const MAIN = "refs/heads/main";
const INTEGRATION = "refs/heads/integration";
const CI_PATH = ".github/workflows/ci.yml";
const USAGE = "Usage: node scripts/check-staged-promotion.mjs <full-integration-commit-sha>";

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function isProviderId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function parseRemoteTips(stdout) {
  const tips = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^([a-f0-9]{40})\t(refs\/heads\/(?:main|integration))$/.exec(line);
    requireThat(match && !tips.has(match[2]), "origin returned unexpected or duplicate branch refs");
    tips.set(match[2], match[1]);
  }
  requireThat(tips.size === 2, "origin must report both main and integration");
  return { main: tips.get(MAIN), integration: tips.get(INTEGRATION) };
}

function collectPages(pages, field) {
  requireThat(Array.isArray(pages) && pages.length > 0, `GitHub returned missing ${field} pages`);
  requireThat(
    pages.every((page) => Array.isArray(page?.[field]) && Number.isSafeInteger(page.total_count)),
    `GitHub returned invalid ${field} pages`,
  );
  const records = pages.flatMap((page) => page[field]);
  requireThat(
    pages.every((page) => page.total_count === records.length) &&
      records.every((record) => isProviderId(record?.id)) &&
      new Set(records.map((record) => record.id)).size === records.length,
    `GitHub returned incomplete or duplicate ${field} records`,
  );
  return records;
}

function requiredContexts(protection, rulePages) {
  requireThat(
    Array.isArray(protection?.contexts) && Array.isArray(protection.checks) && typeof protection.strict === "boolean",
    "main branch protection did not report its configured status checks",
  );
  requireThat(
    Array.isArray(rulePages) && rulePages.length > 0 && rulePages.every(Array.isArray),
    "GitHub did not report the active rules for main",
  );

  const requirements = new Map();
  const add = (context, appId) => {
    requireThat(typeof context === "string" && context.trim().length > 0, "a required context is missing its name");
    requireThat(
      appId === null || appId === -1 || isProviderId(appId),
      `required context ${JSON.stringify(context)} is missing a valid GitHub App setting`,
    );
    const requirement = { context, appId: appId === -1 ? null : appId };
    requirements.set(JSON.stringify(requirement), requirement);
  };

  for (const check of protection.checks) add(check?.context, check?.app_id);
  const classicNames = new Set(protection.checks.map((check) => check.context));
  for (const context of protection.contexts) {
    requireThat(
      classicNames.has(context),
      `main branch protection omitted App metadata for ${JSON.stringify(context)}`,
    );
  }

  for (const rule of rulePages.flat()) {
    requireThat(typeof rule?.type === "string", "GitHub returned an invalid active branch rule");
    if (rule.type !== "required_status_checks") continue;
    const checks = rule.parameters?.required_status_checks;
    requireThat(Array.isArray(checks) && checks.length > 0, "an active ruleset omitted its required status checks");
    for (const check of checks) add(check?.context, check?.integration_id ?? null);
  }
  requireThat(requirements.size > 0, "GitHub reported no required contexts for main");
  return [...requirements.values()];
}

function checkRequiredContext(requirement, checks, statuses) {
  const { context, appId } = requirement;
  const label = `required context ${JSON.stringify(context)}${appId == null ? "" : ` from GitHub App ${appId}`}`;
  const named = checks.filter((check) => check.name === context);
  requireThat(
    named.every((check) => isProviderId(check.app?.id)),
    `${label} has invalid check-run app evidence`,
  );
  const matching = named.filter((check) => appId == null || check.app.id === appId);
  // The GitHub commit-status context key is case insensitive.
  const legacy = statuses.filter((status) => status.context.toLowerCase() === context.toLowerCase());
  requireThat(legacy.length <= 1, `${label} has ambiguous commit statuses`);
  requireThat(appId == null || matching.length > 0, `${label} is missing its exact-SHA check run`);
  requireThat(matching.length > 0 || legacy.length === 1, `${label} has no exact-SHA evidence`);
  for (const check of matching) {
    requireThat(
      check.status === "completed" && check.conclusion === "success",
      `${label} check run ${check.id} is ${JSON.stringify(check.status)}/${JSON.stringify(check.conclusion)}`,
    );
  }
  for (const status of legacy) {
    requireThat(status.state === "success", `${label} commit status ${status.id} is ${JSON.stringify(status.state)}`);
    requireThat(appId == null, `${label} has a legacy commit status without verifiable GitHub App identity`);
  }
  return { ...requirement, checkRunIds: matching.map((check) => check.id), commitStatusId: legacy[0]?.id ?? null };
}

/** The process override is for deterministic tests. The CLI uses bounded Git and GitHub reads. */
export function checkStagedPromotion(sha, cwd = process.cwd(), run = runCommand) {
  requireThat(typeof sha === "string" && SHA.test(sha), USAGE);

  const command = (program, args, description) => {
    const result = run(program, args, cwd);
    requireThat(!result.error && result.status === 0 && typeof result.stdout === "string", `could not ${description}`);
    return result.stdout.trim();
  };
  const git = (args, description) => command("git", args, description);
  const repository = githubOriginRepository(git(["remote", "get-url", "origin"], "read Git origin"));
  const pushOrigins = git(["remote", "get-url", "--push", "--all", "origin"], "read Git push origin").split(/\r?\n/);
  requireThat(
    pushOrigins.length === 1 && githubOriginRepository(pushOrigins[0]).argument === repository.argument,
    "Git origin fetch and push destinations must identify one GitHub repository",
  );
  const readTips = () =>
    parseRemoteTips(
      git(["ls-remote", "--refs", "--exit-code", "origin", MAIN, INTEGRATION], "read live origin branch refs"),
    );
  const tips = readTips();
  requireThat(tips.integration === sha, `${sha} is not the remote integration tip (${tips.integration})`);
  git(["merge-base", "--is-ancestor", tips.main, sha], `prove a fast-forward from remote main ${tips.main} to ${sha}`);

  const api = (endpoint, description, paginate = false) => {
    const args = ["api", "--hostname", repository.host, "--method", "GET"];
    if (paginate) args.push("--paginate", "--slurp");
    const response = command("gh", [...args, `repos/${repository.name}/${endpoint}`], description);
    try {
      return JSON.parse(response);
    } catch {
      throw new Error(`GitHub returned invalid JSON while attempting to ${description}`);
    }
  };

  const runs = collectPages(
    api(
      `actions/workflows/ci.yml/runs?branch=integration&event=push&head_sha=${sha}&per_page=100`,
      "read exact staged push CI runs",
      true,
    ),
    "workflow_runs",
  );
  requireThat(runs.length > 0, "no exact staged ci.yml push run exists");
  requireThat(
    runs.every(
      (run) =>
        run.head_sha === sha &&
        run.head_branch === "integration" &&
        run.event === "push" &&
        run.path === CI_PATH &&
        typeof run.repository?.full_name === "string" &&
        run.repository.full_name.toLowerCase() === repository.name &&
        typeof run.head_repository?.full_name === "string" &&
        run.head_repository.full_name.toLowerCase() === repository.name &&
        isProviderId(run.run_number) &&
        isProviderId(run.run_attempt),
    ),
    "GitHub returned an unexpected staged workflow run",
  );
  requireThat(
    new Set(runs.map((run) => run.run_number)).size === runs.length,
    "GitHub reported conflicting attempts for the same staged workflow run",
  );
  const latest = runs.sort((left, right) => right.run_number - left.run_number)[0];
  requireThat(
    latest.status === "completed" && latest.conclusion === "success",
    `latest exact staged ci.yml push run ${latest.id} is ${JSON.stringify(latest.status)}/${JSON.stringify(latest.conclusion)}`,
  );

  const protection = api(
    "branches/main/protection/required_status_checks",
    "read main's configured required status checks",
  );
  const rules = api("rules/branches/main?per_page=100", "read main's active rulesets", true);
  const requirements = requiredContexts(protection, rules);
  const checks = collectPages(
    api(`commits/${sha}/check-runs?filter=latest&per_page=100`, "read exact-SHA check runs", true),
    "check_runs",
  );
  requireThat(
    checks.every((check) => check.head_sha === sha && typeof check.name === "string"),
    "GitHub returned a check run for another commit or with an invalid name",
  );
  const statusPages = api(`commits/${sha}/status?per_page=100`, "read exact-SHA commit statuses", true);
  const statuses = collectPages(statusPages, "statuses");
  requireThat(
    statusPages.every((page) => page.sha === sha) && statuses.every((status) => typeof status.context === "string"),
    "GitHub returned a commit status for another commit or with an invalid context",
  );

  const requiredChecks = requirements.map((requirement) => checkRequiredContext(requirement, checks, statuses));
  const current = readTips();
  requireThat(
    tips.main === current.main && tips.integration === current.integration,
    "origin branches moved during the preflight",
  );
  return {
    status: "ready",
    repository: repository.argument,
    main: tips.main,
    integration: sha,
    stagedRun: {
      id: latest.id,
      attempt: latest.run_attempt,
      url: `https://${repository.argument}/actions/runs/${latest.id}`,
    },
    requiredChecks,
  };
}

const entry = process.argv[1];
if (entry && existsSync(entry) && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv.length !== 3) throw new Error(USAGE);
    console.log(JSON.stringify(checkStagedPromotion(process.argv[2]), null, 2));
  } catch (error) {
    console.error(`Staged promotion blocked. ${error.message}`);
    process.exitCode = 1;
  }
}

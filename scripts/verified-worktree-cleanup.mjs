#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const SHA = /^[0-9a-f]{40}$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const GATES = ["build", "typecheck", "lint", "test"];
const GENERATED = "src/capture/script.generated.ts";
// Identified by their module suffix. DM-WREGPJ made generation emit the portable
// `node_modules/@domotion/text-engine/dist/...` form; the older
// `[prefix/]packages/text-engine/dist/...` form is still recognized so a
// validation checkout at an earlier shipping SHA keeps the same contract.
const GENERATED_PATHS = ["text-engine/dist/capture/script/emoji-detect.js", "text-engine/dist/font-family-stack.js"];
const VERSION = createHash("sha256")
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest("hex");
const gitEnvironment = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_QUARANTINE_PATH",
];

function requireThat(condition, reason) {
  if (!condition) throw new Error(reason);
}

/** Bind CI authority to Git's fetch origin, never gh's ambient repository/host. */
export function githubOriginRepository(origin) {
  let path;
  const scp = /^git@github\.com:([^?#]+)$/i.exec(origin);
  if (scp) path = scp[1];
  else {
    let url;
    try {
      url = new URL(origin);
    } catch {
      throw new Error("unsupported_github_origin");
    }
    requireThat(
      url.hostname.toLowerCase() === "github.com" &&
        (!url.port || (url.protocol === "ssh:" && url.port === "22")) &&
        !url.password &&
        !url.search &&
        !url.hash &&
        ((url.protocol === "https:" && !url.username) || (url.protocol === "ssh:" && url.username === "git")),
      "unsupported_github_origin",
    );
    path = url.pathname.slice(1);
  }
  const match = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(path);
  requireThat(match && ![".", ".."].includes(match[2]), "unsupported_github_origin");
  const name = `${match[1]}/${match[2]}`.toLowerCase();
  return { host: "github.com", name, argument: `github.com/${name}` };
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileDigest(path) {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytes;
    while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) !== 0) hash.update(buffer.subarray(0, bytes));
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

/** Only the two esbuild module-path comments may differ; all JSON/wrapper/program bytes stay pinned. */
export function generatedWitness(before, after) {
  const decode = (bytes) => {
    const text = bytes.toString("utf8");
    requireThat(Buffer.from(text).equals(bytes), "generated_encoding_changed");
    const match = /^([\s\S]*?export const CAPTURE_SCRIPT: string = )("(?:[^"\\]|\\.)*")(;\n)$/.exec(text);
    requireThat(match, "generated_wrapper_unknown");
    const program = JSON.parse(match[2]);
    requireThat(JSON.stringify(program) === match[2], "generated_noncanonical_literal");
    const lines = program.split("\n");
    const allowed = GENERATED_PATHS.map((path) => {
      const matches = lines.flatMap((line, index) =>
        line.startsWith("// ") && line.endsWith(path) ? [{ path, index, text: line }] : [],
      );
      requireThat(matches.length === 1, "generated_allowed_line_ambiguous");
      requireThat(
        /^\/\/ [A-Za-z0-9_.:/@\\-]+$/.test(matches[0].text) &&
          /^\/\/ (?:(?:[A-Za-z0-9_.:/\\-]+\/)?packages|node_modules\/@domotion)\/text-engine\/dist\//.test(
            matches[0].text,
          ),
        "generated_path_comment_unknown",
      );
      return matches[0];
    });
    const normalized = [...lines];
    for (const line of allowed) normalized[line.index] = `// ${line.path}`;
    return { prefix: match[1], suffix: match[3], normalized: normalized.join("\n"), allowed };
  };
  const left = decode(before),
    right = decode(after);
  requireThat(
    left.prefix === right.prefix && left.suffix === right.suffix && left.normalized === right.normalized,
    "generated_program_or_wrapper_changed",
  );
  requireThat(
    left.allowed.every((line, index) => line.index === right.allowed[index].index),
    "generated_line_position_changed",
  );
  const changes = left.allowed.flatMap((line, index) =>
    line.text === right.allowed[index].text
      ? []
      : [{ path: line.path, line: line.index + 1, before: line.text, after: right.allowed[index].text }],
  );
  requireThat(changes.length === 0 || changes.length === 2, "generated_partial_path_change");
  return {
    rawBeforeHash: digest(before),
    rawAfterHash: digest(after),
    normalizedProgramHash: digest(left.normalized),
    allowedLines: changes,
  };
}

function sameFile(left, right) {
  return ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every((key) => left[key] === right[key]);
}

function generatedSnapshot(path) {
  const before = lstatSync(path, { bigint: true });
  requireThat(before.isFile() && before.nlink === 1n, "generated_regular_file_required");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    requireThat(sameFile(before, fstatSync(fd, { bigint: true })), "generated_file_race");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    requireThat(sameFile(before, after) && sameFile(after, lstatSync(path, { bigint: true })), "generated_file_race");
    return { bytes, stat: after };
  } finally {
    closeSync(fd);
  }
}

function restoreGenerated(path, pristine, changed) {
  const fd = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    requireThat(
      sameFile(changed.stat, fstatSync(fd, { bigint: true })) &&
        readFileSync(fd).equals(changed.bytes) &&
        sameFile(changed.stat, fstatSync(fd, { bigint: true })) &&
        sameFile(changed.stat, lstatSync(path, { bigint: true })),
      "generated_restore_race",
    );
    let offset = 0;
    while (offset < pristine.bytes.length) {
      const written = writeSync(fd, pristine.bytes, offset, pristine.bytes.length - offset, offset);
      requireThat(written > 0, "generated_restore_write_failed");
      offset += written;
    }
    ftruncateSync(fd, pristine.bytes.length);
  } finally {
    closeSync(fd);
  }
  const restored = generatedSnapshot(path);
  requireThat(
    restored.stat.dev === pristine.stat.dev &&
      restored.stat.ino === pristine.stat.ino &&
      restored.bytes.equals(pristine.bytes),
    "generated_restore_race",
  );
}

function privateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

export function runCommand(program, args, cwd, timeout = 30_000, input) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" };
  for (const name of gitEnvironment) delete env[name];
  env.GIT_NO_REPLACE_OBJECTS = "1";
  return spawnSync(program, args, { cwd, env, encoding: "utf8", timeout, input, maxBuffer: 64 * 1024 * 1024 });
}

/** All process injection is test-only; the CLI always uses the bounded native runner. */
export function cleanupAdapter(run = runCommand, progress = () => {}) {
  const command = (program, args, cwd, timeout, input) => {
    const result = run(program, args, cwd, timeout, input);
    requireThat(!result.error && result.status === 0, `command_failed:${program}`);
    return result.stdout.trim();
  };
  const git = (cwd, ...args) => command("git", ["-C", cwd, ...args], cwd);
  const jsonCommand = (program, args, cwd) => JSON.parse(command(program, args, cwd));
  const indexClean = (path) => {
    const flags = command("git", ["-C", path, "ls-files", "-v", "-z"], path).split("\0");
    requireThat(
      flags.every((entry) => !entry || !/^[a-zS]/.test(entry)),
      "hidden_index_state",
    );
    requireThat(
      !git(path, "ls-files", "--stage")
        .split("\n")
        .some((entry) => entry.startsWith("160000 ")),
      "submodule_checkout_unsupported",
    );
  };
  const sourceStatus = (path) => {
    const result = run(
      "git",
      ["-C", path, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"],
      path,
    );
    requireThat(!result.error && result.status === 0, "source_status_unknown");
    return result.stdout;
  };
  const clean = (path) => {
    requireThat(sourceStatus(path) === "", "source_not_clean");
    indexClean(path);
  };
  const ancestor = (project, before, after) => {
    const result = run("git", ["-C", project, "merge-base", "--is-ancestor", before, after], project);
    requireThat(!result.error && [0, 1].includes(result.status), "ancestry_unknown");
    return result.status === 0;
  };

  function checkout(options) {
    const project = realpathSync(options.project);
    const store = realpathSync(options.store);
    requireThat(/^DM-(?:[A-Z0-9]{6}|[0-9]+)$/.test(options.ticket ?? ""), "dm_ticket_required");
    requireThat(SHA.test(options.shipping ?? ""), "full_shipping_sha_required");
    const binding = jsonCommand("hotsheet-cli", ["checkout", "resolve", project], project);
    requireThat(realpathSync(binding.root) === project, "project_binding_mismatch");
    const sources = binding.sources.filter(
      (source) => source.provider === "git" && realpathSync(source.locator) === store,
    );
    requireThat(sources.length === 1 && binding.id && sources[0].connection_id, "qualified_store_required");
    const source = sources[0];
    const ticketText = command("hotsheet-cli", ["-C", store, "show", options.ticket], project);
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(ticketText);
    requireThat(front, "ticket_front_matter_required");
    const ticket = parse(front[1]);
    requireThat(ticket.slug === options.ticket && ULID.test(ticket.id ?? ""), "ticket_identity_mismatch");
    requireThat(["completed", "verified", "archive"].includes(ticket.status), "ticket_not_closed");
    if (ticket.claimed_by) {
      const expiry = Date.parse(ticket.claim_lease_expires_at);
      requireThat(Number.isFinite(expiry) && expiry <= Date.now(), "ticket_claim_active_or_unknown");
    }
    const qualified = `@${binding.id}/${source.connection_id}:${ticket.id}`;
    const common = realpathSync(git(project, "rev-parse", "--path-format=absolute", "--git-common-dir"));
    const key = digest(`${qualified}\n${resolve(options.worktree)}`);
    const directory = join(common, "domotion-worktree-cleanup", key);
    return { project, store, qualified, ticketText, common, directory, key };
  }

  function review(context, options) {
    requireThat(ULID.test(options.reviewNote ?? ""), "review_note_required");
    const block = context.ticketText
      .split(`<!-- hotsheet:note:begin ${options.reviewNote} `)[1]
      ?.split("<!-- hotsheet:note:end -->")[0];
    requireThat(block, "review_note_not_found");
    const payload = /```domotion-cleanup-review\s*\n([\s\S]*?)\n```/.exec(block);
    requireThat(payload, "structured_review_required");
    const value = JSON.parse(payload[1]);
    requireThat(value.version === 1 && value.qualified_ticket === context.qualified, "review_ownership_mismatch");
    requireThat(
      value.source_worktree === resolve(options.worktree) && value.shipping_commit === options.shipping,
      "review_tree_mismatch",
    );
    requireThat(
      SHA.test(value.source_commit ?? "") && typeof value.source_branch === "string",
      "review_source_required",
    );
    requireThat(
      value.worker_retired === true && typeof value.reviewer === "string" && value.reviewer.length > 0,
      "retired_worker_review_required",
    );
    requireThat(value.integration_verified === true, "integration_review_required");
    const actor = /actor_id_hex: ([0-9a-f]+)/.exec(block.split("-->")[0]);
    requireThat(actor && Buffer.from(actor[1], "hex").toString("utf8") === value.reviewer, "review_actor_mismatch");
    requireThat(
      Array.isArray(value.stashes) && value.stashes.every((sha) => SHA.test(sha)),
      "explicit_stash_inventory_required",
    );
    requireThat(
      Array.isArray(value.native_evidence) && value.native_evidence.every((entry) => typeof entry === "string"),
      "native_evidence_inventory_required",
    );
    return { ...value, note: options.reviewNote, digest: digest(payload[1]) };
  }

  function source(context, options, reviewed) {
    const path = resolve(options.worktree);
    requireThat(path !== context.project && realpathSync(path) === path, "canonical_linked_worktree_required");
    const rows = git(context.project, "worktree", "list", "--porcelain", "-z")
      .split("\0\0")
      .map((row) => row.split("\0"));
    const entries = rows.filter((row) => row[0] === `worktree ${path}`);
    requireThat(entries.length === 1, "registered_worktree_required");
    const entry = entries[0];
    requireThat(
      !entry.some((line) => /^(?:locked|prunable|detached)(?: |$)/.test(line)),
      "locked_prunable_or_detached",
    );
    const branch = entry.find((line) => line.startsWith("branch "))?.slice(7);
    requireThat(
      branch === `refs/heads/${reviewed.source_branch}` && branch !== "refs/heads/main",
      "source_branch_mismatch",
    );
    const slug = options.ticket.toLowerCase();
    requireThat(
      reviewed.source_branch === `hs/${slug}` ||
        reviewed.source_branch.startsWith(`hs/${slug}-`) ||
        reviewed.source_branch === basename(path),
      "ticket_branch_mismatch",
    );
    requireThat(
      basename(path) === `domotion-hs-${slug.slice(3)}` ||
        basename(path).startsWith(`domotion-hs-${slug.slice(3)}-`) ||
        (dirname(path) === join(context.project, ".claude", "worktrees") &&
          (basename(path) === slug || basename(path).startsWith(`${slug}-`))),
      "ticket_layout_mismatch",
    );
    requireThat(git(path, "rev-parse", "HEAD") === reviewed.source_commit, "source_head_moved");
    requireThat(
      realpathSync(git(path, "rev-parse", "--path-format=absolute", "--git-common-dir")) === context.common,
      "foreign_worktree",
    );
    clean(path);
    return path;
  }

  function idle(context, path) {
    // `status` opens/migrates the pool and change_batches may persist it. Never use it in inspection.
    const capabilities = jsonCommand(
      "hotsheet-cli",
      ["coordination", "--project", context.project, "capabilities"],
      context.project,
    );
    const stateFile = join(context.common, "hotsheet-coordination", "state.json");
    requireThat(existsSync(stateFile), "coordination_state_missing");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    requireThat(
      state &&
        state.project_id === context.qualified.slice(1).split("/")[0] &&
        [3, 4, 5].includes(state.version) &&
        Array.isArray(capabilities.schemas_read) &&
        capabilities.schemas_read.includes(state.version),
      "coordination_identity_unknown",
    );
    // Empty provider-query summaries are not claim evidence: checkout() reads the selected store directly.
    requireThat(
      state.assignments && typeof state.assignments === "object" && !Array.isArray(state.assignments),
      "coordination_assignment_state_unknown",
    );
    // Legacy native subagents have no pool registration; their exact retirement is reviewed in the note.
    // Registered pools must be quiescent: do not infer ownership from unrecognized assignment fields.
    requireThat(
      Object.values(state.assignments).every((item) => item?.phase === "done" && !item.recovery),
      "coordination_assignment_active",
    );
    requireThat(
      state.workers && typeof state.workers === "object" && !Array.isArray(state.workers),
      "coordination_worker_state_unknown",
    );
    requireThat(
      Object.values(state.workers).every(
        (worker) =>
          worker && Number.isSafeInteger(worker.expires_at) && worker.expires_at <= Math.floor(Date.now() / 1000),
      ),
      "coordination_worker_active_or_unknown",
    );
    const handles = run("lsof", ["+D", path], context.project);
    requireThat(
      !handles.error && handles.status === 1 && handles.stdout.trim() === "" && handles.stderr.trim() === "",
      "worktree_handles_active_or_unknown",
    );
  }

  function remote(context, options) {
    const repository = githubOriginRepository(git(context.project, "remote", "get-url", "origin"));
    const line = git(context.project, "ls-remote", "--exit-code", "origin", "refs/heads/main");
    const match = /^([0-9a-f]{40})\s+refs\/heads\/main$/.exec(line);
    requireThat(
      match && ancestor(context.project, options.shipping, match[1]),
      "shipping_not_preserved_on_remote_main",
    );
    const runs = jsonCommand(
      "gh",
      [
        "run",
        "list",
        "--repo",
        repository.argument,
        "--branch",
        "main",
        "--workflow",
        "ci.yml",
        "--limit",
        "100",
        "--json",
        "databaseId,headSha,headBranch,event,workflowName,status,conclusion,createdAt,url",
      ],
      context.project,
    );
    requireThat(Array.isArray(runs), "ci_state_unknown");
    const covering = runs.filter(
      (run) =>
        run.headBranch === "main" &&
        ["push", "workflow_dispatch"].includes(run.event) &&
        run.workflowName === "CI" &&
        SHA.test(run.headSha ?? "") &&
        Number.isSafeInteger(run.databaseId) &&
        Number.isFinite(Date.parse(run.createdAt)) &&
        ancestor(context.project, options.shipping, run.headSha),
    );
    covering.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.databaseId - a.databaseId);
    requireThat(
      covering[0]?.status === "completed" && covering[0]?.conclusion === "success",
      "latest_covering_main_ci_not_green",
    );
    const selected = covering[0];
    requireThat(ancestor(context.project, selected.headSha, match[1]), "ci_head_not_on_remote_main");
    const detail = jsonCommand(
      "gh",
      ["api", "--hostname", repository.host, `repos/${repository.name}/actions/runs/${selected.databaseId}`],
      context.project,
    );
    requireThat(
      detail.repository?.full_name?.toLowerCase() === repository.name &&
        detail.path === ".github/workflows/ci.yml" &&
        detail.head_sha === selected.headSha &&
        detail.head_branch === "main" &&
        detail.event === selected.event &&
        detail.status === "completed" &&
        detail.conclusion === "success",
      "ci_run_identity_mismatch",
    );
    const shippingWorkflow = git(context.project, "show", `${options.shipping}:.github/workflows/ci.yml`);
    requireThat(
      git(context.project, "show", `${selected.headSha}:.github/workflows/ci.yml`) === shippingWorkflow,
      "covering_ci_workflow_changed",
    );
    const workflow = parse(shippingWorkflow);
    requireThat(
      workflow.name === "CI" && workflow.jobs && Object.keys(workflow.jobs).length > 0,
      "ci_contract_unknown",
    );
    requireThat(!workflow.on?.workflow_dispatch?.inputs, "ci_profile_contract_unsupported");
    const expected = Object.entries(workflow.jobs).flatMap(([id, job]) => {
      requireThat(!job.if && !job.uses && !job.name, "ci_job_contract_unsupported");
      if (!job.strategy?.matrix) return [id];
      const matrix = job.strategy.matrix;
      requireThat(!matrix.include && !matrix.exclude, "ci_matrix_contract_unsupported");
      let combinations = [[]];
      for (const values of Object.values(matrix)) {
        requireThat(
          Array.isArray(values) &&
            values.length > 0 &&
            values.every((value) => typeof value === "string" || typeof value === "number"),
          "ci_matrix_contract_unsupported",
        );
        combinations = combinations.flatMap((parts) => values.map((value) => [...parts, value]));
      }
      return combinations.map((parts) => `${id} (${parts.join(", ")})`);
    });
    const jobs = jsonCommand(
      "gh",
      ["run", "view", String(selected.databaseId), "--repo", repository.argument, "--json", "jobs"],
      context.project,
    ).jobs;
    requireThat(
      Array.isArray(jobs) &&
        jobs.length === expected.length &&
        expected.every(
          (name) =>
            jobs.filter((job) => job.name === name && job.status === "completed" && job.conclusion === "success")
              .length === 1,
        ),
      "ci_required_jobs_not_green",
    );
    return { remote: match[1], ci: selected.databaseId };
  }

  function gateReceipt(context, options) {
    const tree = git(context.project, "rev-parse", `${options.shipping}^{tree}`);
    requireThat(
      !existsSync(join(context.common, "domotion-cleanup-gates", "locks", tree)),
      "exact_tree_gate_running_or_interrupted",
    );
    const path = join(context.common, "domotion-cleanup-gates", `${tree}.json`);
    requireThat(existsSync(path), "exact_tree_gate_missing");
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    requireThat(
      receipt.version === VERSION &&
        receipt.tree === tree &&
        receipt.commit === options.shipping &&
        JSON.stringify(receipt.gates) === JSON.stringify(GATES) &&
        receipt.success === true,
      "exact_tree_gate_invalid",
    );
    requireThat(/^[0-9a-f-]{36}$/.test(receipt.record ?? ""), "exact_tree_record_missing");
    const recordBytes = readFileSync(
      join(context.common, "domotion-cleanup-gates", "records", tree, `${receipt.record}.json`),
    );
    const record = JSON.parse(recordBytes);
    requireThat(
      digest(recordBytes) === receipt.recordHash &&
        record.version === VERSION &&
        record.tree === tree &&
        record.commit === options.shipping &&
        record.success === true &&
        record.generated?.length === GATES.length,
      "exact_tree_record_invalid",
    );
    return tree;
  }

  function ignored(path) {
    const result = run("git", ["-C", path, "ls-files", "--others", "--ignored", "--exclude-standard", "-z"], path);
    requireThat(!result.error && result.status === 0, "ignored_inventory_failed");
    const output = result.stdout;
    return (output ? output.split("\0").filter(Boolean) : []).sort().map((name) => {
      requireThat(!isAbsolute(name) && !name.split(/[\\/]/).includes("..") && name !== ".git", "unsafe_ignored_path");
      const source = join(path, name);
      const stat = lstatSync(source);
      // Never traverse a symlinked parent (e.g. a shared node_modules package).
      for (let parent = dirname(source); parent !== path; parent = dirname(parent))
        requireThat(!lstatSync(parent).isSymbolicLink(), "ignored_symlink_parent");
      requireThat(stat.isSymbolicLink() || (stat.isFile() && stat.nlink === 1), "unsupported_ignored_file");
      return {
        name,
        type: stat.isSymbolicLink() ? "symlink" : "file",
        mode: stat.mode & 0o777,
        size: stat.size,
        hash: stat.isSymbolicLink() ? digest(readlinkSync(source)) : fileDigest(source),
      };
    });
  }

  function stashInventory(context, reviewed) {
    for (const sha of reviewed.stashes) {
      requireThat(git(context.project, "rev-parse", `${sha}^{commit}`) === sha, "stash_object_missing");
      requireThat(
        git(context.project, "rev-list", "--parents", "-n", "1", sha).split(" ").length >= 3,
        "stash_commit_required",
      );
    }
  }

  function inspect(options) {
    const context = checkout(options);
    const reviewed = review(context, options);
    const path = source(context, options, reviewed);
    idle(context, path);
    const evidence = remote(context, options);
    const tree = gateReceipt(context, options);
    stashInventory(context, reviewed);
    const inventory = ignored(path);
    return { context, reviewed, path, tree, inventory, evidence };
  }

  function gate(options) {
    requireThat(SHA.test(options.shipping ?? ""), "full_shipping_sha_required");
    const validation = realpathSync(options.validation);
    const project = realpathSync(options.project);
    requireThat(validation !== project, "isolated_validation_required");
    const common = realpathSync(git(project, "rev-parse", "--path-format=absolute", "--git-common-dir"));
    requireThat(
      realpathSync(git(validation, "rev-parse", "--show-toplevel")) === validation,
      "validation_root_required",
    );
    requireThat(
      git(project, "worktree", "list", "--porcelain", "-z")
        .split("\0\0")
        .some((entry) => entry.startsWith(`worktree ${validation}\0`)),
      "registered_validation_required",
    );
    requireThat(
      realpathSync(git(validation, "rev-parse", "--path-format=absolute", "--git-common-dir")) === common,
      "foreign_validation_checkout",
    );
    clean(validation);
    requireThat(git(validation, "rev-parse", "HEAD") === options.shipping, "validation_head_mismatch");
    requireThat(
      git(validation, "ls-files", "--error-unmatch", "--", GENERATED) === GENERATED,
      "generated_tracked_file_required",
    );
    const artifact = join(validation, GENERATED);
    const pristine = generatedSnapshot(artifact);
    generatedWitness(pristine.bytes, pristine.bytes);
    const tree = git(validation, "rev-parse", "HEAD^{tree}");
    const lock = join(common, "domotion-cleanup-gates", "locks", tree);
    mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
    requireThat(!existsSync(lock), "exact_tree_gate_running_or_interrupted");
    mkdirSync(lock, { mode: 0o700 });
    const receipt = join(common, "domotion-cleanup-gates", `${tree}.json`);
    const recordId = randomUUID();
    const logDirectory = join(common, "domotion-cleanup-gates", "logs", tree, recordId);
    mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(logDirectory, "generated-before.txt"), pristine.bytes, { flag: "wx", mode: 0o600 });
    let invalidated = false;
    try {
      // A failed or interrupted rerun must never leave a prior successful receipt authoritative.
      privateJson(receipt, {
        version: VERSION,
        commit: options.shipping,
        tree,
        gates: GATES,
        success: false,
        started: new Date().toISOString(),
      });
      invalidated = true;
      const generated = [];
      let changed = pristine;
      for (const name of GATES) {
        progress({ status: "gate_running", command: name });
        const result = run("npm", ["run", name], validation, 30 * 60_000);
        privateJson(join(logDirectory, `${name}.json`), {
          command: name,
          status: result.status,
          signal: result.signal ?? null,
          error: result.error?.code ?? null,
          stdout: result.stdout,
          stderr: result.stderr,
        });
        requireThat(!result.error && result.status === 0, "command_failed:npm");
        changed = generatedSnapshot(artifact);
        requireThat(
          ["dev", "ino", "mode", "nlink"].every((key) => pristine.stat[key] === changed.stat[key]),
          "generated_file_replaced",
        );
        generated.push({ command: name, ...generatedWitness(pristine.bytes, changed.bytes) });
        requireThat(["", ` M ${GENERATED}\0`].includes(sourceStatus(validation)), "source_not_clean");
        indexClean(validation);
        requireThat(git(validation, "rev-parse", "HEAD") === options.shipping, "validation_head_moved");
        progress({ status: "gate_passed", command: name });
      }
      if (!pristine.bytes.equals(changed.bytes)) {
        writeFileSync(join(logDirectory, "generated-after.txt"), changed.bytes, { flag: "wx", mode: 0o600 });
        requireThat(
          sourceStatus(validation) === ` M ${GENERATED}\0` && git(validation, "rev-parse", "HEAD") === options.shipping,
          "generated_restore_race",
        );
        restoreGenerated(artifact, pristine, changed);
      }
      clean(validation);
      requireThat(git(validation, "rev-parse", "HEAD") === options.shipping, "validation_head_moved");
      const completed = {
        version: VERSION,
        commit: options.shipping,
        tree,
        gates: GATES,
        success: true,
        generated,
        completed: new Date().toISOString(),
      };
      const recordPath = join(common, "domotion-cleanup-gates", "records", tree, `${recordId}.json`);
      mkdirSync(dirname(recordPath), { recursive: true, mode: 0o700 });
      const recordBytes = Buffer.from(`${JSON.stringify(completed, null, 2)}\n`);
      writeFileSync(recordPath, recordBytes, { flag: "wx", mode: 0o600 });
      privateJson(receipt, { ...completed, record: recordId, recordHash: digest(recordBytes) });
      return { status: "gate_recorded", tree };
    } finally {
      if (invalidated) rmdirSync(lock);
    }
  }

  function execute(options) {
    // POSIX chmod bits cannot certify private Windows ACL preservation.
    requireThat(["darwin", "linux"].includes(process.platform), "unsupported_cleanup_platform");
    const verified = inspect(options);
    const { context, reviewed, path, inventory } = verified;
    requireThat(!existsSync(join(context.directory, "intent.json")), "cleanup_intent_exists_manual_recovery_required");
    requireThat(!existsSync(context.directory), "preservation_directory_exists_manual_review_required");
    mkdirSync(dirname(context.directory), { recursive: true, mode: 0o700 });
    // Exclusive mkdir claims this cleanup identity before copying or writing any refs.
    mkdirSync(context.directory, { mode: 0o700 });
    const files = join(context.directory, "preserved");
    mkdirSync(files, { recursive: true, mode: 0o700 });
    for (const item of inventory) {
      const destination = join(files, item.name);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      requireThat(!existsSync(destination), "preservation_destination_exists");
      if (item.type === "symlink") symlinkSync(readlinkSync(join(path, item.name)), destination);
      else {
        copyFileSync(join(path, item.name), destination);
        chmodSync(destination, 0o600);
      }
      requireThat(
        (item.type === "symlink" ? digest(readlinkSync(destination)) : fileDigest(destination)) === item.hash,
        "preservation_verification_failed",
      );
    }
    const archive = `refs/domotion/cleanup-source/${context.key}`;
    const existing = run("git", ["-C", context.project, "rev-parse", "--quiet", "--verify", archive], context.project);
    requireThat(
      !existing.error &&
        (existing.status === 1 || (existing.status === 0 && existing.stdout.trim() === reviewed.source_commit)),
      "source_archive_conflict",
    );
    git(
      context.project,
      "update-ref",
      archive,
      reviewed.source_commit,
      existing.status === 0 ? reviewed.source_commit : "0".repeat(40),
    );
    for (const sha of reviewed.stashes) {
      const ref = `refs/domotion/cleanup-stash/${sha}`;
      const old = run("git", ["-C", context.project, "rev-parse", "--quiet", "--verify", ref], context.project);
      requireThat(
        !old.error && (old.status === 1 || (old.status === 0 && old.stdout.trim() === sha)),
        "stash_archive_conflict",
      );
      git(context.project, "update-ref", ref, sha, old.status === 0 ? sha : "0".repeat(40));
    }
    privateJson(join(context.directory, "preservation.json"), {
      version: 1,
      review: reviewed,
      inventory,
      archive,
      recorded: new Date().toISOString(),
    });
    // Re-read live authority, remote CI, HEAD, dirt and ignored bytes immediately before removal.
    const again = inspect(options);
    requireThat(
      JSON.stringify(again.inventory) === JSON.stringify(inventory) && again.reviewed.digest === reviewed.digest,
      "preflight_changed",
    );
    privateJson(join(context.directory, "intent.json"), {
      version: 1,
      state: "prepared",
      ...options,
      source: reviewed.source_commit,
      branch: reviewed.source_branch,
      archive,
      tree: verified.tree,
      evidence: again.evidence,
    });
    try {
      git(context.project, "worktree", "remove", "--", path);
      // One ref transaction proves archives still exist while compare-and-swap deletes only this branch.
      const transaction = [
        "start",
        `verify ${archive} ${reviewed.source_commit}`,
        ...reviewed.stashes.map((sha) => `verify refs/domotion/cleanup-stash/${sha} ${sha}`),
        `delete refs/heads/${reviewed.source_branch} ${reviewed.source_commit}`,
        "prepare",
        "commit",
        "",
      ].join("\n");
      command("git", ["-C", context.project, "update-ref", "--stdin"], context.project, 30_000, transaction);
      privateJson(join(context.directory, "result.json"), {
        status: "removed",
        source: reviewed.source_commit,
        shipping: options.shipping,
        tree: verified.tree,
        evidence: again.evidence,
        preservedEntries: inventory.length,
      });
    } catch (error) {
      error.cleanupStatus = "interrupted";
      throw error;
    }
    return {
      status: "removed",
      preservedEntries: inventory.length,
      preservation: context.directory,
      ci: again.evidence.ci,
    };
  }

  return { inspect, gate, execute };
}

export function parseOptions(args) {
  const options = { action: "inspect" };
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === "--execute" || name === "--gate") {
      requireThat(options.action === "inspect", "conflicting_action_flags");
      options.action = name === "--execute" ? "execute" : "gate";
    } else {
      const key = {
        "--project": "project",
        "--store": "store",
        "--ticket": "ticket",
        "--worktree": "worktree",
        "--shipping": "shipping",
        "--review-note": "reviewNote",
        "--validation": "validation",
      }[name];
      requireThat(key && args[index + 1] && !args[index + 1].startsWith("--"), "unknown_or_missing_option");
      requireThat(options[key] === undefined, "duplicate_option");
      options[key] = args[++index];
    }
  }
  requireThat(options.project && options.shipping, "project_and_shipping_required");
  requireThat(
    options.action === "gate"
      ? options.validation
      : options.store && options.ticket && options.worktree && options.reviewNote,
    "required_options_missing",
  );
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length === 3 && process.argv[2] === "--help") {
      console.log(
        "Inspect (default): --project MAIN --store STORE --ticket DM-SLUG --worktree PATH --shipping FULL_SHA --review-note ULID\nExecute: same options plus --execute\nExact gate: --gate --project MAIN --validation CLEAN_CHECKOUT --shipping FULL_SHA\nSee scripts/verified-worktree-cleanup.md. No force or bypass options.",
      );
    } else {
      const options = parseOptions(process.argv.slice(2));
      const adapter = cleanupAdapter(runCommand, (value) => console.error(JSON.stringify(value)));
      if (options.action === "inspect") {
        const result = adapter.inspect(options);
        console.log(
          JSON.stringify({
            status: "ready",
            action: "inspect",
            tree: result.tree,
            ci: result.evidence.ci,
            ignoredEntriesToPreserve: result.inventory.length,
          }),
        );
      } else console.log(JSON.stringify(adapter[options.action](options)));
    }
  } catch (error) {
    const reason =
      error instanceof Error && /^[a-z_]+(?::[a-z-]+)?$/.test(error.message) ? error.message : "io_or_protocol_failure";
    console.error(
      JSON.stringify({ status: error?.cleanupStatus === "interrupted" ? "interrupted" : "refused", reason }),
    );
    process.exitCode = 1;
  }
}

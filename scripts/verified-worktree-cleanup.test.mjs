import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  readlinkSync,
  realpathSync,
  lstatSync,
  linkSync,
  unlinkSync,
  renameSync,
  rmSync,
  cpSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

import {
  cleanupAdapter,
  generatedWitness,
  githubOriginRepository,
  parseOptions,
  runCommand as nativeRunCommand,
} from "./verified-worktree-cleanup.mjs";

import { createCleanupTestProgress, CLEANUP_GIT_OPERATIONS as gitOperations } from "./cleanup-test-progress.mjs";

let nativeCommands = 0;
const trace = createCleanupTestProgress({
  enabled: process.env.DOMOTION_CLEANUP_TEST_PROGRESS === "1",
  write: (line) => writeSync(2, line),
});
function progress(value) {
  trace.emit(value);
}
if (process.env.DOMOTION_CLEANUP_TEST_PROGRESS === "1")
  process.once("exit", (code) => progress({ phase: "process-exit", status: code }));
function runCommand(program, args, cwd, timeout, input) {
  const index = ++nativeCommands;
  const operation = program === "git" ? (args.find((arg) => gitOperations.has(arg)) ?? "other") : "node";
  progress({ nativeCommand: index, operation, phase: "start" });
  const started = performance.now();
  try {
    const result = nativeRunCommand(program, args, cwd, timeout, input);
    progress({
      nativeCommand: index,
      operation,
      phase: "returned",
      durationMs: performance.now() - started,
      childPid: result.pid,
      status: result.status,
      signal: result.signal,
      error: result.error?.code,
    });
    return result;
  } catch (error) {
    progress({ nativeCommand: index, operation, phase: "threw", durationMs: performance.now() - started });
    throw error;
  }
}

const TICKET = "DM-ABC123";
const ID = "01M6ZNH24355GRR7NRVB9GWT2B";
const NOTE = "01M71FNCABZVV7S4QY7KRJ1KZK";
const QUALIFIED = `@domotion-fixture/source:${ID}`;
const GENERATED = "src/capture/script.generated.ts";
const PROGRAM =
  "\n// ../../../old/packages/text-engine/dist/capture/script/emoji-detect.js\nconst emoji = 1;\n// ../../../old/packages/text-engine/dist/font-family-stack.js\nconst family = 2;\n";
const generatedFile = (program = PROGRAM) =>
  Buffer.from(`// Generated fixture\nexport const CAPTURE_SCRIPT: string = ${JSON.stringify(program)};\n`);

const seeds = new Map();
const seedRoots = new Set();
after(() => {
  const started = performance.now();
  let returned = false;
  progress({ phase: "seed-cleanup", step: "start" });
  try {
    for (const root of seedRoots) rmSync(root, { recursive: true, force: true });
    returned = true;
  } finally {
    progress({ phase: "seed-cleanup", step: returned ? "returned" : "threw", durationMs: performance.now() - started });
  }
  progress({ phase: "complete", nativeCommands });
});

// Repositories are copied before any linked worktrees exist. Every test still
// owns independent object files, refs, index, remote and native worktree/gate
// operations; only identical initial history creation is shared as input.
function prepareSeed({ legacy, cherryPick }) {
  const key = `${legacy}:${cherryPick}`;
  if (seeds.has(key)) return seeds.get(key);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dm-cleanup-seed-")));
  seedRoots.add(root);
  const project = join(root, "project");
  mkdirSync(project);
  const native = (program, args, cwd = project, timeout, input) => runCommand(program, args, cwd, timeout, input);
  const git = (...args) => {
    const result = native("git", ["-C", project, ...args]);
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(root, "empty-hooks"));
  git("config", "core.hooksPath", join(root, "empty-hooks"));
  git("config", "core.fsmonitor", "false");
  mkdirSync(join(project, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(project, ".github", "workflows", "ci.yml"),
    "name: CI\non: [push, workflow_dispatch]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps: []\n  git-install:\n    strategy:\n      matrix:\n        os: [ubuntu-latest, macos-latest, windows-latest]\n    runs-on: ${{ matrix.os }}\n    steps: []\n",
  );
  writeFileSync(join(project, ".gitignore"), "private/\nnode_modules/\n.claude/worktrees/\n");
  writeFileSync(join(project, "source.txt"), "base\n");
  mkdirSync(join(project, "src", "capture"), { recursive: true });
  writeFileSync(join(project, GENERATED), generatedFile());
  git("add", ".");
  git("commit", "-m", "base");
  const branch = legacy ? "dm-abc123-reviewed" : "hs/dm-abc123";
  git("switch", "-c", branch);
  writeFileSync(join(project, "source.txt"), "integrated\n");
  git("add", "source.txt");
  git("commit", "-m", `${TICKET} fixture source`);
  const source = git("rev-parse", "HEAD");
  git("switch", "main");
  if (cherryPick) {
    writeFileSync(join(project, "unrelated.txt"), "independent\n");
    git("add", "unrelated.txt");
    git("commit", "-m", "independent main change");
    git("cherry-pick", source);
  } else git("merge", "--ff-only", branch);
  const shipping = git("rev-parse", "HEAD");
  const remote = join(root, "remote.git");
  assert.equal(native("git", ["init", "--bare", remote]).status, 0);
  git("remote", "add", "origin", remote);
  git("push", "origin", "main");
  assert.equal(existsSync(join(project, ".git", "worktrees")), false);
  const seed = { root, project, remote, branch, source, shipping };
  seeds.set(key, seed);
  return seed;
}

function fixture(t, { legacy = false, cherryPick = false } = {}) {
  progress({ phase: "fixture", case: t.name.slice(0, 192) });
  const seed = prepareSeed({ legacy, cherryPick });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dm-cleanup-test-")));
  t.after(() => {
    const started = performance.now();
    let returned = false;
    progress({ phase: "fixture", case: t.name, step: "cleanup-start" });
    try {
      rmSync(root, { recursive: true, force: true });
      returned = true;
    } finally {
      progress({
        phase: "fixture",
        case: t.name,
        step: returned ? "cleanup-returned" : "cleanup-threw",
        durationMs: performance.now() - started,
      });
    }
  });
  const project = join(root, "project"),
    store = join(root, "store"),
    remote = join(root, "remote.git");
  const copyStarted = performance.now();
  let copied = false;
  progress({ phase: "fixture", case: t.name, step: "copy-start" });
  try {
    cpSync(seed.project, project, { recursive: true });
    cpSync(seed.remote, remote, { recursive: true });
    copied = true;
  } finally {
    progress({
      phase: "fixture",
      case: t.name,
      step: copied ? "copy-returned" : "copy-threw",
      durationMs: performance.now() - copyStarted,
    });
  }
  mkdirSync(store);
  mkdirSync(join(root, "empty-hooks"));
  const native = (program, args, cwd = project, timeout, input) => runCommand(program, args, cwd, timeout, input);
  const git = (...args) => {
    const result = native("git", ["-C", project, ...args]);
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git("config", "core.hooksPath", join(root, "empty-hooks"));
  git("remote", "set-url", "origin", remote);
  const { branch, source, shipping } = seed;
  const worktree = legacy ? join(project, ".claude", "worktrees", branch) : join(root, "domotion-hs-abc123");
  git("worktree", "add", worktree, branch);
  const validation = join(root, "validation");
  git("worktree", "add", "--detach", validation, shipping);
  const review = {
    version: 1,
    qualified_ticket: QUALIFIED,
    source_worktree: worktree,
    source_branch: branch,
    source_commit: source,
    shipping_commit: shipping,
    reviewer: "fixture-integrator",
    worker_retired: true,
    integration_verified: true,
    stashes: [],
    native_evidence: [],
  };
  const state = {
    ticketStatus: "completed",
    claim: "",
    review,
    source,
    shipping,
    branch,
    worktree,
    project,
    validation,
    store,
    note: NOTE,
    actor: "fixture-integrator",
    git,
    gateCalls: [],
    gateFailure: null,
    handles: { status: 1, stdout: "", stderr: "" },
    workers: [],
    assignments: {},
    schema: 3,
    corruptDetail: false,
    origin: "git@github.com:fixture/domotion.git",
    responseRepository: "fixture/domotion",
    failedJobs: false,
    extraJobs: false,
    handleChecks: 0,
    runs: [
      {
        databaseId: 42,
        headSha: shipping,
        headBranch: "main",
        event: "push",
        workflowName: "CI",
        status: "completed",
        conclusion: "success",
        createdAt: "2026-11-10T01:00:00Z",
      },
    ],
  };
  const run = (program, args, cwd, timeout, input) => {
    const success = (value) => ({
      status: 0,
      stdout: typeof value === "string" ? value : JSON.stringify(value),
      stderr: "",
    });
    if (program === "hotsheet-cli") {
      if (args[0] === "checkout")
        return success({
          id: "domotion-fixture",
          root: project,
          sources: [{ provider: "git", locator: state.bindingStore ?? store, connection_id: "source" }],
        });
      if (args.includes("show"))
        return success(
          `---\nid: ${ID}\nslug: ${TICKET}\nstatus: ${state.ticketStatus}\n${state.claim}\n---\n<!-- hotsheet:note:begin ${state.note} kind: regular actor_id_hex: ${Buffer.from(state.actor).toString("hex")} -->\n\`\`\`domotion-cleanup-review\n${JSON.stringify(state.review)}\n\`\`\`\n<!-- hotsheet:note:end -->`,
        );
      if (args.includes("coordination")) {
        assert.ok(args.includes("capabilities"), "inspection must never open/status/migrate the live pool");
        const directory = join(project, ".git", "hotsheet-coordination");
        mkdirSync(directory, { recursive: true });
        const contents = JSON.stringify({
          version: state.schema,
          project_id: "domotion-fixture",
          assignments: state.assignments,
          workers: Object.fromEntries(state.workers.map((worker, index) => [String(index), worker])),
        });
        const authority = join(directory, "state.json");
        if (!existsSync(authority) || readFileSync(authority, "utf8") !== contents) writeFileSync(authority, contents);
        return success({ schemas_read: state.readSchemas ?? [3, 4, 5] });
      }
    }
    if (program === "lsof") {
      state.handleChecks++;
      state.onHandles?.(state.handleChecks);
      return state.handles;
    }
    if (program === "npm") {
      state.gateCalls.push({ args, cwd, timeout });
      if (state.gateFailure === args[1]) return { status: 1, stdout: "", stderr: "failed" };
      if (state.gateMutation === args[1]) writeFileSync(join(cwd, "source.txt"), "dirty after gate\n");
      state.generatedMutation?.(args[1], join(cwd, GENERATED));
      return success("");
    }
    if (program === "gh") {
      if (args[0] === "run") assert.equal(args[args.indexOf("--repo") + 1], "github.com/fixture/domotion");
      if (args[1] === "list") return success(state.runs);
      if (args[0] === "api") {
        assert.equal(args[args.indexOf("--hostname") + 1], "github.com");
        const endpoint = args.find((arg) => arg.startsWith("repos/"));
        assert.ok(endpoint.startsWith("repos/fixture/domotion/actions/runs/"));
        const selected = state.runs.find((item) => String(item.databaseId) === endpoint.split("/").at(-1));
        return success({
          repository: { full_name: state.responseRepository },
          path: state.corruptDetail ? ".github/workflows/focused.yml" : ".github/workflows/ci.yml",
          head_sha: selected.headSha,
          head_branch: selected.headBranch,
          event: selected.event,
          status: selected.status,
          conclusion: selected.conclusion,
        });
      }
      const jobs = [
        "build",
        "git-install (ubuntu-latest)",
        "git-install (macos-latest)",
        "git-install (windows-latest)",
      ].map((name) => ({
        name,
        status: "completed",
        conclusion: state.failedJobs && name === "build" ? "skipped" : "success",
      }));
      if (state.extraJobs) jobs.push({ name: "unrelated", status: "completed", conclusion: "success" });
      return success({ jobs });
    }
    if (program === "git" && args.slice(2).join(" ") === "remote get-url origin") return success(state.origin);
    if (program === "git" && args.includes("remove") && args.includes("worktree") && state.removeFailure)
      return { status: 1, stdout: "", stderr: "refused removal" };
    if (program === "git" && args.includes("update-ref") && args.includes("--stdin")) state.beforeDelete?.();
    if (program === "git" && args.includes("status")) state.onStatus?.();
    return native(program, args, cwd, timeout, input);
  };
  state.adapter = cleanupAdapter(run, (event) =>
    progress({ phase: "gate", status: event.status, command: event.command }),
  );
  state.options = { project, store, worktree, shipping, ticket: TICKET, reviewNote: NOTE };
  return state;
}

test("prepared Git fixtures retain independent objects, refs, remotes and worktree registrations", (t) => {
  const first = fixture(t),
    second = fixture(t);
  const seed = prepareSeed({ legacy: false, cherryPick: false });
  const object = join(".git", "objects", first.source.slice(0, 2), first.source.slice(2));
  const identities = [first.project, second.project, seed.project].map((project) => {
    const stat = lstatSync(join(project, object));
    assert.equal(stat.nlink, 1, "copied Git objects must never be hardlinked");
    return `${stat.dev}:${stat.ino}`;
  });
  assert.equal(new Set(identities).size, 3);
  assert.equal(first.git("remote", "get-url", "origin"), join(first.project, "..", "remote.git"));
  assert.equal(second.git("remote", "get-url", "origin"), join(second.project, "..", "remote.git"));
  for (const own of [first, second]) {
    const registrations = own.git("worktree", "list", "--porcelain");
    assert.ok(registrations.includes(own.worktree));
    assert.ok(registrations.includes(own.validation));
    assert.ok(!registrations.includes(seed.root));
    assert.ok(!registrations.includes(own === first ? second.project : first.project));
  }
  first.git("branch", "fixture-only-branch");
  assert.equal(second.git("for-each-ref", "refs/heads/fixture-only-branch"), "");
  assert.equal(
    runCommand("git", ["-C", seed.project, "for-each-ref", "refs/heads/fixture-only-branch"], seed.project).stdout,
    "",
  );
  writeFileSync(join(first.worktree, "source.txt"), "only first fixture changes\n");
  assert.equal(readFileSync(join(second.worktree, "source.txt"), "utf8"), "integrated\n");
  gate(second);
  preserved(second);
});

function gate(f) {
  return f.adapter.gate({ project: f.project, shipping: f.shipping, validation: f.validation });
}

function preserved(f) {
  assert.ok(existsSync(f.worktree), "refusal must preserve checkout");
  assert.equal(f.git("rev-parse", `refs/heads/${f.branch}`), f.source, "refusal must preserve branch");
}

test("GitHub CI authority is parsed from supported Git origins", () => {
  for (const origin of [
    "git@github.com:Fixture/Domotion.git",
    "https://github.com/Fixture/Domotion.git",
    "https://github.com/Fixture/Domotion/",
    "ssh://git@github.com/Fixture/Domotion.git",
    "ssh://git@github.com:22/Fixture/Domotion.git",
  ])
    assert.deepEqual(githubOriginRepository(origin), {
      host: "github.com",
      name: "fixture/domotion",
      argument: "github.com/fixture/domotion",
    });
  for (const origin of [
    "/private/tmp/local.git",
    "file:///tmp/local.git",
    "https://github.com.evil.test/fixture/domotion",
    "https://gitlab.example/fixture/domotion",
    "http://github.com/fixture/domotion",
    "https://secret@github.com/fixture/domotion",
    "https://github.com:444/fixture/domotion",
    "https://github.com/fixture/domotion?repo=other",
    "https://github.com/fixture/domotion#other",
    "git@github.com:fixture/domotion/extra",
    "ssh://other@github.com/fixture/domotion",
    "https://github.com/fixture/%64omotion",
  ])
    assert.throws(() => githubOriginRepository(origin), /unsupported_github_origin/);
});

test("Windows cleanup refuses before reading or changing a checkout", { skip: process.platform !== "win32" }, () => {
  const adapter = cleanupAdapter(() => {
    throw new Error("no command may run on this refused path");
  });
  assert.throws(() => adapter.execute({}), /unsupported_cleanup_platform/);
});

test("ambient gh repository and host cannot substitute another repository's green CI", (t) => {
  const previous = { GH_REPO: process.env.GH_REPO, GH_HOST: process.env.GH_HOST };
  process.env.GH_REPO = "other/domotion";
  process.env.GH_HOST = "enterprise.example";
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const f = fixture(t);
  gate(f);
  f.adapter.inspect(f.options); // The injected CLI asserts explicit repository/host on every call.
  preserved(f);
});

test("DM cleanup inspection is read-only and execution privately preserves ignored data, symlinks and explicit stash", (t) => {
  const f = fixture(t, { cherryPick: true });
  writeFileSync(join(f.project, "source.txt"), "private stash\n");
  f.git("stash", "push", "-m", "explicit fixture stash");
  const stash = f.git("rev-parse", "stash@{0}");
  f.review.stashes = [stash];
  mkdirSync(join(f.worktree, "private"));
  const privateName = "private/archive.har \n";
  writeFileSync(join(f.worktree, privateName), Buffer.from([0, 255, 12, 13]));
  const shared = join(f.project, "private");
  mkdirSync(shared);
  writeFileSync(join(shared, "keep.txt"), "shared must survive");
  mkdirSync(join(f.worktree, "node_modules"));
  symlinkSync(shared, join(f.worktree, "node_modules", "shared"));
  gate(f);
  const before = f.git("for-each-ref", "--format=%(refname):%(objectname)");
  const inspected = f.adapter.inspect(f.options);
  assert.equal(inspected.inventory.length, 2);
  assert.equal(f.git("for-each-ref", "--format=%(refname):%(objectname)"), before);
  assert.ok(!existsSync(inspected.context.directory), "inspection must not create preservation/intent");
  const result = f.adapter.execute(f.options);
  assert.equal(result.status, "removed");
  assert.equal(existsSync(f.worktree), false);
  assert.equal(
    runCommand("git", ["-C", f.project, "rev-parse", "--quiet", "--verify", `refs/heads/${f.branch}`], f.project)
      .status,
    1,
  );
  assert.deepEqual(readFileSync(join(result.preservation, "preserved", privateName)), Buffer.from([0, 255, 12, 13]));
  assert.equal(lstatSync(join(result.preservation, "preserved", privateName)).mode & 0o777, 0o600);
  assert.equal(lstatSync(result.preservation).mode & 0o077, 0);
  assert.equal(readlinkSync(join(result.preservation, "preserved", "node_modules", "shared")), shared);
  assert.equal(readFileSync(join(shared, "keep.txt"), "utf8"), "shared must survive");
  assert.equal(f.git("rev-parse", `refs/domotion/cleanup-stash/${stash}`), stash);
  assert.equal(f.git("rev-parse", "stash@{0}"), stash);
  assert.equal(f.git("rev-parse", `refs/domotion/cleanup-source/${inspected.context.key}`), f.source);
  assert.equal(f.gateCalls.length, 4);
  assert.deepEqual(
    f.gateCalls.map((call) => call.args),
    ["build", "typecheck", "lint", "test"].map((name) => ["run", name]),
  );
});

test("reviewed legacy direct layout works without weakening ownership", (t) => {
  const f = fixture(t, { legacy: true });
  gate(f);
  assert.equal(f.adapter.execute(f.options).status, "removed");
});

const refusals = [
  [
    "unsupported origin authority",
    (f) => {
      f.origin = "https://gitlab.example/fixture/domotion.git";
    },
    "unsupported_github_origin",
  ],
  [
    "foreign CI repository despite matching commit",
    (f) => {
      f.responseRepository = "other/domotion";
    },
    "ci_run_identity_mismatch",
  ],
  [
    "foreign ticket-store binding",
    (f) => {
      f.bindingStore = f.project;
    },
    "qualified_store_required",
  ],
  [
    "open ticket",
    (f) => {
      f.ticketStatus = "started";
    },
    "ticket_not_closed",
  ],
  [
    "active exact store claim despite empty coordination claims",
    (f) => {
      f.claim = "claimed_by: worker\nclaim_lease_expires_at: 2999-01-01T00:00:00Z";
    },
    "ticket_claim_active_or_unknown",
  ],
  [
    "unknown claim expiry",
    (f) => {
      f.claim = "claimed_by: worker";
    },
    "ticket_claim_active_or_unknown",
  ],
  [
    "wrong ticket source",
    (f) => {
      f.review.qualified_ticket = "@other/source:wrong";
    },
    "review_ownership_mismatch",
  ],
  [
    "review shipping mismatch",
    (f) => {
      f.review.shipping_commit = "1".repeat(40);
    },
    "review_tree_mismatch",
  ],
  [
    "unretired worker",
    (f) => {
      f.review.worker_retired = false;
    },
    "retired_worker_review_required",
  ],
  [
    "unverified integration",
    (f) => {
      f.review.integration_verified = false;
    },
    "integration_review_required",
  ],
  [
    "review actor mismatch",
    (f) => {
      f.actor = "unrelated-worker";
    },
    "review_actor_mismatch",
  ],
  [
    "unlisted explicit stash inventory",
    (f) => {
      delete f.review.stashes;
    },
    "explicit_stash_inventory_required",
  ],
  [
    "missing native evidence inventory",
    (f) => {
      delete f.review.native_evidence;
    },
    "native_evidence_inventory_required",
  ],
  [
    "changed HEAD",
    (f) => {
      f.review.source_commit = "1".repeat(40);
    },
    "source_head_moved",
  ],
  [
    "branch mismatch",
    (f) => {
      f.review.source_branch = "main";
    },
    "source_branch_mismatch",
  ],
  [
    "tracked dirty",
    (f) => {
      writeFileSync(join(f.worktree, "source.txt"), "unsaved");
    },
    "source_not_clean",
  ],
  [
    "untracked unique file",
    (f) => {
      writeFileSync(join(f.worktree, "unique.txt"), "unsaved");
    },
    "source_not_clean",
  ],
  [
    "hard-linked ignored data",
    (f) => {
      mkdirSync(join(f.worktree, "private"));
      writeFileSync(join(f.worktree, "private", "unique.har"), "retain private bytes");
      linkSync(join(f.worktree, "private", "unique.har"), join(f.worktree, "private", "other.har"));
    },
    "unsupported_ignored_file",
  ],
  [
    "assume-unchanged hides tracked edits",
    (f) => {
      f.git("-C", f.worktree, "update-index", "--assume-unchanged", "source.txt");
      writeFileSync(join(f.worktree, "source.txt"), "hidden unique data");
    },
    "hidden_index_state",
  ],
  [
    "skip-worktree hides tracked edits",
    (f) => {
      f.git("-C", f.worktree, "update-index", "--skip-worktree", "source.txt");
      writeFileSync(join(f.worktree, "source.txt"), "hidden unique data");
    },
    "hidden_index_state",
  ],
  [
    "locked checkout",
    (f) => {
      f.git("worktree", "lock", f.worktree);
    },
    "locked_prunable_or_detached",
  ],
  [
    "active registered worker",
    (f) => {
      f.workers = [{ id: "active" }];
    },
    "coordination_worker_active_or_unknown",
  ],
  [
    "unknown coordination schema",
    (f) => {
      f.schema = 999;
    },
    "coordination_identity_unknown",
  ],
  [
    "missing assignment state",
    (f) => {
      f.assignments = null;
    },
    "coordination_assignment_state_unknown",
  ],
  [
    "active structured assignment",
    (f) => {
      f.assignments = { active: { qualified_ticket: QUALIFIED, phase: "working" } };
    },
    "coordination_assignment_active",
  ],
  [
    "live handles",
    (f) => {
      f.handles = { status: 0, stdout: "open handle", stderr: "" };
    },
    "worktree_handles_active_or_unknown",
  ],
  [
    "lsof error",
    (f) => {
      f.handles = { status: 1, stdout: "", stderr: "permission denied" };
    },
    "worktree_handles_active_or_unknown",
  ],
  [
    "lsof unavailable",
    (f) => {
      f.handles = { status: null, error: new Error("ENOENT"), stdout: "", stderr: "" };
    },
    "worktree_handles_active_or_unknown",
  ],
  [
    "CI pending",
    (f) => {
      f.runs[0].status = "in_progress";
      f.runs[0].conclusion = "";
    },
    "latest_covering_main_ci_not_green",
  ],
  [
    "CI failed",
    (f) => {
      f.runs[0].conclusion = "failure";
    },
    "latest_covering_main_ci_not_green",
  ],
  [
    "manual feature ref",
    (f) => {
      f.runs[0].event = "workflow_dispatch";
      f.runs[0].headBranch = "feature";
    },
    "latest_covering_main_ci_not_green",
  ],
  [
    "focused workflow spoof",
    (f) => {
      f.corruptDetail = true;
    },
    "ci_run_identity_mismatch",
  ],
  [
    "skipped required job",
    (f) => {
      f.failedJobs = true;
    },
    "ci_required_jobs_not_green",
  ],
  [
    "unknown extra job",
    (f) => {
      f.extraJobs = true;
    },
    "ci_required_jobs_not_green",
  ],
  [
    "newer red supersedes old green",
    (f) => {
      f.runs.push({ ...f.runs[0], databaseId: 43, createdAt: "2026-11-10T02:00:00Z", conclusion: "failure" });
    },
    "latest_covering_main_ci_not_green",
  ],
  [
    "unpreserved remote",
    (f) => {
      f.git(
        "--git-dir",
        join(f.project, "..", "remote.git"),
        "update-ref",
        "refs/heads/main",
        f.git("rev-parse", "HEAD~1"),
      );
    },
    "shipping_not_preserved_on_remote_main",
  ],
  [
    "missing stash",
    (f) => {
      f.review.stashes = ["1".repeat(40)];
    },
    "command_failed:git",
  ],
];

for (const [name, mutate, reason] of refusals)
  test(`refusal preserves checkout and branch: ${name}`, (t) => {
    const f = fixture(t);
    gate(f);
    mutate(f);
    assert.throws(
      () => f.adapter.execute(f.options),
      (error) => error.message === reason,
    );
    preserved(f);
  });

test("manual main CI with all canonical jobs can qualify", (t) => {
  const f = fixture(t);
  gate(f);
  f.runs[0].event = "workflow_dispatch";
  assert.equal(f.adapter.inspect(f.options).evidence.ci, 42);
});

test("expired exact claim and retired raw worker session are demonstrably idle", (t) => {
  const f = fixture(t);
  gate(f);
  f.claim = "claimed_by: retired-worker\nclaim_lease_expires_at: 2000-01-01T00:00:00Z";
  f.workers = [{ id: "retired-worker", expires_at: 946684800 }];
  assert.equal(f.adapter.inspect(f.options).evidence.ci, 42);
});

test("missing gate and failed gate never produce cleanup authority", (t) => {
  const f = fixture(t);
  assert.throws(() => f.adapter.inspect(f.options), /exact_tree_gate_missing/);
  f.gateFailure = "lint";
  assert.throws(() => gate(f), /command_failed:npm/);
  assert.deepEqual(
    f.gateCalls.map((call) => call.args[1]),
    ["build", "typecheck", "lint"],
  );
  assert.throws(() => f.adapter.inspect(f.options), /exact_tree_gate_invalid/);
  preserved(f);
});

test("a failed rerun invalidates an earlier successful exact-tree gate", (t) => {
  const f = fixture(t);
  gate(f);
  assert.equal(f.adapter.inspect(f.options).evidence.ci, 42);
  f.gateFailure = "test";
  assert.throws(() => gate(f), /command_failed:npm/);
  assert.throws(() => f.adapter.execute(f.options), /exact_tree_gate_invalid/);
  preserved(f);
});

test("an interrupted or concurrent exact-tree gate cannot be consumed or overwritten", (t) => {
  const f = fixture(t);
  const { tree } = gate(f);
  mkdirSync(join(f.project, ".git", "domotion-cleanup-gates", "locks", tree));
  assert.throws(() => gate(f), /exact_tree_gate_running_or_interrupted/);
  assert.throws(() => f.adapter.execute(f.options), /exact_tree_gate_running_or_interrupted/);
  preserved(f);
});

test("a gate that changes tracked files refuses its receipt", (t) => {
  const f = fixture(t);
  f.gateMutation = "build";
  assert.throws(() => gate(f), /source_not_clean/);
  preserved(f);
});

test("linked-worktree path aliases refuse", (t) => {
  const f = fixture(t);
  gate(f);
  const alias = join(f.project, "..", "alias");
  symlinkSync(f.worktree, alias);
  f.review.source_worktree = alias;
  assert.throws(() => f.adapter.inspect({ ...f.options, worktree: alias }), /canonical_linked_worktree_required/);
  preserved(f);
});

test("ignored data changing after preservation refuses without removing checkout or branch", (t) => {
  const f = fixture(t);
  gate(f);
  mkdirSync(join(f.worktree, "private"));
  writeFileSync(join(f.worktree, "private", "unique.har"), "original");
  f.onHandles = (count) => {
    if (count === 2) writeFileSync(join(f.worktree, "private", "unique.har"), "new data");
  };
  assert.throws(() => f.adapter.execute(f.options), /preflight_changed/);
  preserved(f);
  assert.equal(readFileSync(join(f.worktree, "private", "unique.har"), "utf8"), "new data");
});

test("failed Git removal retains checkout/branch with durable preservation and intent", (t) => {
  const f = fixture(t);
  gate(f);
  const directory = f.adapter.inspect(f.options).context.directory;
  f.removeFailure = true;
  assert.throws(
    () => f.adapter.execute(f.options),
    (error) => error.cleanupStatus === "interrupted",
  );
  preserved(f);
  assert.ok(existsSync(join(directory, "intent.json")));
  assert.ok(existsSync(join(directory, "preservation.json")));
  assert.throws(() => f.adapter.execute(f.options), /cleanup_intent_exists_manual_recovery_required/);
});

test("branch CAS failure after removal is explicitly interrupted with source archive retained", (t) => {
  const f = fixture(t, { cherryPick: true });
  gate(f);
  const inspected = f.adapter.inspect(f.options);
  const advanced = f.git("rev-parse", `${f.source}~1`);
  f.beforeDelete = () => f.git("update-ref", `refs/heads/${f.branch}`, advanced, f.source);
  assert.throws(
    () => f.adapter.execute(f.options),
    (error) => error.cleanupStatus === "interrupted",
  );
  assert.equal(existsSync(f.worktree), false);
  assert.equal(f.git("rev-parse", `refs/heads/${f.branch}`), advanced);
  assert.equal(f.git("rev-parse", `refs/domotion/cleanup-source/${inspected.context.key}`), f.source);
  assert.ok(existsSync(join(inspected.context.directory, "intent.json")));
});

test("losing an archive ref prevents the same transaction from deleting the remaining branch", (t) => {
  const f = fixture(t, { cherryPick: true });
  gate(f);
  const inspected = f.adapter.inspect(f.options);
  const archive = `refs/domotion/cleanup-source/${inspected.context.key}`;
  f.beforeDelete = () => f.git("update-ref", "-d", archive, f.source);
  assert.throws(
    () => f.adapter.execute(f.options),
    (error) => error.cleanupStatus === "interrupted",
  );
  assert.equal(f.git("rev-parse", `refs/heads/${f.branch}`), f.source);
  assert.ok(existsSync(join(inspected.context.directory, "intent.json")));
});

test("stale exact-tree gate content cannot authorize deletion", (t) => {
  const f = fixture(t);
  const result = gate(f);
  const receipt = join(f.project, ".git", "domotion-cleanup-gates", `${result.tree}.json`);
  const value = JSON.parse(readFileSync(receipt, "utf8"));
  value.tree = "0".repeat(40);
  writeFileSync(receipt, JSON.stringify(value));
  assert.throws(() => f.adapter.execute(f.options), /exact_tree_gate_invalid/);
  preserved(f);
});

test("CLI never accepts bypass/force/ambiguous options", () => {
  const base = [
    "--project",
    "/project",
    "--shipping",
    "a".repeat(40),
    "--store",
    "/store",
    "--ticket",
    TICKET,
    "--worktree",
    "/worktree",
    "--review-note",
    NOTE,
  ];
  assert.equal(parseOptions(base).action, "inspect");
  assert.equal(parseOptions([...base, "--execute"]).action, "execute");
  for (const flags of [["--force"], ["--skip-ci"], ["--execute", "--gate"], ["--project", "/other"]])
    assert.throws(() => parseOptions([...base, ...flags]));
  assert.throws(() => parseOptions(["--gate", "--project", "/project", "--shipping", "a".repeat(40)]));
});

test("native runner scrubs inherited Git routing variables", () => {
  const old = process.env.GIT_DIR;
  process.env.GIT_DIR = "/nonexistent-wrong-repository";
  try {
    const result = runCommand(
      process.execPath,
      ["-e", "process.stdout.write(String(process.env.GIT_DIR))"],
      resolve("."),
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "undefined");
  } finally {
    if (old === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = old;
  }
});

test("two gate-owned path comments are restored only after all four gates with immutable provenance", (t) => {
  const f = fixture(t);
  const artifact = join(f.validation, GENERATED);
  const before = readFileSync(artifact);
  const after = generatedFile(PROGRAM.replaceAll("../../../old/", ""));
  f.generatedMutation = (_name, path) => writeFileSync(path, after);
  const { tree } = gate(f);
  assert.deepEqual(readFileSync(artifact), before);
  const receipt = JSON.parse(readFileSync(join(f.project, ".git", "domotion-cleanup-gates", `${tree}.json`), "utf8"));
  assert.equal(receipt.generated.length, 4);
  for (const witness of receipt.generated) {
    assert.equal(witness.allowedLines.length, 2);
    assert.notEqual(witness.rawBeforeHash, witness.rawAfterHash);
    assert.match(witness.normalizedProgramHash, /^[0-9a-f]{64}$/);
  }
  const immutable = join(f.project, ".git", "domotion-cleanup-gates", "records", tree, `${receipt.record}.json`);
  assert.equal(f.adapter.inspect(f.options).evidence.ci, 42);
  writeFileSync(immutable, "{}\n");
  assert.throws(() => f.adapter.inspect(f.options), /exact_tree_record_invalid/);
  preserved(f);
});

const generatedRejections = [
  ["functional code", generatedFile(PROGRAM.replace("emoji = 1", "emoji = 3"))],
  ["third comment", generatedFile(PROGRAM + "// unrelated comment\n")],
  ["header", Buffer.from(generatedFile().toString().replace("Generated fixture", "Changed header"))],
  ["wrapper", Buffer.from(generatedFile().toString().replace(": string =", " ="))],
  [
    "only one allowed line",
    generatedFile(
      PROGRAM.replace("../../../old/packages/text-engine/dist/capture", "packages/text-engine/dist/capture"),
    ),
  ],
  ["duplicate known comment", generatedFile(PROGRAM + "// packages/text-engine/dist/font-family-stack.js\n")],
  ["unknown filename", generatedFile(PROGRAM.replace("font-family-stack.js", "unrelated.js"))],
  ["non-path comment text", generatedFile(PROGRAM.replace("../../../old/", "some arbitrary prose /"))],
  ["different JSON escape bytes", Buffer.from(generatedFile().toString().replace("emoji =", "\\u0065moji ="))],
  ["missing final wrapper newline", generatedFile().subarray(0, -1)],
  [
    "Unicode line separator in comment",
    generatedFile(PROGRAM.replace("../../../old/", "packages/text-engine/dist/\u2028evil//../../../old/")),
  ],
  [
    "Unicode paragraph separator in comment",
    generatedFile(PROGRAM.replace("../../../old/", "packages/text-engine/dist/\u2029evil//../../../old/")),
  ],
];
for (const [name, changed] of generatedRejections)
  test(`generated exception refuses ${name}`, () => {
    assert.throws(() => generatedWitness(generatedFile(), changed));
  });

test("preexisting generated dirt and the main checkout can never use the exception", (t) => {
  const f = fixture(t);
  assert.throws(
    () => f.adapter.gate({ project: f.project, shipping: f.shipping, validation: f.project }),
    /isolated_validation_required/,
  );
  const dirty = generatedFile(PROGRAM.replaceAll("../../../old/", ""));
  const artifact = join(f.validation, GENERATED);
  writeFileSync(artifact, dirty);
  assert.throws(() => gate(f), /source_not_clean/);
  assert.deepEqual(readFileSync(artifact), dirty);
});

test("a generated symlink produced during a gate is refused and retained", (t) => {
  const f = fixture(t);
  f.generatedMutation = (_name, path) => {
    unlinkSync(path);
    symlinkSync(join(f.project, GENERATED), path);
  };
  assert.throws(() => gate(f), /generated_regular_file_required/);
  assert.equal(readlinkSync(join(f.validation, GENERATED)), join(f.project, GENERATED));
});

test("a replaced generated inode is refused even with only the allowed comments", (t) => {
  const f = fixture(t);
  const changed = generatedFile(PROGRAM.replaceAll("../../../old/", ""));
  f.generatedMutation = (_name, path) => {
    writeFileSync(`${path}.new`, changed);
    renameSync(`${path}.new`, path);
  };
  assert.throws(() => gate(f), /generated_file_replaced/);
  assert.deepEqual(readFileSync(join(f.validation, GENERATED)), changed);
});

test("another tracked mutation refuses without restoring away the generated evidence", (t) => {
  const f = fixture(t);
  const changed = generatedFile(PROGRAM.replaceAll("../../../old/", ""));
  f.generatedMutation = (_name, path) => {
    writeFileSync(path, changed);
    writeFileSync(join(f.validation, "source.txt"), "retain this failure evidence");
  };
  assert.throws(() => gate(f), /source_not_clean/);
  assert.deepEqual(readFileSync(join(f.validation, GENERATED)), changed);
});

test("a final generated-file race is refused with its new bytes intact", (t) => {
  const f = fixture(t);
  const artifact = join(f.validation, GENERATED);
  const changed = generatedFile(PROGRAM.replaceAll("../../../old/", ""));
  f.generatedMutation = (_name, path) => writeFileSync(path, changed);
  let statuses = 0;
  f.onStatus = () => {
    if (++statuses === 6) writeFileSync(artifact, "retain racing bytes");
  };
  assert.throws(() => gate(f), /generated_restore_race/);
  assert.equal(readFileSync(artifact, "utf8"), "retain racing bytes");
});

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
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { budgetForCpuWork, describeChild, runBoundedChild, testTimeoutFor } from "./bounded-child.js";

const ROOT = resolve(import.meta.dirname, "..");

// Each script run is a few hundredths of a second of CPU (0.01-0.05 s in a
// loaded suite) spread over many short processes: bash, `mkdir`, the stubbed
// recorders and sweep, and on the macOS path `cat`, `mv` and up to three sweep
// attempts. Process starts, not CPU, dominate its wall time under load, so the
// budget counts them (docs/tool-child-process-test-bounds.md).
const SINGLE_ATTEMPT_BUDGET_MS = budgetForCpuWork(50, 8);
const THREE_ATTEMPT_BUDGET_MS = budgetForCpuWork(50, 20);
/** Vitest timeout for a test that runs the single-attempt script `runs` times. */
const singleAttemptTimeout = (runs: number) => testTimeoutFor(...Array<number>(runs).fill(SINGLE_ATTEMPT_BUDGET_MS));
const SCRIPT = join(ROOT, "scripts/ci-font-conformance-shard.sh");
let stubDir: string;

beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), "fc-shard-stub-"));
  // `npx` swallows the sweep; `node` swallows the two metadata recorders. Both
  // must exit 0 or the script's exit-code discipline fails the run before the
  // echoed command line can be read.
  for (const name of ["npx", "node"]) {
    const p = join(stubDir, name);
    writeFileSync(
      p,
      name === "npx"
        ? '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "--out" ]; then out="$2"; break; fi; shift; done\nmkdir -p "$out"\nprintf "{}\\n" > "$out/report.json"\nprintf "ok\\n" > "$out/summary.txt"\nexit 0\n'
        : "#!/bin/sh\nexit 0\n",
    );
    chmodSync(p, 0o755);
  }
});

/** Run the script and return the command line it says it will run. */
async function argsFor(env: Record<string, string>): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), "fc-shard-out-"));
  const result = await runBoundedChild("bash", [SCRIPT], {
    cwd: ROOT,
    budgetMs: SINGLE_ATTEMPT_BUDGET_MS,
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
      SHARD: "1",
      TOTAL: "6",
      OUT_DIR: outDir,
      RUNNER_OS: "Linux",
      ...env,
    },
  });
  expect(result.status, describeChild(result)).toBe(0);
  const out = result.stdout;
  const line = out.split("\n").find((l) => l.includes("npx tsx tools/font-conformance.ts"));
  expect(line, `the script must announce its command line:\n${out}`).toBeDefined();
  return line!.slice(line!.indexOf("npx tsx"));
}

describe("the conformance shard script passes exactly the flags it was asked for", () => {
  it(
    "always carries the stack shard and the output dir",
    async () => {
      expect(await argsFor({})).toContain("--stack-shard 1/6");
    },
    singleAttemptTimeout(1),
  );

  it(
    "caps the corpus when given a number",
    async () => {
      expect(await argsFor({ MAX_STACKS: "6" })).toContain("--max-stacks 6");
    },
    singleAttemptTimeout(1),
  );

  it.each(["all", "ALL", "0", ""])(
    "sweeps the WHOLE corpus for MAX_STACKS=%j",
    async (v) => {
      // The claim: no `--max-stacks` flag at all. Asserting the absence is the
      // point — a cap of "434" would also look like a full sweep today and would
      // silently truncate the moment the corpus grew.
      expect(await argsFor({ MAX_STACKS: v })).not.toContain("--max-stacks");
    },
    singleAttemptTimeout(1),
  );

  it(
    "omits the codepoint axis unless a second dimension was asked for",
    async () => {
      // A gratuitous `--shard 1/1` makes a 1-D run look 2-D to the merge, which
      // keys its codepoint accounting off that field.
      expect(await argsFor({ CP_TOTAL: "1", CP_SHARD: "1" })).not.toContain("--shard 1/1");
      expect(await argsFor({ CP_TOTAL: "4", CP_SHARD: "3" })).toContain("--shard 3/4");
    },
    singleAttemptTimeout(2),
  );

  it(
    "passes the boolean switches only when true",
    async () => {
      expect(await argsFor({ NO_PUA: "true" })).toContain("--no-pua");
      expect(await argsFor({ NO_PUA: "false" })).not.toContain("--no-pua");
      expect(await argsFor({ STRICT_ALIAS: "true" })).toContain("--strict-alias");
      expect(await argsFor({ STRICT_ALIAS: "false" })).not.toContain("--strict-alias");
    },
    singleAttemptTimeout(4),
  );

  it(
    "selects an alternate stack corpus when one is named",
    async () => {
      // How the synthetic sweep shares this script without a second copy of it.
      expect(await argsFor({ STACKS: "tools/font-conformance-stacks.synthetic.json" })).toContain(
        "--stacks tools/font-conformance-stacks.synthetic.json",
      );
      expect(await argsFor({})).not.toContain("--stacks");
    },
    singleAttemptTimeout(2),
  );

  it(
    "passes a rotating low-byte sample and treats all as exhaustive",
    async () => {
      expect(await argsFor({ SAMPLE_BYTE: "00" })).toContain("--sample-byte 00");
      expect(await argsFor({ SAMPLE_BYTE: "AF" })).toContain("--sample-byte AF");
      expect(await argsFor({ SAMPLE_BYTE: "all" })).not.toContain("--sample-byte");
    },
    singleAttemptTimeout(3),
  );
});

describe("the macOS shard restarts only diagnosed oracle drift", () => {
  async function runStub(mode: "once" | "always" | "nondrift", runnerOS = "macOS") {
    const dir = mkdtempSync(join(tmpdir(), "fc-shard-retry-"));
    const outDir = join(dir, "out");
    const npx = join(dir, "npx");
    const node = join(dir, "node");
    writeFileSync(node, "#!/bin/sh\nexit 0\n");
    writeFileSync(
      npx,
      '#!/bin/sh\nout=""\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "--out" ]; then out="$2"; break; fi; shift; done\ncount=0\n[ -f "$STATE_FILE" ] && count=$(cat "$STATE_FILE")\ncount=$((count + 1))\nprintf "%s\\n" "$count" > "$STATE_FILE"\nmkdir -p "$out"\nif [ "$STUB_MODE" = "nondrift" ] || [ "$STUB_MODE" = "always" ] || [ "$count" -eq 1 ]; then\n  [ "$STUB_MODE" = "nondrift" ] || printf "{}\\n" > "$out/oracle-drift.json"\n  exit 2\nfi\nprintf "{}\\n" > "$out/report.json"\nprintf "ok\\n" > "$out/summary.txt"\nexit 1\n',
    );
    chmodSync(npx, 0o755);
    chmodSync(node, 0o755);
    const result = await runBoundedChild("bash", [SCRIPT], {
      cwd: ROOT,
      budgetMs: THREE_ATTEMPT_BUDGET_MS,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        SHARD: "1",
        TOTAL: "1",
        OUT_DIR: outDir,
        RUNNER_OS: runnerOS,
        STATE_FILE: join(dir, "count"),
        STUB_MODE: mode,
      },
    });
    return { result, dir, outDir, count: Number(readFileSync(join(dir, "count"), "utf8")) };
  }

  it(
    "discards a partial process and accepts only the complete second attempt",
    async () => {
      const { result, outDir, count } = await runStub("once");
      expect(result.status, describeChild(result)).toBe(0);
      expect(count).toBe(2);
      expect(existsSync(join(outDir, "attempt-1/oracle-drift.json"))).toBe(true);
      expect(existsSync(join(outDir, "attempt-1/report.json"))).toBe(false);
      expect(existsSync(join(outDir, "report.json"))).toBe(true);
      expect(JSON.parse(readFileSync(join(outDir, "oracle-attempts.json"), "utf8"))).toEqual({
        attempts: 2,
        maxAttempts: 3,
        accepted: true,
      });
    },
    testTimeoutFor(THREE_ATTEMPT_BUDGET_MS),
  );

  it(
    "does not restart an unrelated tool failure",
    async () => {
      const { result, outDir, count } = await runStub("nondrift");
      expect(result.status, describeChild(result)).toBe(2);
      expect(count).toBe(1);
      expect(existsSync(join(outDir, "report.json"))).toBe(false);
    },
    testTimeoutFor(THREE_ATTEMPT_BUDGET_MS),
  );

  it(
    "stops after three drifted attempts without publishing a report",
    async () => {
      const { result, outDir, count } = await runStub("always");
      expect(result.status, describeChild(result)).toBe(2);
      expect(count).toBe(3);
      expect(existsSync(join(outDir, "attempt-3/oracle-drift.json"))).toBe(true);
      expect(existsSync(join(outDir, "report.json"))).toBe(false);
      expect(JSON.parse(readFileSync(join(outDir, "oracle-attempts.json"), "utf8")).accepted).toBe(false);
    },
    testTimeoutFor(THREE_ATTEMPT_BUDGET_MS),
  );

  it.each(["Linux", "Windows"])(
    "keeps %s on the single-attempt path",
    async (runnerOS) => {
      const { result, outDir, count } = await runStub("once", runnerOS);
      expect(result.status, describeChild(result)).toBe(2);
      expect(count).toBe(1);
      expect(existsSync(join(outDir, "oracle-attempts.json"))).toBe(false);
    },
    testTimeoutFor(THREE_ATTEMPT_BUDGET_MS),
  );
});

// DM-C15ZXR: the shard records the macOS MobileAsset fonts before the sweep and
// again on exit, so its artifact shows whether the sweep itself made CoreText
// download one. The after-record must be written on the failure path too.
describe("the shard records MobileAsset fonts before and after the sweep", () => {
  async function run(npxExit: number) {
    const dir = mkdtempSync(join(tmpdir(), "fc-shard-assets-"));
    const log = join(dir, "calls.log");
    writeFileSync(join(dir, "node"), `#!/bin/sh\necho "node $*" >> "${log}"\nexit 0\n`);
    writeFileSync(
      join(dir, "npx"),
      `#!/bin/sh\necho "npx" >> "${log}"\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "--out" ]; then out="$2"; break; fi; shift; done\nmkdir -p "$out"\n[ ${npxExit} -le 1 ] && printf "{}\\n" > "$out/report.json" && printf "ok\\n" > "$out/summary.txt"\nexit ${npxExit}\n`,
    );
    chmodSync(join(dir, "node"), 0o755);
    chmodSync(join(dir, "npx"), 0o755);
    const outDir = join(dir, "out");
    const result = await runBoundedChild("bash", [SCRIPT], {
      cwd: ROOT,
      budgetMs: SINGLE_ATTEMPT_BUDGET_MS,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        SHARD: "1",
        TOTAL: "1",
        OUT_DIR: outDir,
        RUNNER_OS: "Linux",
      },
    });
    return { result, calls: readFileSync(log, "utf8").trim().split("\n"), outDir };
  }

  it(
    "records before the sweep and after it, in that order",
    async () => {
      const { result, calls, outDir } = await run(1);
      expect(result.status, describeChild(result)).toBe(0);
      const before = calls.indexOf(`node tools/font-inventory.mjs --assets ${outDir}/font-assets.json`);
      const sweep = calls.indexOf("npx");
      const after = calls.indexOf(`node tools/font-inventory.mjs --assets ${outDir}/font-assets-after.json`);
      expect(before).toBeGreaterThanOrEqual(0);
      expect(sweep).toBeGreaterThan(before);
      expect(after).toBeGreaterThan(sweep);
    },
    singleAttemptTimeout(1),
  );

  it(
    "still records after a dead shard, and keeps its exit code",
    async () => {
      const { result, calls, outDir } = await run(3);
      expect(result.status, describeChild(result)).toBe(3);
      expect(calls).toContain(`node tools/font-inventory.mjs --assets ${outDir}/font-assets-after.json`);
    },
    singleAttemptTimeout(1),
  );
});

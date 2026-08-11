import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_SYNTHETIC_STACKS_FILE } from "../tools/font-conformance-synthetic-stacks.js";

// The synthetic sweep shares its instrument, its shard script and its gate with
// the harvested sweep next door, and differs in exactly one input: the stack
// corpus. That is a cheap thing to get wrong quietly, and every way of getting
// it wrong produces a plausible number rather than an error:
//
//   - forget the generation step  -> the tool exits 2 ("no stack corpus"), which
//                                    the shard script correctly treats as a dead
//                                    shard, so this one at least is loud;
//   - forget to pass STACKS       -> the job sweeps the HARVESTED corpus and
//                                    gates it against the SYNTHETIC baseline;
//   - point at the wrong baseline -> a 351-stack synthetic slice is compared to
//                                    a 6-stack harvested one.
//
// Like the guard next door, this reads the workflow rather than the code,
// because the failure mode is workflow drift.

const WORKFLOW = resolve(__dirname, "..", ".github", "workflows", "font-conformance-synthetic.yml");
const PLATFORMS = ["macos", "linux", "windows"] as const;

describe("font-conformance-synthetic.yml sweeps the rule-derived corpus honestly", () => {
  const yaml = readFileSync(WORKFLOW, "utf-8");

  /** Split into job blocks by the 2-space-indented job keys. */
  const jobs = (() => {
    const out: Record<string, string> = {};
    let cur: string | null = null;
    let buf: string[] = [];
    for (const line of yaml.split("\n")) {
      const m = /^ {2}([a-zA-Z0-9_-]+):\s*$/.exec(line);
      if (m != null) {
        if (cur != null) out[cur] = buf.join("\n");
        cur = m[1];
        buf = [];
      } else if (cur != null) {
        buf.push(line);
      }
    }
    if (cur != null) out[cur] = buf.join("\n");
    return out;
  })();

  it("parses the workflow into jobs (guard is not vacuous)", () => {
    expect(Object.keys(jobs)).toEqual(
      expect.arrayContaining(["setup", "sweep-macos", "sweep-linux", "sweep-windows", "aggregate"]),
    );
  });

  it("puts no `${{ … }}` expression inside a YAML flow mapping", () => {
    // Same trap as the sibling workflow: the braces close the flow mapping
    // early, and GitHub's response to an unparseable workflow is to report that
    // it "does not have a 'workflow_dispatch' trigger".
    const bad = yaml
      .split("\n")
      .filter((l) => /^\s*\w[\w-]*:\s*\{/.test(l))
      .filter((l) => /\$\{\{/.test(l.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')));
    expect(bad, `quote the expression or use a block mapping:\n${bad.join("\n")}`).toEqual([]);
  });

  it("generates the corpus before sweeping — it is gitignored, so a checkout has none", () => {
    for (const os of PLATFORMS) {
      const job = jobs[`sweep-${os}`];
      const gen = job.indexOf("font-conformance-synthetic-stacks.ts");
      const run = job.indexOf("ci-font-conformance-shard.sh");
      expect(gen, `sweep-${os} must generate the synthetic corpus`).toBeGreaterThanOrEqual(0);
      expect(run).toBeGreaterThanOrEqual(0);
      expect(gen, "the corpus must exist before the sweep loads it").toBeLessThan(run);
    }
  });

  it("passes the synthetic corpus as STACKS on every platform", () => {
    // Without this the job sweeps the platform's HARVESTED corpus and gates it
    // against the synthetic baseline — two different questions, one verdict.
    expect(yaml).toContain(DEFAULT_SYNTHETIC_STACKS_FILE);
    for (const os of PLATFORMS) {
      expect(jobs[`sweep-${os}`], `sweep-${os}`).toMatch(/STACKS: \$\{\{ env\.STACKS_FILE \}\}/);
    }
  });

  it("builds each platform's native helper before sweeping", () => {
    // Same reasoning as the harvested workflow: without the helper the resolver
    // silently drops to the static chain and answers a different question.
    for (const [os, helper] of [
      ["macos", "macos-glyph-extractor"],
      ["linux", "linux-glyph-extractor"],
      ["windows", "win32-glyph-extractor"],
    ] as const) {
      const job = jobs[`sweep-${os}`];
      const build = job.indexOf(helper);
      const run = job.indexOf("ci-font-conformance-shard.sh");
      expect(build, `sweep-${os} must build tools/${helper}`).toBeGreaterThanOrEqual(0);
      expect(build).toBeLessThan(run);
    }
  });

  it("Linux sweeps inside the pinned Playwright container", () => {
    expect(jobs["sweep-linux"]).toMatch(/container:\s*\n\s*image:\s*mcr\.microsoft\.com\/playwright:/);
  });

  it("uses the SHARED shard script rather than inline flags", () => {
    for (const os of PLATFORMS) {
      expect(jobs[`sweep-${os}`], `sweep-${os}`).toMatch(/bash scripts\/ci-font-conformance-shard\.sh/);
    }
  });

  it("namespaces its artifacts away from the harvested sweep's", () => {
    // A shared artifact name would let the harvested aggregate download a
    // synthetic shard — the single worst thing either workflow could do quietly.
    for (const os of PLATFORMS) {
      expect(jobs[`sweep-${os}`]).toContain(`font-conformance-synthetic-${os}-shard-`);
    }
    expect(jobs["aggregate"]).toContain("font-conformance-synthetic-${{ matrix.os }}-shard-*");
  });

  it("gates against the SYNTHETIC baseline, never the harvested one", () => {
    const job = jobs["aggregate"];
    expect(job).toMatch(/tests\/baselines\/font-conformance-synthetic-\$\{\{ matrix\.os \}\}\.json/);
    expect(job).toContain('font-conformance-synthetic-${{ matrix.os }}-byte-${sample}.json');
    // …and not the harvested path, which differs by one word.
    expect(job).not.toMatch(/baselines\/font-conformance-\$\{\{ matrix\.os \}\}\.json/);
  });

  it("tells the aggregate how many shards to expect", () => {
    // A run whose shards died would otherwise merge the survivors into a smaller
    // mismatch total, which reads as an improvement.
    expect(jobs["aggregate"]).toMatch(/--expected \$\{\{ matrix\.expected \}\}/);
  });

  it("uses bounded platform-specific fan-out by default", () => {
    // Six shards put 59 stacks on each runner. The authoritative rule-v2 run
    // reached only 49 on Windows before GitHub's six-hour job ceiling killed it,
    // and the last queued macOS shard hit the same ceiling. Keep both comfortably
    // below that bound while avoiding unnecessary Linux runner fan-out. The
    // DirectWrite health sample gets more shards because it remains far slower.
    expect(yaml).toMatch(/shards:[\s\S]{0,300}?default: 'auto'/);
    expect(jobs["setup"]).toMatch(/sample[\s\S]*?all[\s\S]*?macos_n=8[\s\S]*?linux_n=6[\s\S]*?windows_n=16/);
    expect(jobs["setup"]).toMatch(/macos_n=1[\s\S]*?linux_n=1[\s\S]*?windows_n=3/);
    expect(jobs["sweep-macos"]).toContain("needs.setup.outputs.macos_matrix");
    expect(jobs["sweep-linux"]).toContain("needs.setup.outputs.linux_matrix");
    expect(jobs["sweep-windows"]).toContain("needs.setup.outputs.windows_matrix");
    expect(jobs["setup"]).toContain("shards must be 'auto' or a positive integer");
  });

  it("defaults to low-byte 00 across Unicode, with no extra codepoint stride", () => {
    // The shard script omits `--shard` entirely when CP_TOTAL is 1, which the
    // merge relies on to key its codepoint accounting off `meta.shard` being null.
    expect(yaml).toMatch(/cp_total:[\s\S]{0,400}?default: '1'/);
    expect(yaml).toMatch(/sample_byte:[\s\S]{0,400}?default: '00'/);
    for (const os of PLATFORMS) {
      expect(jobs[`sweep-${os}`]).toMatch(/SAMPLE_BYTE: \$\{\{ inputs\.sample_byte \}\}/);
    }
  });

  it("defaults to the complete single-axis slice, including spelling and language", () => {
    expect(yaml).toMatch(/max_stacks:[\s\S]{0,400}?default: '351'/);
  });
});

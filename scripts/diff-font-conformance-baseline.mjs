#!/usr/bin/env node
// Gate a font-conformance sweep against its OWN platform's committed baseline.
//
//   node scripts/diff-font-conformance-baseline.mjs \
//     --results merged.json --baseline tests/baselines/font-conformance-linux.json \
//     --strict --label "linux / font-conformance"
//   …plus --update-baseline to write the current run back as the new baseline.
//
// WHY BASELINE-RELATIVE, NOT ABSOLUTE ZERO
//   Absolute agreement is the goal and it is not the gate. macOS is the only
//   platform whose per-codepoint routing has been driven toward Chrome's answer
//   for years, and even it does not measure zero. Linux and Windows have never
//   been measured at all. A gate demanding zero on those two fails on day one,
//   every day, and therefore says nothing about the change in front of it — the
//   same reasoning the per-platform visual-fidelity gates already run on.
//   So: a regression against the platform's own last measurement fails; the
//   absolute number is reported and tracked, not enforced.
//
// WHY A RUN CAN BE REFUSED RATHER THAN JUDGED
//   The oracle's answers are a function of (a) the codepoint universe the host's
//   ICU defines, (b) the fonts installed on the runner, (c) which stacks were
//   swept. Change any of those and the two numbers are not measuring the same
//   thing. Comparing them anyway produces a confident regression or a confident
//   all-clear, both meaningless. When they differ this exits non-zero under
//   --strict with the reason, instead of quietly comparing.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const get = (flag, dflt = null) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : dflt;
};
const strict = args.includes("--strict");
const update = args.includes("--update-baseline");
const resultsPath = get("--results");
const baselinePath = get("--baseline");
const label = get("--label", "font-conformance");
const commit = get("--commit", process.env.GITHUB_SHA ?? "");

/**
 * Is this run comparable with that baseline?
 *
 * Returns a list of human-readable reasons it is not; empty means it is.
 * Pure, so the rules are unit-testable without a runner.
 */
export function comparability(runMeta, baseMeta) {
  const reasons = [];

  // A run whose own shards disagreed is not one measurement, so there is
  // nothing for the field-by-field check below to compare — `meta` describes
  // whichever shard was read first. This must be checked BEFORE those fields,
  // because they would all match: a blended run presents one shard's
  // environment and would otherwise sail through the guard.
  //
  // "Cannot tell" (a field absent, e.g. an older baseline) and "known blended"
  // are different verdicts, and only the first is safe to skip.
  for (const side of [["run", runMeta], ["baseline", baseMeta]]) {
    for (const c of side[1]?.envConflicts ?? []) {
      const parts = (c.values ?? []).map((v) => `${v.value} (${(v.shards ?? []).join(", ")})`);
      reasons.push(`${side[0]}'s shards disagree on ${c.field}: ${parts.join(" vs ")}`);
    }
  }

  const cmp = (what, a, b) => {
    if (a != null && b != null && String(a) !== String(b)) reasons.push(`${what}: run ${a}, baseline ${b}`);
  };
  cmp("runner image", runMeta?.image, baseMeta?.image);
  cmp("Unicode version", runMeta?.unicode, baseMeta?.unicode);
  cmp("stack corpus generatedAt", runMeta?.corpus?.generatedAt, baseMeta?.corpus?.generatedAt);
  cmp("font inventory digest", runMeta?.fontInventory?.digest, baseMeta?.fontInventory?.digest);
  for (const k of ["codepoints", "stacks", "includePua", "strictAlias", "lang"]) {
    cmp(`slice.${k}`, runMeta?.slice?.[k], baseMeta?.slice?.[k]);
  }
  return reasons;
}

/** Per-stack movement between two `byStack` maps. */
export function stackDelta(now, base) {
  const worse = [];
  const better = [];
  const added = [];
  const removed = [];
  for (const [stack, count] of Object.entries(now)) {
    const b = base[stack];
    if (b == null) { if (count > 0) added.push({ stack, count }); continue; }
    if (count > b) worse.push({ stack, now: count, base: b });
    else if (count < b) better.push({ stack, now: count, base: b });
  }
  for (const [stack, count] of Object.entries(base)) {
    if (now[stack] == null && count > 0) removed.push({ stack, count });
  }
  const by = (a, b) => (b.now ?? b.count) - (a.now ?? a.count);
  return { worse: worse.sort(by), better: better.sort(by), added: added.sort(by), removed: removed.sort(by) };
}

function emit(lines) {
  const text = `${lines.join("\n")}\n`;
  process.stdout.write(text);
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) { try { writeFileSync(f, text, { flag: "a" }); } catch { /* not on a runner */ } }
}

function baselineFrom(run) {
  return {
    meta: { ...run.meta, commit: commit || run.meta?.commit || null },
    summary: run.summary,
    byStack: run.byStack,
    byPair: run.byPair,
    // The face list is the recorded font inventory the answers depend on; the
    // per-face counts are not, and would churn the diff on every run.
    chromeFaces: Object.keys(run.chromeFaces ?? {}).sort(),
  };
}

function main() {
  if (resultsPath == null) { process.stderr.write("--results is required\n"); process.exit(2); }
  const run = JSON.parse(readFileSync(resultsPath, "utf8"));
  const md = [`## ${label}`, ""];

  const total = run.summary?.mismatchTotal ?? 0;
  const comparisons = run.summary?.comparisons ?? 0;
  const routes = run.summary?.distinctMismatchPairs ?? 0;
  const pctOf = comparisons > 0 ? ((total / comparisons) * 100).toFixed(3) : "0.000";
  md.push(
    `| metric | value |`, `| --- | --- |`,
    `| comparisons | ${comparisons.toLocaleString()} |`,
    `| mismatches | **${total.toLocaleString()}** (${pctOf}%) |`,
    `| distinct disagreeing routes | ${routes.toLocaleString()} |`,
    `| runner image | \`${run.meta?.image ?? "?"}\` |`,
    `| font inventory | \`${run.meta?.fontInventory?.digest ?? "?"}\` (${run.meta?.fontInventory?.count ?? "?"} entries) |`,
    `| Unicode / ICU | ${run.meta?.unicode ?? "?"} / ${run.meta?.icu ?? "?"} |`,
    `| corpus | \`${run.meta?.corpus?.file ?? "?"}\` |`,
    "",
  );

  // An incomplete merge is not a score. Say so before anything is compared.
  if (run.meta?.complete === false) {
    md.push(
      `> **INCOMPLETE — verdict withheld.** merged ${run.meta.shardsMerged}/${run.meta.shardsExpected} shard reports`
      + `${run.meta.missingShards?.length ? ` (missing: ${run.meta.missingShards.join(", ")})` : ""}.`
      + ` The totals above cover part of the sweep only.`,
      "",
    );
    emit(md);
    process.exit(strict ? 1 : 0);
  }

  if (update) {
    if (baselinePath == null) { process.stderr.write("--update-baseline needs --baseline\n"); process.exit(2); }
    // Refuse to enshrine a run whose own shards disagreed. Everything after this
    // point is graded against the baseline, so a blend poisons every later
    // comparison — and it does so invisibly, because the merged `meta` presents
    // one shard's environment and looks perfectly ordinary.
    const blend = run.meta?.envConflicts ?? [];
    if (blend.length > 0) {
      md.push(
        `> **REFUSING to write a baseline from this run.** Its shards did not all execute in the same environment:`,
        "",
        ...blend.map((c) => {
          const parts = (c.values ?? []).map((v) => `\`${v.value}\` (${(v.shards ?? []).join(", ")})`);
          return `> - **${c.field}**: ${parts.join(" vs ")}`;
        }),
        "",
        `> The merged totals sum measurements taken on different machines, so they are not a baseline.`,
        `> Re-dispatch — a runner-image rollout window is hours, not days.`,
        "",
      );
      emit(md);
      process.exit(1); // always fatal: this is a request to record something known-wrong
    }
    writeFileSync(baselinePath, `${JSON.stringify(baselineFrom(run), null, 2)}\n`);
    md.push(`Baseline written to \`${baselinePath}\`.`, "");
    emit(md);
    return;
  }

  if (baselinePath == null || !existsSync(baselinePath)) {
    md.push(
      `> No committed baseline at \`${baselinePath ?? "(none given)"}\` — recording only, nothing to compare.`,
      `> Seed one with \`--update-baseline\`.`,
      "",
    );
    emit(md);
    return;
  }

  const base = JSON.parse(readFileSync(baselinePath, "utf8"));
  const reasons = comparability(run.meta, base.meta);
  if (reasons.length > 0) {
    md.push(
      `> **NOT COMPARABLE — verdict withheld.** This run and the baseline do not measure the same thing:`,
      "",
      ...reasons.map((r) => `> - ${r}`),
      "",
      `> The oracle's answers depend on the host's font set, its ICU codepoint universe and the slice swept.`,
      `> Re-seed the baseline (\`--update-baseline\`) once the change is understood; do not read the numbers above as a comparison.`,
      "",
    );
    emit(md);
    process.exit(strict ? 1 : 0);
  }

  const baseTotal = base.summary?.mismatchTotal ?? 0;
  const baseRoutes = base.summary?.distinctMismatchPairs ?? 0;
  const d = stackDelta(run.byStack ?? {}, base.byStack ?? {});
  const newPairs = Object.keys(run.byPair ?? {}).filter((p) => base.byPair?.[p] == null);
  const goneP = Object.keys(base.byPair ?? {}).filter((p) => run.byPair?.[p] == null);

  md.push(
    `**${total.toLocaleString()} mismatches now vs ${baseTotal.toLocaleString()} in baseline `
    + `(${total - baseTotal >= 0 ? "+" : ""}${(total - baseTotal).toLocaleString()}); `
    + `${routes} routes vs ${baseRoutes}.** `
    + `${d.worse.length} stack(s) worse, ${d.better.length} better, ${d.added.length} newly disagreeing, `
    + `${newPairs.length} new route(s).`,
    "",
  );

  const table = (title, rows, cols) => {
    if (rows.length === 0) return;
    md.push(`### ${title} (${rows.length})`, "", `| ${cols.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`);
    for (const r of rows.slice(0, 40)) {
      md.push(cols.length === 3
        ? `| \`${r.stack}\` | ${r.now} | ${r.base} |`
        : `| \`${r.stack}\` | ${r.count} |`);
    }
    md.push("");
  };
  table("🔴 Stacks that got worse", d.worse, ["stack", "now", "baseline"]);
  table("🆕 Stacks newly disagreeing", d.added, ["stack", "mismatches"]);
  table("🟢 Stacks that improved", d.better, ["stack", "now", "baseline"]);
  if (d.removed.length) table("Stacks that stopped disagreeing", d.removed, ["stack", "baseline"]);

  if (newPairs.length) {
    md.push(`### 🔴 New disagreeing routes (${newPairs.length})`, "", "| count | route (chrome → ours) |", "|---|---|");
    for (const p of newPairs.sort((a, b) => run.byPair[b] - run.byPair[a]).slice(0, 40)) {
      md.push(`| ${run.byPair[p]} | \`${p}\` |`);
    }
    md.push("");
  }
  if (goneP.length) md.push(`_${goneP.length} route(s) in the baseline no longer disagree._`, "");

  const regressed = d.worse.length > 0 || d.added.length > 0 || newPairs.length > 0;
  md.push(regressed
    ? "🔴 **Regression vs this platform's baseline.**"
    : "✅ **No regression vs this platform's baseline.** (The absolute count is tracked, not enforced.)", "");

  emit(md);
  if (strict && regressed) process.exit(1);
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) main();

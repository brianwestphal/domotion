/**
 * Conformance oracle for the DECLARED-FAMILY style matcher on Linux.
 *
 * Sibling of `tools/family-match-conformance.ts` (doc 109, macOS). Blink runs
 * DIFFERENT code for this step on each platform, so the macOS number says
 * nothing about Linux: here `FontCache::CreateTypeface` reduces to
 * `skia::DefaultFontMgr()->matchFamilyStyle(name, SkiaFontStyle())`
 * (`fonts/skia/font_cache_skia.cc`, Chromium tag 147.0.7727.15 — the build
 * Playwright pins), the Linux manager is fontconfig-backed (`SkFontMgr_New_FCI`,
 * `skia/ext/font_utils.cc:86-89`), and the whole decision is
 * `SkFontConfigInterfaceDirect::matchFamilyName`
 * (Skia rev fd139e79, `src/ports/SkFontConfigInterface_direct.cpp:592-713`).
 *
 * This sweeps every installed fontconfig family — plus the declared names the
 * fixture corpus actually uses (`tools/font-conformance-stacks.linux.json`),
 * which is how the metric-alias path (Arial → Liberation Sans) gets measured —
 * crossed with the CSS weight ladder INCLUDING intermediate rungs. The macOS
 * oracle's canonical-only sweep could not see the 301-399 / 501-599 bands where
 * its port diverged; the intermediate rungs exist so that blindness is not
 * inherited here.
 *
 * Our side is the Linux glyph helper's `familyMatch` query — the shipped
 * transcription itself, not a restatement of it. Chrome's side is CDP
 * `CSS.getPlatformFontsForNode`, read by `postScriptName` (family names cannot
 * distinguish cuts) and selected by maximum `glyphCount` (the array is not
 * coverage-ordered).
 *
 * Scoring:
 *  - When our matcher ACCEPTS a face, the row agrees iff Chrome paints the
 *    same PostScript name.
 *  - When our matcher REJECTS the family (found:false — how Blink walks to the
 *    next CSS family), the row agrees iff Chrome's pick is OUTSIDE the
 *    requested family too (it went to its last-resort chain).
 *  - Rows where our matcher accepted but Chrome's pick is outside BOTH the
 *    requested family and the matched family are skipped as coverage
 *    artifacts of the Latin probe text, mirroring the macOS oracle's rule.
 *
 * Baseline: `tests/baselines/family-match-linux.json` — an ENV-KEYED SET
 * (tools/family-match-baseline.ts): one recorded baseline per environment
 * fingerprint (platform/arch/image/fontconfig version/font-inventory digest),
 * so the arm64 Docker-on-Apple-Silicon image and CI's x64 container each
 * carry their own. The comparator judges against the entry matching THIS
 * run's fingerprint and REFUSES to judge (exit 3) when none matches — a
 * difference measured across two environments is not evidence about the
 * code. `--write-baseline` records/replaces only this environment's entry.
 *
 * Usage (Linux only — run inside the pinned Playwright noble image locally):
 *   npm run fonts:family-match:linux                     # compare vs baseline
 *   npm run fonts:family-match:linux -- --json           # machine-readable
 *   npm run fonts:family-match:linux -- --write-baseline # record this env's baseline
 *
 * Exit codes: 0 ok / 1 regression vs baseline / 2 cannot run / 3 environment
 * mismatch (refused to judge).
 */
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  FAMILY_MATCH_ENV_KEYS, readBaselineSet, selectBaseline, describeRecordedEnvs, writeBaselineSet,
} from "./family-match-baseline.js";

const WEIGHTS = [100, 200, 300, 350, 400, 450, 500, 550, 600, 700, 800, 900] as const;
const BASELINE = resolve("tests", "baselines", "family-match-linux.json");
/** Fingerprint fields across which comparison is invalid (env-keyed baselines). */
const ENV_KEYS = FAMILY_MATCH_ENV_KEYS.linux;
const HELPER = process.env.DOMOTION_HELPER_PATH
  ?? resolve("tools", "linux-glyph-extractor", "domotion-glyph-paths");

interface OurAnswer { found: boolean; postscriptName?: string; family?: string; path?: string }
interface Case { family: string; css: number; ours: OurAnswer }
interface Miss { family: string; css: number; chrome: string; ours: string }

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

/** family → set of PostScript names of its installed faces. */
function installedFamilies(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const lines = sh("fc-list", ["--format", "%{family[0]}\t%{postscriptname}\n", ":"]).split("\n");
  for (const line of lines) {
    const [family, ps] = line.split("\t");
    if (family == null || family === "") continue;
    if (!out.has(family)) out.set(family, new Set());
    if (ps != null && ps !== "") out.get(family)!.add(ps);
  }
  return out;
}

/** Environment fingerprint — the fields across which comparison is invalid. */
function runEnv(chromium_: string): Record<string, string | number> {
  let image = "unknown";
  try {
    image = readFileSync("/etc/os-release", "utf8").match(/PRETTY_NAME="([^"]+)"/)?.[1] ?? "unknown";
  } catch { /* not linux or unreadable */ }
  // fontconfig prints its version banner on STDERR, so fold the streams.
  const fcVersion = (() => {
    try {
      return execFileSync("sh", ["-c", "fc-list --version 2>&1"], { encoding: "utf8" }).trim();
    } catch { return "unknown"; }
  })();
  const inventory = sh("fc-list", ["--format", "%{family[0]}|%{postscriptname}|%{file}|%{index}\n", ":"])
    .split("\n").sort().join("\n");
  return {
    platform: process.platform,
    arch: process.arch,
    // The browser that produced Chrome's side of every comparison. See
    // FAMILY_MATCH_ENV_KEYS for why it is part of the fingerprint.
    chromium: chromium_,
    image,
    fcVersion,
    fontCount: inventory === "" ? 0 : inventory.split("\n").length,
    fontDigest: createHash("sha256").update(inventory).digest("hex").slice(0, 16),
  };
}

/** Family names the fixture corpus declares (derived, not authored). */
function corpusFamilies(): string[] {
  const file = resolve("tools", "font-conformance-stacks.linux.json");
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { stacks?: Array<{ fontFamily?: string }> };
    const names = new Set<string>();
    for (const s of parsed.stacks ?? []) {
      for (const raw of (s.fontFamily ?? "").split(",")) {
        const name = raw.trim().replace(/^["']|["']$/g, "");
        // Generic keywords resolve through Blink's settings layer, not through
        // matchFamilyName with the keyword itself — skip them. `-apple-system`
        // is a macOS-ism the corpus carries verbatim.
        if (name === "" || ["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "-apple-system", "ui-monospace", "ui-sans-serif", "ui-serif", "ui-rounded", "math", "emoji"].includes(name.toLowerCase())) continue;
        names.add(name);
      }
    }
    return [...names];
  } catch { return []; }
}

function ourAnswers(families: string[]): Map<string, Map<number, OurAnswer>> {
  const queries = families.flatMap((family) =>
    WEIGHTS.map((w) => ({ type: "familyMatch", family, cssWeight: w })));
  const out = execFileSync(HELPER, {
    input: JSON.stringify({ fonts: [], queries }),
    encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
  });
  const results = (JSON.parse(out) as { results: Array<OurAnswer & { type?: string; error?: string }> }).results;
  if (results.some((r) => r?.error === "unknown query type")) {
    console.error("helper binary predates the familyMatch query — rebuild tools/linux-glyph-extractor.");
    process.exit(2);
  }
  const map = new Map<string, Map<number, OurAnswer>>();
  families.forEach((family, fi) => {
    const inner = new Map<number, OurAnswer>();
    WEIGHTS.forEach((w, wi) => { inner.set(w, results[fi * WEIGHTS.length + wi] ?? { found: false }); });
    map.set(family, inner);
  });
  return map;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const writeBaseline = argv.includes("--write-baseline");

  if (process.platform !== "linux") {
    console.error("family-match conformance (linux) must run on Linux — e.g. inside the pinned Playwright noble image.");
    process.exit(2);
  }
  if (!existsSync(HELPER)) {
    console.error(`Linux glyph helper not built — run tools/linux-glyph-extractor/build.sh (looked for ${HELPER}).`);
    process.exit(2);
  }

  const members = installedFamilies();
  // Installed families, dropping those that cannot discriminate (fewer than
  // two faces means every rule answers identically), plus the corpus's
  // declared names — which include the alias names that exercise the
  // metric-equivalence path even though they are not installed.
  const families = [...new Set([
    ...[...members.entries()].filter(([, ps]) => ps.size >= 2).map(([f]) => f),
    ...corpusFamilies(),
  ])].sort();

  const ours = ourAnswers(families);
  const cases: Case[] = families.flatMap((family) =>
    WEIGHTS.map((css) => ({ family, css, ours: ours.get(family)!.get(css)! })));

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const session = await page.context().newCDPSession(page);
  await session.send("DOM.enable");
  await session.send("CSS.enable");
  await page.setContent(
    `<body style="margin:0">${cases
      .map((d, i) => `<div id="p${i}" style="font-family:'${d.family.replace(/'/g, "\\'")}';font-weight:${d.css};font-size:32px">Regate</div>`)
      .join("")}</body>`,
  );
  await page.waitForLoadState("networkidle");
  const { root } = await session.send("DOM.getDocument", { depth: -1 });

  let scored = 0, agree = 0, skipped = 0, rejectAgree = 0;
  const misses: Miss[] = [];
  for (const [i, d] of cases.entries()) {
    const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#p${i}` });
    const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
    const chrome = fonts.slice().sort((a, b) => b.glyphCount - a.glyphCount)[0]?.postScriptName;
    if (chrome == null || chrome === "") { skipped++; continue; }
    const requestedMembers = members.get(d.family) ?? new Set<string>();
    if (!d.ours.found) {
      // Our matcher rejected the family. Chrome agreeing means its paint left
      // the requested family too (last-resort chain / next CSS family).
      scored++;
      if (!requestedMembers.has(chrome)) { agree++; rejectAgree++; }
      else misses.push({ family: d.family, css: d.css, chrome, ours: "(rejected)" });
      continue;
    }
    const matchedMembers = d.ours.family != null ? (members.get(d.ours.family) ?? new Set<string>()) : new Set<string>();
    // Coverage artifact: Chrome left both the requested and the matched
    // family for the Latin probe text — not a style-matcher decision.
    if (!requestedMembers.has(chrome) && !matchedMembers.has(chrome)) { skipped++; continue; }
    scored++;
    if (chrome === d.ours.postscriptName) agree++;
    else misses.push({ family: d.family, css: d.css, chrome, ours: d.ours.postscriptName ?? "(none)" });
  }
  const chromiumVersion = browser.version();
  await browser.close();

  const env = runEnv(chromiumVersion);
  const report = {
    meta: { suite: "family-match", os: "linux", capturedAt: new Date().toISOString(), env, weights: WEIGHTS },
    summary: { families: families.length, cases: cases.length, scored, agree, rejectAgree, skipped, misses: misses.length },
    misses,
  };

  mkdirSync(resolve("tests", "output"), { recursive: true });
  writeFileSync(resolve("tests", "output", "family-match-conformance-linux.json"), JSON.stringify(report, null, 2));

  if (asJson) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`families ${families.length}  cases ${cases.length}  scored ${scored}  skipped ${skipped}`);
    console.log(`agreement ${agree}/${scored} (${scored > 0 ? ((agree / scored) * 100).toFixed(2) : "—"}%)  (agreed rejections: ${rejectAgree})`);
    for (const m of misses) console.log(`  ${m.family}@${m.css}: chrome=${m.chrome} ours=${m.ours}`);
  }

  if (writeBaseline) {
    const { replaced, total } = writeBaselineSet(BASELINE, report, ENV_KEYS);
    console.log(`baseline ${replaced ? "replaced" : "recorded"} for this environment: ${BASELINE} (${total} environment(s) in the set)`);
    return;
  }

  const entries = readBaselineSet(BASELINE);
  if (entries.length === 0) {
    console.log("no committed baseline yet (tests/baselines/family-match-linux.json) — advisory run only.");
    return;
  }
  const baseline = selectBaseline(entries, env, ENV_KEYS);
  if (baseline == null) {
    console.error("REFUSING TO JUDGE: no recorded baseline matches this environment.");
    console.error(`this run: ${ENV_KEYS.map((k) => `${k}=${String(env[k])}`).join(" ")}`);
    for (const line of describeRecordedEnvs(entries, ENV_KEYS)) console.error(`recorded:  ${line}`);
    console.error("A difference measured across two environments is not evidence about the code. Record a baseline on this environment (--write-baseline) to arm the gate here; existing environments' baselines are preserved.");
    process.exit(3);
  }
  const baselineMissKeys = new Set(baseline.misses.map((m) => `${m.family}@${m.css}`));
  const regressions = misses.filter((m) => !baselineMissKeys.has(`${m.family}@${m.css}`));
  if (regressions.length > 0) {
    console.error(`\n${regressions.length} regression(s) vs baseline:`);
    for (const m of regressions) console.error(`  ${m.family}@${m.css}: chrome=${m.chrome} ours=${m.ours}`);
    process.exit(1);
  }
  console.log(`no regressions vs baseline (baseline misses: ${baseline.misses.length}, this run: ${misses.length}).`);
}

await main();

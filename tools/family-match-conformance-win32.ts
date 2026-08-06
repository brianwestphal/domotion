/**
 * Conformance oracle for the DECLARED-FAMILY style matcher on Windows.
 *
 * Sibling of `tools/family-match-conformance.ts` (doc 109, macOS) and
 * `tools/family-match-conformance-linux.ts`. Blink runs different code for
 * this step on each platform; on Windows there is NO second in-family
 * re-selection step the way macOS has one — `FontCache::CreateTypeface`
 * reduces to `matchFamilyStyle(name, font_description.SkiaFontStyle())`
 * (`fonts/skia/font_cache_skia.cc:262-295`, `win/font_cache_skia_win.cc:170-176`,
 * rev 7d859f27; same shape at tag 147.0.7727.15), and DirectWrite picks the
 * cut inside that call: `SkFontMgr_DirectWrite::onMatchFamilyStyle` →
 * `SkFontStyleSet_DirectWrite::matchStyle` → `FindFamilyName` +
 * `GetFirstMatchingFont(weight, width, slant)` wrapped in
 * `FirstMatchingFontWithoutSimulations` (Skia rev fd139e79 — the revision the
 * tag's DEPS pins — `src/ports/SkFontMgr_win_dw.cpp:52-92,861-872`; the
 * simulation-stripping loop is ACTIVE because Chrome defines
 * `SK_WIN_FONTMGR_NO_SIMULATIONS`, `skia/BUILD.gn:65` at the tag).
 *
 * That structural argument ("the mechanism is the same call") went unmeasured
 * on this platform, and on this exact platform a resolver once shipped
 * "default-on" while answering nothing for weeks. This oracle is the missing
 * evidence: it sweeps every installed family crossed with the CSS weight
 * ladder INCLUDING intermediate rungs (the macOS port was exact at all nine
 * canonical weights and divergent in the 301-399 / 501-599 bands — a
 * canonical-only sweep could not have seen that), asks Chrome over CDP, asks
 * the shipped win32 helper's `family` query — the exact call
 * `win32PrimaryCutKey` makes in the render path, not a restatement — and
 * requires agreement.
 *
 * Chrome's side is read by `postScriptName` (family names cannot distinguish
 * cuts) and selected by maximum `glyphCount` (the array is not
 * coverage-ordered). Rows where Chrome's pick is outside both the requested
 * family and the helper's matched family are skipped as coverage artifacts of
 * the Latin probe text. When the helper reports the family as not installed
 * (`found:false` — DirectWrite's `FindFamilyName` is exact), the row agrees
 * iff Chrome's paint left the requested family too.
 *
 * Baseline: `tests/baselines/family-match-windows.json` — an ENV-KEYED SET
 * (tools/family-match-baseline.ts): one recorded baseline per environment
 * fingerprint (platform/arch/OS build/font-inventory digest), so the arm64
 * Parallels Windows 11 VM and CI's x64 windows-latest runner each carry
 * their own. The comparator judges against the entry matching THIS run's
 * fingerprint and REFUSES to judge (exit 3) when none matches;
 * `--write-baseline` records/replaces only this environment's entry.
 *
 * Usage (Windows only — e.g. on the Parallels VM):
 *   npx tsx tools/family-match-conformance-win32.ts                # compare vs baseline
 *   npx tsx tools/family-match-conformance-win32.ts --json
 *   npx tsx tools/family-match-conformance-win32.ts --write-baseline
 *
 * Exit codes: 0 ok / 1 regression vs baseline / 2 cannot run / 3 environment
 * mismatch (refused to judge).
 */
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import * as fontkit from "fontkit";
import { win32FamilySuffixAdjustment } from "../src/render/win32-family-suffix.js";
import {
  FAMILY_MATCH_ENV_KEYS, readBaselineSet, selectBaseline, describeRecordedEnvs, writeBaselineSet,
} from "./family-match-baseline.js";

const WEIGHTS = [100, 200, 300, 350, 400, 450, 500, 550, 600, 700, 800, 900] as const;
const BASELINE = resolve("tests", "baselines", "family-match-windows.json");
/** Fingerprint fields across which comparison is invalid (env-keyed baselines). */
const ENV_KEYS = FAMILY_MATCH_ENV_KEYS.win32;
const HELPER = process.env.DOMOTION_HELPER_PATH
  ?? resolve("tools", "win32-glyph-extractor", "domotion-glyph-paths.exe");
const FONT_DIR = join(process.env.WINDIR ?? "C:\\Windows", "Fonts");

interface OurAnswer { found: boolean; postscriptName?: string; familyName?: string; path?: string }
interface Case { family: string; css: number; ours: OurAnswer }
interface Miss { family: string; css: number; chrome: string; ours: string }

/**
 * family name → PostScript names of its faces, read from the font files.
 *
 * Both the plain (name ID 1) and typographic (name ID 16) family names are
 * recorded: DirectWrite's system collection groups by its weight-stretch-style
 * model, and depending on the face one or the other is the name that model
 * uses. The union is only consulted for the coverage-artifact skip rule and
 * the sweep's family axis — both sides of the comparison get the same string
 * either way, so the grouping model cannot bias the verdict.
 */
function installedFamilies(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (family: unknown, ps: unknown): void => {
    if (typeof family !== "string" || family === "" || family.startsWith("@")) return;
    if (!out.has(family)) out.set(family, new Set());
    if (typeof ps === "string" && ps !== "") out.get(family)!.add(ps);
  };
  for (const entry of readdirSync(FONT_DIR)) {
    if (![".ttf", ".otf", ".ttc", ".otc"].includes(extname(entry).toLowerCase())) continue;
    try {
      // `any` at the fontkit boundary, as everywhere else in this repo.
      const opened: any = fontkit.openSync(join(FONT_DIR, entry));
      for (const face of (opened.fonts ?? [opened])) {
        add(face?.familyName, face?.postscriptName);
        const name16 = face?.name?.records?.preferredFamily?.en;
        add(name16, face?.postscriptName);
      }
    } catch { /* unreadable or unsupported face */ }
  }
  return out;
}

function runEnv(chromium_: string): Record<string, string | number> {
  let osBuild = "unknown";
  try {
    osBuild = execFileSync("cmd", ["/c", "ver"], { encoding: "utf8" }).trim();
  } catch { /* not cmd-compatible */ }
  const files = readdirSync(FONT_DIR).filter((f) => [".ttf", ".otf", ".ttc", ".otc"].includes(extname(f).toLowerCase())).sort();
  return {
    platform: process.platform,
    arch: process.arch,
    // The browser that produced Chrome's side of every comparison. See
    // FAMILY_MATCH_ENV_KEYS for why it is part of the fingerprint.
    chromium: chromium_,
    osBuild,
    fontCount: files.length,
    fontDigest: createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 16),
  };
}

function runHelper(queries: Array<{ type: "family"; name: string; cssWeight: number; cssStretch?: number }>): OurAnswer[] {
  const out = execFileSync(HELPER, {
    input: JSON.stringify({ fonts: [], queries }),
    encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
  });
  const results = (JSON.parse(out) as { results: Array<OurAnswer & { error?: string }> }).results;
  if (results.some((r) => r?.error != null)) {
    console.error("helper reported an error — is the binary current?", results.find((r) => r?.error != null)?.error);
    process.exit(2);
  }
  return results;
}

function ourAnswers(families: string[]): Map<string, Map<number, OurAnswer>> {
  // Pass 1: the exact family at the run's weight — Blink's `CreateTypeface` →
  // `matchFamilyStyle(name, SkiaFontStyle())`, which the helper's `family`
  // query mirrors call-for-call.
  const exact = runHelper(families.flatMap((name) =>
    WEIGHTS.map((w) => ({ type: "family" as const, name, cssWeight: w }))));
  // Pass 2: for misses, Blink's family-name suffix adjustment — the SAME
  // shipped table + order the render path uses (`win32FamilySuffixAdjustment`,
  // transcribed from `win/font_cache_skia_win.cc:335-480`), with the suffix's
  // value replacing that axis of the description.
  const map = new Map<string, Map<number, OurAnswer>>();
  const retries: Array<{ family: string; w: number; query: { type: "family"; name: string; cssWeight: number; cssStretch?: number } }> = [];
  families.forEach((family, fi) => {
    const inner = new Map<number, OurAnswer>();
    WEIGHTS.forEach((w, wi) => {
      const r = exact[fi * WEIGHTS.length + wi] ?? { found: false };
      inner.set(w, r);
      if (!r.found) {
        const adjusted = win32FamilySuffixAdjustment(family);
        if (adjusted != null) {
          retries.push({ family, w, query: {
            type: "family", name: adjusted.family,
            cssWeight: adjusted.weight ?? w,
            ...(adjusted.stretch != null ? { cssStretch: adjusted.stretch } : {}),
          } });
        }
      }
    });
    map.set(family, inner);
  });
  if (retries.length > 0) {
    const retried = runHelper(retries.map((r) => r.query));
    retries.forEach((r, i) => {
      const answer = retried[i];
      if (answer?.found) map.get(r.family)!.set(r.w, answer);
    });
  }
  return map;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const writeBaseline = argv.includes("--write-baseline");

  if (process.platform !== "win32") {
    console.error("family-match conformance (win32) must run on Windows (it scores the DirectWrite matcher).");
    process.exit(2);
  }
  if (!existsSync(HELPER)) {
    console.error(`win32 glyph helper not built — see tools/win32-glyph-extractor (looked for ${HELPER}).`);
    process.exit(2);
  }

  const members = installedFamilies();
  // Families with a single face cannot discriminate between any two rules.
  const families = [...members.entries()].filter(([, ps]) => ps.size >= 2).map(([f]) => f).sort();

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
      scored++;
      if (!requestedMembers.has(chrome)) { agree++; rejectAgree++; }
      else misses.push({ family: d.family, css: d.css, chrome, ours: "(not installed per DirectWrite)" });
      continue;
    }
    const matchedMembers = d.ours.familyName != null ? (members.get(d.ours.familyName) ?? new Set<string>()) : new Set<string>();
    if (!requestedMembers.has(chrome) && !matchedMembers.has(chrome)) { skipped++; continue; }
    scored++;
    if (chrome === d.ours.postscriptName) agree++;
    else misses.push({ family: d.family, css: d.css, chrome, ours: d.ours.postscriptName ?? "(none)" });
  }
  const chromiumVersion = browser.version();
  await browser.close();

  const env = runEnv(chromiumVersion);
  const report = {
    meta: { suite: "family-match", os: "windows", capturedAt: new Date().toISOString(), env, weights: WEIGHTS },
    summary: { families: families.length, cases: cases.length, scored, agree, rejectAgree, skipped, misses: misses.length },
    misses,
  };

  mkdirSync(resolve("tests", "output"), { recursive: true });
  writeFileSync(resolve("tests", "output", "family-match-conformance-windows.json"), JSON.stringify(report, null, 2));

  if (asJson) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`families ${families.length}  cases ${cases.length}  scored ${scored}  skipped ${skipped}`);
    console.log(`agreement ${agree}/${scored} (${scored > 0 ? ((agree / scored) * 100).toFixed(2) : "—"}%)  (agreed rejections: ${rejectAgree})`);
    for (const m of misses) console.log(`  ${m.family}@${m.css}: chrome=${m.chrome} ours=${m.ours}`);
  }

  if (writeBaseline) {
    mkdirSync(resolve("tests", "baselines"), { recursive: true });
    const { replaced, total } = writeBaselineSet(BASELINE, report, ENV_KEYS);
    console.log(`baseline ${replaced ? "replaced" : "recorded"} for this environment: ${BASELINE} (${total} environment(s) in the set)`);
    return;
  }

  const entries = readBaselineSet(BASELINE);
  if (entries.length === 0) {
    console.log("no committed baseline yet (tests/baselines/family-match-windows.json) — advisory run only.");
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

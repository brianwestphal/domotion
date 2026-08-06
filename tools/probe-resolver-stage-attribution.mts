// Which STAGE of our per-codepoint resolver produced each answer, and how often
// does that stage disagree with Chrome?
//
// DM-1854's inventory says `fallbackFontChain` — the calibrated per-Unicode-block
// table — "has no counterpart in Blink": Chrome goes declared families →
// segmented faces → platform system fallback, and we interpose a static table
// between the last two. The inventory calls that interposition "the root of the
// whole 2026-07 wrong-font cycle". It has never been quantified.
//
// This attributes each codepoint's answer to a stage WITHOUT touching production
// code, by classifying the resolved key:
//
//   declared   the key is in the run's declared family chain
//   sysfb      `sysfb:` — the LIVE platform resolver (or the colour-emoji
//              by-name short-circuit, which is also a Blink stage)
//   static     the key appears in `fallbackFontChain(cp, …)` — the interposed
//              table, the stage Blink does not have
//   tofu       nothing covered it
//
// Then it joins that against a conformance report's mismatch rows to get a
// per-stage disagreement RATE, which is the number the inventory's claim needs.
//
//   npx tsx tools/probe-resolver-stage-attribution.mts <report.json> [i/N]
//   npx tsx tools/probe-resolver-stage-attribution.mts --family "Times" [i/N]
//
// Measured on macOS (dev Mac, 2,635 fonts), stride 1/20 of the assigned
// universe, four structurally different stacks:
//
//   stack                    declared   sysfb    static    tofu
//   Times                        0.43%  24.58%    0.01%   74.99%
//   system-ui                    0.83%  27.11%    0.01%   72.06%
//   Menlo/monospace              1.03%  23.97%    0.01%   74.99%
//   Hiragino Sans                5.37%  19.74%    0.01%   74.88%
//
// One answer in ~14,600, on every stack. So on macOS with the live resolver
// default-on, the interposed table is effectively inert AS A DECIDER — which is
// not the same as unused: a separate profile found it WALKED for ~28% of
// codepoints, where it is the second-largest cost centre in the resolver.
//
// Read the platform caveat before quoting any of this. `fallbackFontChain`
// dispatches per platform, and on WINDOWS it returns `win32FallbackChain` — the
// transcription of Blink's own hardcoded per-script table, which Chrome really
// does consult first. There the "static" row is parity, not interposition. The
// no-counterpart-in-Blink claim is a macOS/Linux one.
import { readFileSync } from "node:fs";
import {
  fallbackFontChain, resolveFont, resolveFontKey, resolveFontKeyChain,
  resolveFontForCodepoint,
} from "../src/render/font-resolution.js";
import { buildUniverse } from "./font-conformance.js";

// `--family "<stack>"` sweeps a stack directly (distribution only, no Chrome
// column); otherwise the first positional is a conformance report and the
// mismatch column is joined from it.
const famArgIdx = process.argv.indexOf("--family");
const familyOverride = famArgIdx > 0 ? process.argv[famArgIdx + 1] : null;
const reportPath = familyOverride == null ? process.argv[2] : null;
if (reportPath == null && familyOverride == null) {
  console.error("usage: stage-attribution.mts <report.json> [shard] | --family \"<stack>\" [shard]");
  process.exit(2);
}
const report = reportPath == null ? { meta: {}, mismatches: [] } : JSON.parse(readFileSync(reportPath, "utf-8")) as {
  meta: { slice?: { codepoints?: number }; stackPrimaries?: Array<{ fontFamily: string; fontSize: number; fontWeight: number; fontStyle: string }> };
  mismatches: Array<{ cp: number; ourKey: string; stack: string }>;
};

const spec = report.meta.stackPrimaries?.[0];
const fontFamily = familyOverride ?? spec?.fontFamily;
const fontSize = spec?.fontSize ?? 16;
const fontWeight = spec?.fontWeight ?? 400;
if (fontFamily == null) { console.error("no stack: pass --family or a report with stackPrimaries"); process.exit(2); }

const primaryKey = resolveFontKey(fontFamily);
const chain = resolveFontKeyChain(fontFamily);
const primary = resolveFont(fontFamily, fontWeight, fontSize, 0);
if (primary == null) { console.error(`primary did not resolve for ${fontFamily}`); process.exit(2); }
const declared = new Set(chain);

function stageOf(cp: number, key: string | null, covered: boolean): string {
  if (!covered || key == null) return "tofu";
  if (declared.has(key)) return "declared";
  if (key.startsWith("sysfb:")) return "sysfb";
  if (fallbackFontChain(cp, primaryKey, "en").includes(key)) return "static";
  return "other";
}

// The oracle's OWN universe and stride, so the two columns below describe the
// same set of codepoints. An approximation here (a dense stride of the BMP+SMP)
// made the overall distribution and the mismatch rows disagree about which
// codepoints existed, which is exactly the kind of mismatch that turns a
// cross-tabulation into nonsense.
const shard = process.argv.find((a) => /^\d+\/\d+$/.test(a)) ?? "1/10";
const [si, sn] = shard.split("/").map((x) => parseInt(x, 10));
const cps = buildUniverse({ includePua: true, ranges: null })
  .filter((_, i) => i % sn === si - 1);

const overall = new Map<string, number>();
for (const cp of cps) {
  const r = resolveFontForCodepoint(cp, primary, primaryKey, fontWeight, fontSize, 0, undefined, "en", chain);
  const s = stageOf(cp, r.key, r.covered);
  overall.set(s, (overall.get(s) ?? 0) + 1);
}

const mismatchByStage = new Map<string, number>();
for (const row of report.mismatches) {
  const s = stageOf(row.cp, row.ourKey, true);
  mismatchByStage.set(s, (mismatchByStage.get(s) ?? 0) + 1);
}

const pct = (n: number, d: number): string => d === 0 ? "—" : `${((n / d) * 100).toFixed(2)}%`;
console.log(`stack: ${fontFamily} @${fontSize}px/${fontWeight}   primary=${primaryKey}   chain=[${chain.join(", ")}]`);
console.log(`swept ${cps.length} codepoints; report carries ${report.mismatches.length} mismatch rows\n`);
console.log("stage      resolved        share    mismatch rows   share of mismatches");
for (const s of ["declared", "sysfb", "static", "other", "tofu"]) {
  const o = overall.get(s) ?? 0, m = mismatchByStage.get(s) ?? 0;
  if (o === 0 && m === 0) continue;
  console.log(
    `${s.padEnd(10)} ${String(o).padStart(8)}  ${pct(o, cps.length).padStart(8)}`
    + `   ${String(m).padStart(8)}       ${pct(m, report.mismatches.length).padStart(8)}`,
  );
}

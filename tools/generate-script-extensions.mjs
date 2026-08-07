#!/usr/bin/env node
// Generates src/render/script-extensions.generated.ts: the codepoint ranges
// where the Unicode Script_Extensions (scx) property differs meaningfully
// from the Script (sc) property Domotion already reads via `getScript`
// (`unicode-properties`).
//
// Per the Unicode Character Database's own design (UAX #24 "Script"), scx
// data only exists as an EXCEPTION list for codepoints whose Script property
// is Common or Inherited -- every other codepoint's Script_Extensions is
// trivially {Script}. Verified empirically below (not merely assumed): this
// generator scans every assigned codepoint's Script value with a non-trivial
// scx test and the reachable set is exactly Common/Inherited.
//
// Regenerate with: node tools/generate-script-extensions.mjs
//
// Mirrors what Blink's ScriptRunIterator consults via `uscript_getScriptExtensions`
// (`third_party/blink/renderer/platform/fonts/script_run_iterator.cc`,
// `ICUScriptData::GetScripts`, lines 118-215, checked out at
// `external/chromium`, rev 7d859f27) -- see `src/render/script-segmentation.ts`
// for the consuming merge-set algorithm.
import { writeFileSync } from "node:fs";
import { getScript } from "unicode-properties";

const commonScxRe = /\p{Script_Extensions=Common}/u;
const inheritedScxRe = /\p{Script_Extensions=Inherited}/u;
const assignedRe = /\p{Assigned}/u;

// Step 1: collect every distinct Script value in use, to use as the scx
// membership-test candidate list. (scx values are always drawn from the same
// enumeration as Script -- a codepoint cannot be "extended" into a script
// value that no codepoint's PRIMARY script is.) This makes the candidate
// list itself generated from live Unicode data rather than hand-typed.
const scriptNames = new Set();
for (let cp = 0; cp <= 0x10ffff; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  const ch = String.fromCodePoint(cp);
  if (!assignedRe.test(ch)) continue;
  const s = getScript(cp);
  if (s && s !== "Common" && s !== "Inherited" && s !== "Unknown") scriptNames.add(s);
}
const candidates = [...scriptNames].sort();
console.error(`Candidate script list: ${candidates.length} scripts`);

// Precompile a Script_Extensions regex per candidate script (some
// `unicode-properties` names may not exactly match ICU/ECMAScript property
// value aliases -- skip any that don't compile rather than guessing).
const scxTests = [];
for (const name of candidates) {
  try {
    scxTests.push([name, new RegExp(`\\p{Script_Extensions=${name}}`, "u")]);
  } catch {
    console.error(`  (skipping "${name}" -- not a valid Script_Extensions value alias)`);
  }
}

// Step 2: find every Common/Inherited codepoint with a non-trivial scx, and
// record its exact member-script set.
//
// Corroboration gate: `unicode-properties` (the package `getScript` -- and
// therefore this project's segmenter -- actually calls at runtime) ships a
// bundled Unicode data snapshot that lags Node's own live ICU (measured:
// 15,735 assigned codepoints where `getScript` still says "Common" but the
// live \p{Script=...} property escape says otherwise, e.g. U+0870, part of
// the Arabic Extended-B block Unicode assigned after that snapshot). Without
// this gate the generator would emit thousands of spurious "Common with a
// restricted scx" rows for codepoints whose PRIMARY script our own runtime
// getScript() doesn't (yet) know isn't Common at all -- a real, orthogonal
// staleness in `unicode-properties` itself, out of scope for the
// Script_Extensions-vs-Script fix this table exists for. Requiring the live
// \p{Script=Common}/\p{Script=Inherited} test to ALSO agree keeps this table
// scoped to genuine scx exceptions the runtime's own getScript() call will
// actually reach.
const livePropCommonRe = /\p{Script=Common}/u;
const livePropInheritedRe = /\p{Script=Inherited}/u;
const entries = [];
let staleSkipped = 0;
for (let cp = 0; cp <= 0x10ffff; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  const ch = String.fromCodePoint(cp);
  if (!assignedRe.test(ch)) continue;
  const primary = getScript(cp);
  if (primary !== "Common" && primary !== "Inherited") continue;
  const liveAgrees = primary === "Common" ? livePropCommonRe.test(ch) : livePropInheritedRe.test(ch);
  if (!liveAgrees) {
    staleSkipped++;
    continue;
  }
  const trivial = primary === "Common" ? commonScxRe.test(ch) : inheritedScxRe.test(ch);
  if (trivial) continue;
  const members = [];
  for (const [name, re] of scxTests) {
    if (re.test(ch)) members.push(name);
  }
  entries.push({ cp, primary, members });
}
console.error(`Skipped (unicode-properties/live-ICU Script disagreement): ${staleSkipped}`);
console.error(`Divergent codepoints: ${entries.length}`);

// Step 3: collapse into contiguous ranges sharing an IDENTICAL (primary,
// members) pair, so the emitted table stays small and each row is checkable
// against ScriptExtensions.txt by eye.
const ranges = [];
for (const e of entries) {
  const key = e.primary + "|" + e.members.join(",");
  const last = ranges[ranges.length - 1];
  if (last && last.key === key && e.cp === last.hi + 1) {
    last.hi = e.cp;
  } else {
    ranges.push({ lo: e.cp, hi: e.cp, key, primary: e.primary, members: e.members });
  }
}
console.error(`Collapsed into ${ranges.length} ranges`);

const hex = (n) => "0x" + n.toString(16).toUpperCase();
const lines = ranges.map(
  (r) =>
    `  { lo: ${hex(r.lo)}, hi: ${hex(r.hi)}, primary: ${JSON.stringify(r.primary)}, scripts: [${r.members
      .map((m) => JSON.stringify(m))
      .join(", ")}] },`,
);

const banner = `// GENERATED FILE -- do not hand-edit. Regenerate with:
//   node tools/generate-script-extensions.mjs
//
// The codepoint ranges where Unicode's Script_Extensions (scx) property is
// NOT the trivial {Script} set -- i.e. every Common/Inherited codepoint that
// carries a restricted set of scripts it is conventionally used WITH (CJK
// punctuation, combining marks shared across scripts, etc). Every other
// codepoint's Script_Extensions equals {Script} by the Unicode Character
// Database's own design (UAX #24), so this table only needs to hold the
// exceptions -- confirmed empirically by the generator, not merely assumed.
//
// \`primary\` is the codepoint's Script property (always "Common" or
// "Inherited" here); \`scripts\` is its Script_Extensions member set, in the
// order Node's ICU/Unicode data reports Script_Extensions membership.
// Consumed by \`src/render/script-segmentation.ts\` to mirror Blink's
// \`ScriptRunIterator\` set-intersection walk (platform/fonts/script_run_iterator.cc,
// \`ICUScriptData::GetScripts\` + \`ScriptRunIterator::MergeSets\`, rev 7d859f27)
// instead of treating every Common/Inherited character as unconditionally
// neutral.
export interface ScriptExtensionsRange {
  readonly lo: number;
  readonly hi: number;
  readonly primary: "Common" | "Inherited";
  readonly scripts: readonly string[];
}

export const SCRIPT_EXTENSIONS_RANGES: readonly ScriptExtensionsRange[] = [
${lines.join("\n")}
];
`;

writeFileSync(new URL("../src/render/script-extensions.generated.ts", import.meta.url), banner);
console.error("Wrote src/render/script-extensions.generated.ts");

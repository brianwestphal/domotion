#!/usr/bin/env node
/**
 * SYNTHETIC stack corpus for the font-conformance oracle — derived from a
 * STATED RULE, not harvested and not authored.
 *
 * WHY THIS EXISTS
 *
 * The oracle's codepoint axis is genuinely exhaustive (every assigned codepoint
 * the host's ICU defines). Its stack axis is not: it is the set of
 * (family, size, weight, style, stretch, variation-settings) combinations the
 * FIXTURES happen to compute. So "the oracle reports N mismatches" has always
 * meant "…for the stacks we happened to harvest", and a consumer page carrying
 * a stack no fixture contains is unmeasured.
 *
 * Measured on the committed macOS corpus (434 stacks harvested from 1,115
 * fixtures), the shape of that hole is stark. Every CSS generic family IS
 * present, but almost every one of them only at the CSS initial weight, style
 * and stretch:
 *
 *     cursive       1 stack   (16px / 400 / normal / 100%)
 *     fantasy       1 stack   (16px / 400 / normal / 100%)
 *     ui-serif      1 stack   ·  ui-sans-serif 1 ·  ui-monospace 1
 *     ui-rounded    1 stack   ·  emoji         1 ·  fangsong     1
 *     math          3 stacks
 *     weight 200    0 stacks in the ENTIRE corpus
 *     weight 100    1 stack   ·  300: 1  ·  500: 2
 *     non-100% stretch  8 stacks of 434
 *
 * A cut-selection defect at weight 700 is exactly the class that hid on Windows
 * behind a weight-400 sample (doc 107, "Do not read that 0.488% as a verdict"),
 * and `cursive` at 700 is a decision nothing currently asks about.
 *
 * WHY DERIVED RATHER THAN LISTED
 *
 * A hand-written list of interesting stacks is the same sampled artifact the
 * whole oracle exists to eliminate — it can only contain the cases someone
 * already thought of, and it drifts as people add "one more". So the corpus is
 * the CROSS PRODUCT of four enumerations that are themselves fixed by CSS:
 *
 *     generic families  the 13 CSS Fonts 4 generic-family KEYWORDS
 *     weights           the 9-rung CSS weight ladder, 100…900
 *     stretches         the 9 CSS font-stretch keywords, as the PERCENTAGES
 *                       Chrome computes them to
 *     styles            normal, italic
 *
 *     13 x 9 x 9 x 2 = 2,106 stacks
 *
 * There is nothing to curate: adding a case means changing the rule, and the
 * corpus's identity (see `corpusIdentity`) changes with it, which makes the
 * baseline comparator refuse to compare across the change rather than silently
 * grade a different question.
 *
 * WHAT THE RULE DELIBERATELY DOES NOT VARY
 *
 * **Size.** Every synthetic stack is 16px, the CSS initial `medium`. Size is
 * part of a stack's identity elsewhere in this oracle for a real reason (macOS
 * optical cuts mean Chrome reports a different face at 16px than at 32px), so
 * this is a stated gap and not an oversight: crossing in a size ladder would
 * multiply an already 1,944-way product, and the harvested corpus — which does
 * span sizes — remains the instrument for that axis. See doc 107.
 *
 * **`font-variation-settings`.** A synthetic axis location is only meaningful
 * against a face that HAS the axis, and no generic family is guaranteed to
 * resolve to a variable face on any platform. The live-axis question is asked
 * by the paired-oracle fixture instead (`tools/variable-axis-oracle-pair.ts`),
 * which drives a webfont whose axes are known.
 *
 * ORDERING IS PART OF THE RULE
 *
 * Stacks are ordered by DISTANCE from the CSS initial state (400 / normal /
 * 100%) — how many of the three axes differ — then by the enumeration order of
 * each axis. That makes every `--max-stacks` prefix a meaningful slice rather
 * than an arbitrary one:
 *
 *     --max-stacks 13     one stack per generic family, all at CSS initial
 *     --max-stacks 234    …plus every single-axis departure from it
 *     (no cap)            the full 2,106-way product
 *
 * ---------------------------------------------------------------------------
 * Usage
 *
 *   npx tsx tools/font-conformance-synthetic-stacks.ts            # write the corpus
 *   npx tsx tools/font-conformance-synthetic-stacks.ts --out f.json
 *   npx tsx tools/font-conformance-synthetic-stacks.ts --print    # rule summary only
 *
 * Then sweep it like any other corpus — its own file, its own baseline, its own
 * CI dispatch (`.github/workflows/font-conformance-synthetic.yml`):
 *
 *   npx tsx tools/font-conformance.ts \
 *     --stacks tools/font-conformance-stacks.synthetic.json --max-stacks 12
 *
 * The output file is GITIGNORED on purpose. It is a pure function of the rule
 * above, so committing it would create a second copy that can be edited — and a
 * hand-edited "synthetic" corpus is just a curated list with a misleading name.
 * Regenerating is deterministic and byte-identical, including the identity
 * string, so a regenerated corpus stays comparable with the baseline measured
 * against it.
 * ---------------------------------------------------------------------------
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/** Bump when the RULE changes. Part of the corpus identity, so the baseline
 *  comparator refuses to compare a v1 measurement against a v2 one. */
export const RULE_VERSION = 1;

/** Where the generator writes by default. Gitignored — see the header. */
export const DEFAULT_SYNTHETIC_STACKS_FILE = "tools/font-conformance-stacks.synthetic.json";

/**
 * The corpus is portable between platforms, and this marker is how the sweep
 * knows that without an override.
 *
 * A HARVESTED corpus is not portable: it records COMPUTED style, and the
 * computed `font-family` of an element that declares none is Chrome's
 * per-platform default-font preference (`Times` on macOS, `"Times New Roman"`
 * on Linux) — so sweeping one platform's harvested corpus on another asks about
 * a stack that platform never computes. None of that applies here. Every family
 * in this corpus is a CSS GENERIC KEYWORD, written literally, identical on every
 * platform. What each keyword resolves to differs per platform, which is the
 * question being asked rather than a reason not to ask it.
 */
export const PORTABLE_CORPUS_PLATFORM = "any";

/**
 * The CSS generic-family KEYWORDS, taken from the CSS Fonts 4 grammar rather
 * than from anyone's sense of which ones matter:
 *
 *     <generic-font-complete>   = serif | sans-serif | system-ui | cursive
 *                               | fantasy | math | monospace          (7)
 *     <generic-font-incomplete> = ui-serif | ui-sans-serif
 *                               | ui-monospace | ui-rounded | emoji   (5)
 *
 * …plus the bare `fangsong` keyword, which earlier drafts spelled as a keyword
 * and current ones spell `generic(fangsong)`. The functional
 * `<generic-font-script-specific>` forms — `generic(fangsong)`, `generic(kai)`,
 * `generic(khmer-mul)`, `generic(nastaliq)` — are omitted because Chrome does
 * not parse the `generic()` function at all, so every one of them would measure
 * a parse failure rather than a font decision.
 *
 * 13 keywords in total.
 *
 * WORTH KNOWING: Chrome implements only SEVEN of these as generics. Blink's
 * `ConsumeGenericFamily` is `ConsumeIdentRange(CSSValueID::kSerif,
 * CSSValueID::kMath)` (`core/css/properties/css_parsing_utils.cc:6344-6345`)
 * over the keyword block at `core/css/css_value_keywords.json5:173-180`, which
 * runs `serif, sans-serif, cursive, fantasy, monospace, system-ui,
 * -webkit-body, math` and stops. `external/chromium` at `7d859f27` (2026-06-27).
 *
 * The other six (`ui-serif`, `ui-sans-serif`, `ui-monospace`, `ui-rounded`,
 * `emoji`, `fangsong`) therefore parse as ordinary <family-name> idents and are
 * looked up as literal family names. That is NOT a reason to drop them — it is
 * the reason to keep them. A consumer page that writes `ui-rounded` gets
 * whatever Chrome's family lookup does with an unmatched name, and our resolver
 * has to reach the same answer; nothing else in either corpus asks that
 * question at any weight but 400.
 */
export const GENERIC_FAMILIES: readonly string[] = [
  // <generic-font-complete>
  "serif",
  "sans-serif",
  "system-ui",
  "cursive",
  "fantasy",
  "math",
  "monospace",
  // <generic-font-incomplete>
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  // legacy bare keyword for what CSS Fonts 4 now spells generic(fangsong)
  "fangsong",
];

/** The CSS weight ladder. 400 first: it is the initial value, and the ordering
 *  rule below measures distance from it. */
export const WEIGHT_LADDER: readonly number[] = [400, 100, 200, 300, 500, 600, 700, 800, 900];

/**
 * The CSS `font-stretch` keywords, as the PERCENTAGES Chrome computes them to.
 *
 * Stored as percentages rather than keywords because that is what the harvested
 * corpus records (`getComputedStyle(el).fontStretch` serializes the computed
 * value), so the two corpora's stack keys mean the same thing and a stack that
 * appears in both is the same stack. `100%` first — the initial value.
 */
export const STRETCH_KEYWORDS: ReadonlyArray<{ keyword: string; percent: string }> = [
  { keyword: "normal", percent: "100%" },
  { keyword: "ultra-condensed", percent: "50%" },
  { keyword: "extra-condensed", percent: "62.5%" },
  { keyword: "condensed", percent: "75%" },
  { keyword: "semi-condensed", percent: "87.5%" },
  { keyword: "semi-expanded", percent: "112.5%" },
  { keyword: "expanded", percent: "125%" },
  { keyword: "extra-expanded", percent: "150%" },
  { keyword: "ultra-expanded", percent: "200%" },
];

/** `normal` first — the initial value. `oblique` is omitted: Chrome's font
 *  matching treats it as the same slope slot as italic, so it would add 972
 *  stacks that ask the same matching question. */
export const STYLES: readonly string[] = ["normal", "italic"];

/**
 * The one size every synthetic stack uses: the CSS initial `medium`.
 * See the header for why size is deliberately not crossed in.
 */
export const SYNTHETIC_FONT_SIZE = 16;

/** A synthetic corpus entry. Structurally identical to a harvested `StackSpec`
 *  so `tools/font-conformance.ts` needs no special case to sweep it. */
export interface SyntheticStack {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: string;
  fontStretch: string;
  /** Always 0 — nothing here came from a fixture, and pretending otherwise
   *  would make `--max-stacks` read as "most used" when it means "closest to
   *  the CSS initial state". */
  fixtures: number;
  /** Reproduction recipe rather than a fixture path: there is no fixture. */
  example: string;
}

/**
 * The rule, evaluated.
 *
 * Ordered by distance from the CSS initial state (how many of weight / stretch /
 * style differ from 400 / 100% / normal), then by each axis's own enumeration
 * order. Deterministic: same rule ⇒ same list, byte for byte.
 */
export function buildSyntheticStacks(): SyntheticStack[] {
  const rows: Array<{ distance: number; order: number[]; stack: SyntheticStack }> = [];
  for (let gi = 0; gi < GENERIC_FAMILIES.length; gi++) {
    for (let wi = 0; wi < WEIGHT_LADDER.length; wi++) {
      for (let si = 0; si < STRETCH_KEYWORDS.length; si++) {
        for (let yi = 0; yi < STYLES.length; yi++) {
          const weight = WEIGHT_LADDER[wi];
          const stretch = STRETCH_KEYWORDS[si];
          const style = STYLES[yi];
          const distance = (wi === 0 ? 0 : 1) + (si === 0 ? 0 : 1) + (yi === 0 ? 0 : 1);
          rows.push({
            distance,
            order: [gi, wi, si, yi],
            stack: {
              fontFamily: GENERIC_FAMILIES[gi],
              fontSize: SYNTHETIC_FONT_SIZE,
              fontWeight: weight,
              fontStyle: style,
              fontStretch: stretch.percent,
              fixtures: 0,
              example:
                `rule v${RULE_VERSION}: ${GENERIC_FAMILIES[gi]} @${SYNTHETIC_FONT_SIZE}px`
                + ` / ${weight} / ${style} / ${stretch.keyword} (${stretch.percent})`,
            },
          });
        }
      }
    }
  }
  rows.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    for (let i = 0; i < a.order.length; i++) {
      if (a.order[i] !== b.order[i]) return a.order[i] - b.order[i];
    }
    return 0;
  });
  return rows.map((r) => r.stack);
}

/**
 * The corpus's identity, in the field the baseline comparator keys on.
 *
 * A harvested corpus records a wall-clock `generatedAt`, which is right for it:
 * re-extracting can genuinely produce a different corpus, and the comparator
 * must refuse to compare across that. A rule-derived corpus has no such
 * property — regenerating it cannot change it — so a timestamp here would
 * invalidate every baseline on every regeneration for no reason at all.
 *
 * So the identity is a DIGEST OF THE RULE'S OUTPUT. Regenerating is
 * comparable; changing the rule is not, which is exactly the discrimination the
 * comparator wants.
 */
export function corpusIdentity(stacks: SyntheticStack[]): string {
  const h = createHash("sha256")
    .update(`synthetic-stacks/v${RULE_VERSION}\n`)
    .update(JSON.stringify(stacks))
    .digest("hex")
    .slice(0, 16);
  return `synthetic:v${RULE_VERSION}:${h}`;
}

export interface SyntheticCorpus {
  /** The rule digest, NOT a timestamp. See `corpusIdentity`. */
  generatedAt: string;
  platform: string;
  sources: string[];
  /** Human-readable statement of the rule, so the file explains itself. */
  rule: {
    version: number;
    generics: readonly string[];
    weights: readonly number[];
    stretches: readonly string[];
    styles: readonly string[];
    fontSize: number;
    total: number;
  };
  stacks: SyntheticStack[];
}

export function syntheticCorpus(): SyntheticCorpus {
  const stacks = buildSyntheticStacks();
  return {
    generatedAt: corpusIdentity(stacks),
    platform: PORTABLE_CORPUS_PLATFORM,
    sources: [
      "(rule-derived) CSS generic families x weight ladder x font-stretch keywords x style"
      + ` — tools/font-conformance-synthetic-stacks.ts v${RULE_VERSION}`,
    ],
    rule: {
      version: RULE_VERSION,
      generics: GENERIC_FAMILIES,
      weights: WEIGHT_LADDER,
      stretches: STRETCH_KEYWORDS.map((s) => `${s.keyword} (${s.percent})`),
      styles: STYLES,
      fontSize: SYNTHETIC_FONT_SIZE,
      total: stacks.length,
    },
    stacks,
  };
}

/** The exact bytes written, so a caller can compare without touching the disk. */
export function serializeCorpus(corpus: SyntheticCorpus): string {
  return `${JSON.stringify(corpus, null, 2)}\n`;
}

function main(argv: string[]): number {
  let out = DEFAULT_SYNTHETIC_STACKS_FILE;
  let printOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") {
      const v = argv[++i];
      if (v == null) throw new Error("--out needs a path");
      out = v;
    } else if (a === "--print") {
      printOnly = true;
    } else if (a === "-h" || a === "--help") {
      process.stdout.write(`${new URL(import.meta.url).pathname}: see the header comment\n`);
      return 0;
    } else {
      throw new Error(`unknown option ${a}`);
    }
  }
  const corpus = syntheticCorpus();
  const byDistance = new Map<number, number>();
  for (const s of corpus.stacks) {
    const d = (s.fontWeight === 400 ? 0 : 1) + (s.fontStretch === "100%" ? 0 : 1) + (s.fontStyle === "normal" ? 0 : 1);
    byDistance.set(d, (byDistance.get(d) ?? 0) + 1);
  }
  process.stdout.write(
    `synthetic stack corpus — rule v${RULE_VERSION}\n`
    + `  ${GENERIC_FAMILIES.length} generics x ${WEIGHT_LADDER.length} weights `
    + `x ${STRETCH_KEYWORDS.length} stretches x ${STYLES.length} styles = ${corpus.stacks.length} stacks\n`
    + `  all at ${SYNTHETIC_FONT_SIZE}px (CSS initial \`medium\`)\n`
    + `  identity ${corpus.generatedAt}\n`
    + [...byDistance.entries()].sort((a, b) => a[0] - b[0])
      .map(([d, n]) => `  ${n} stack(s) at distance ${d} from the CSS initial state\n`).join(""),
  );
  if (printOnly) return 0;
  writeFileSync(out, serializeCorpus(corpus));
  process.stdout.write(`wrote ${corpus.stacks.length} stacks to ${out}\n`);
  return 0;
}

const invokedDirectly = process.argv[1] != null
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`synthetic-stacks failed: ${String(err instanceof Error ? err.message : err)}\n`);
    process.exitCode = 2;
  }
}

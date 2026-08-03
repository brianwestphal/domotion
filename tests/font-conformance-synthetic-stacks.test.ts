/**
 * Unit coverage for the SYNTHETIC stack corpus generator
 * (`tools/font-conformance-synthetic-stacks.ts`).
 *
 * The corpus's whole claim is that it is DERIVED FROM A RULE and therefore
 * cannot drift into a curated list of cases someone already thought of. That
 * claim is only worth anything if the rule is pinned, so what is asserted here
 * is the rule itself: the exact cross product, the ordering that makes a
 * `--max-stacks` prefix meaningful, and the determinism the baseline comparator
 * depends on.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DEFAULT_SYNTHETIC_STACKS_FILE,
  GENERIC_FAMILIES,
  PORTABLE_CORPUS_PLATFORM,
  RULE_VERSION,
  STRETCH_KEYWORDS,
  STYLES,
  SYNTHETIC_FONT_SIZE,
  WEIGHT_LADDER,
  buildSyntheticStacks,
  corpusIdentity,
  serializeCorpus,
  syntheticCorpus,
} from "../tools/font-conformance-synthetic-stacks.js";

/** How far a stack sits from the CSS initial state — the ordering key. */
const distance = (s: { fontWeight: number; fontStretch: string; fontStyle: string }): number =>
  (s.fontWeight === 400 ? 0 : 1) + (s.fontStretch === "100%" ? 0 : 1) + (s.fontStyle === "normal" ? 0 : 1);

describe("the rule", () => {
  it("is exactly the four-way cross product, with nothing added or dropped", () => {
    const stacks = buildSyntheticStacks();
    expect(stacks).toHaveLength(
      GENERIC_FAMILIES.length * WEIGHT_LADDER.length * STRETCH_KEYWORDS.length * STYLES.length,
    );
    expect(stacks).toHaveLength(2106);

    // Every combination present exactly once. A duplicate would double-count a
    // stack in the sweep; a gap would be a curated omission.
    const seen = new Set(stacks.map((s) => `${s.fontFamily}|${s.fontWeight}|${s.fontStretch}|${s.fontStyle}`));
    expect(seen.size).toBe(stacks.length);
    for (const f of GENERIC_FAMILIES) {
      for (const w of WEIGHT_LADDER) {
        for (const st of STRETCH_KEYWORDS) {
          for (const y of STYLES) {
            expect(seen.has(`${f}|${w}|${st.percent}|${y}`)).toBe(true);
          }
        }
      }
    }
  });

  it("uses the CSS weight ladder and both slope slots", () => {
    expect([...WEIGHT_LADDER].sort((a, b) => a - b)).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900]);
    expect(STYLES).toEqual(["normal", "italic"]);
  });

  it("records stretch as the PERCENTAGES Chrome computes the keywords to", () => {
    // Not cosmetic: the harvested corpus stores `getComputedStyle().fontStretch`,
    // which serializes the computed percentage. Storing keywords here would make
    // the same stack look like two different stacks across the two corpora.
    expect(STRETCH_KEYWORDS.map((s) => s.percent))
      .toEqual(["100%", "50%", "62.5%", "75%", "87.5%", "112.5%", "125%", "150%", "200%"]);
  });

  it("holds every stack at the CSS initial font size, and says so in the entry", () => {
    const stacks = buildSyntheticStacks();
    expect(SYNTHETIC_FONT_SIZE).toBe(16);
    for (const s of stacks) {
      expect(s.fontSize).toBe(16);
      // `fixtures: 0` is load-bearing rather than filler: nothing here came from
      // a fixture, and a non-zero value would make `--max-stacks` read as "most
      // used" when it actually means "closest to the CSS initial state".
      expect(s.fixtures).toBe(0);
      expect(s.example).toContain(`rule v${RULE_VERSION}`);
    }
  });
});

describe("ordering makes a --max-stacks prefix meaningful", () => {
  const stacks = buildSyntheticStacks();

  it("is monotone in distance from the CSS initial state", () => {
    let last = -1;
    for (const s of stacks) {
      const d = distance(s);
      expect(d).toBeGreaterThanOrEqual(last);
      last = d;
    }
  });

  it("puts one stack per generic family first, all at the CSS initial state", () => {
    const head = stacks.slice(0, GENERIC_FAMILIES.length);
    expect(head.map((s) => s.fontFamily)).toEqual([...GENERIC_FAMILIES]);
    for (const s of head) {
      expect(distance(s)).toBe(0);
    }
    // …and the 14th stack is already a departure, so the prefix is exactly the
    // per-generic slice and not accidentally more.
    expect(distance(stacks[GENERIC_FAMILIES.length])).toBe(1);
  });

  it("makes the first 234 exactly 'every generic, plus every single-axis departure'", () => {
    const singleAxis = GENERIC_FAMILIES.length
      * ((WEIGHT_LADDER.length - 1) + (STRETCH_KEYWORDS.length - 1) + (STYLES.length - 1));
    const cut = GENERIC_FAMILIES.length + singleAxis;
    expect(cut).toBe(234);
    for (const s of stacks.slice(0, cut)) expect(distance(s)).toBeLessThanOrEqual(1);
    expect(distance(stacks[cut])).toBe(2);
  });
});

describe("corpus identity is a digest, not a timestamp", () => {
  it("is byte-identical across regenerations", () => {
    // The baseline comparator refuses to judge across a change in the corpus's
    // `generatedAt`. A harvested corpus SHOULD invalidate a baseline when it is
    // re-extracted; a rule-derived one must not, because regenerating it cannot
    // change it. A wall-clock stamp here would invalidate every baseline on
    // every CI run, since the corpus is regenerated per job.
    expect(serializeCorpus(syntheticCorpus())).toBe(serializeCorpus(syntheticCorpus()));
    expect(syntheticCorpus().generatedAt).toBe(syntheticCorpus().generatedAt);
    expect(syntheticCorpus().generatedAt).toMatch(/^synthetic:v\d+:[0-9a-f]{16}$/);
  });

  it("changes when the rule's output changes", () => {
    const stacks = buildSyntheticStacks();
    const mutated = stacks.map((s, i) => (i === 0 ? { ...s, fontWeight: 450 } : s));
    expect(corpusIdentity(mutated)).not.toBe(corpusIdentity(stacks));
  });
});

describe("the corpus file the sweep loads", () => {
  it("declares itself portable rather than pinned to one platform", () => {
    // A HARVESTED corpus records computed style, one component of which is
    // Chrome's per-platform default font, so it is not portable. This one holds
    // literal CSS keywords, so it is — and the marker is how the sweep's guard
    // knows without an --allow-foreign-corpus override.
    expect(syntheticCorpus().platform).toBe(PORTABLE_CORPUS_PLATFORM);
    expect(PORTABLE_CORPUS_PLATFORM).toBe("any");
    expect(PORTABLE_CORPUS_PLATFORM).not.toBe(process.platform);
  });

  it("states the rule in the file itself", () => {
    const c = syntheticCorpus();
    expect(c.rule.total).toBe(c.stacks.length);
    expect(c.rule.generics).toEqual([...GENERIC_FAMILIES]);
    expect(c.sources[0]).toContain("rule-derived");
  });

  it("is not committed — a hand-editable copy would defeat the derivation", () => {
    // The generator's default output path is gitignored on purpose. If someone
    // commits it, this fails and says why rather than letting a curated list
    // quietly take the synthetic corpus's place.
    const ignore = readFileSync(".gitignore", "utf-8");
    expect(ignore).toContain(DEFAULT_SYNTHETIC_STACKS_FILE);
  });
});

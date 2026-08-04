/**
 * The harvested stack corpus's identity must be a function of the QUESTIONS it
 * asks, not of when it was extracted.
 *
 * History, because it is the reason this file exists: the identity used to be a
 * wall-clock `generatedAt`, so a routine re-extraction moved it even when the
 * corpus came out byte-identical. The comparator keys on that field, so all
 * three committed baselines correctly-but-uselessly refused to judge, and
 * restoring the gate meant a CI sweep per platform to re-seed baselines that
 * were never stale. The refusal was right; the trigger was a bad proxy for it.
 *
 * These tests pin the discrimination in both directions — what must NOT move the
 * identity, and what must.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { harvestedCorpusIdentity } from "../tools/font-conformance.js";

/** A minimal stack, with the bookkeeping fields the digest must ignore. */
function stack(over: Record<string, unknown> = {}) {
  return {
    fontFamily: "Times", fontSize: 16, fontWeight: 400, fontStyle: "normal",
    fixtures: 3, example: "a.html",
    ...over,
  } as never;
}

describe("harvested corpus identity", () => {
  it("is stable when the corpus is re-extracted unchanged", () => {
    const s = [stack(), stack({ fontFamily: "Menlo" })];
    expect(harvestedCorpusIdentity(s, "darwin")).toBe(harvestedCorpusIdentity(s, "darwin"));
  });

  it("ignores the fixture COUNT — a new fixture using an existing stack asks nothing new", () => {
    const before = [stack({ fixtures: 3 })];
    const after = [stack({ fixtures: 4 })];
    expect(harvestedCorpusIdentity(after, "darwin")).toBe(harvestedCorpusIdentity(before, "darwin"));
  });

  it("ignores which example fixture is cited — that is provenance, not a question", () => {
    expect(harvestedCorpusIdentity([stack({ example: "b.html" })], "darwin"))
      .toBe(harvestedCorpusIdentity([stack({ example: "a.html" })], "darwin"));
  });

  it("ignores ORDER, because the corpus is sorted by fixture count and that moves", () => {
    // This is the one that makes the fixture-count exemption real. The corpus
    // array is ordered by `fixtures` descending, so a single added fixture can
    // permute it; digesting the array as-written would then move the identity
    // for a corpus asking the identical set of questions.
    const a = [stack({ fontFamily: "Times" }), stack({ fontFamily: "Menlo" })];
    const b = [stack({ fontFamily: "Menlo" }), stack({ fontFamily: "Times" })];
    expect(harvestedCorpusIdentity(b, "darwin")).toBe(harvestedCorpusIdentity(a, "darwin"));
  });

  it("MOVES when a stack is added", () => {
    expect(harvestedCorpusIdentity([stack(), stack({ fontFamily: "Menlo" })], "darwin"))
      .not.toBe(harvestedCorpusIdentity([stack()], "darwin"));
  });

  it.each([
    ["fontFamily", { fontFamily: "Menlo" }],
    ["fontSize", { fontSize: 17 }],
    ["fontWeight", { fontWeight: 700 }],
    ["fontStyle", { fontStyle: "italic" }],
    ["fontStretch", { fontStretch: "75%" }],
    ["fontVariationSettings", { fontVariationSettings: '"wght" 350' }],
    ["fontFeatureSettings", { fontFeatureSettings: '"tnum" 1' }],
    ["fontVariantAlternates", { fontVariantAlternates: "historical-forms" }],
    ["fontVariantEmoji", { fontVariantEmoji: "emoji" }],
  ])("MOVES when %s changes", (_label, over) => {
    expect(harvestedCorpusIdentity([stack(over)], "darwin"))
      .not.toBe(harvestedCorpusIdentity([stack()], "darwin"));
  });

  it("MOVES across platforms even when the question set is identical", () => {
    // Not hypothetical: the committed Linux and Windows corpora harvest a
    // byte-identical question set, because an element declaring no family
    // computes to `"Times New Roman"` on both. They are still not
    // interchangeable — the same question gets a different answer on each.
    const s = [stack()];
    expect(harvestedCorpusIdentity(s, "linux")).not.toBe(harvestedCorpusIdentity(s, "win32"));
  });

  it("treats an absent optional property as its default rather than as a distinct value", () => {
    expect(harvestedCorpusIdentity([stack({ fontStretch: "" })], "darwin"))
      .toBe(harvestedCorpusIdentity([stack()], "darwin"));
  });

  describe("the committed corpora", () => {
    const CORPORA = ["darwin", "linux", "win32"] as const;

    it.each(CORPORA)("%s carries an identity that recomputes from its own stacks", (os) => {
      const p = join(process.cwd(), `tools/font-conformance-stacks.${os}.json`);
      const c = JSON.parse(readFileSync(p, "utf-8"));
      // The guard that matters in practice: a corpus edited by hand, or written
      // by an older extractor, would carry an identity its content does not
      // produce — and the comparator would then compare two different corpora.
      expect(harvestedCorpusIdentity(c.stacks, c.platform)).toBe(c.generatedAt);
      expect(c.generatedAt).toMatch(/^harvested:v\d+:[0-9a-f]{16}$/);
    });

    it("gives the three platforms three distinct identities", () => {
      const ids = CORPORA.map((os) => {
        const c = JSON.parse(readFileSync(join(process.cwd(), `tools/font-conformance-stacks.${os}.json`), "utf-8"));
        return c.generatedAt;
      });
      expect(new Set(ids).size).toBe(3);
    });
  });
});

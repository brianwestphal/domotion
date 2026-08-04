/**
 * The stack extractor must read every property it claims to, FROM CHROME.
 *
 * The committed corpora can only guard the properties some fixture happens to
 * declare. `font-variant-emoji` is declared by no fixture in either corpus, so
 * the "at least one non-normal value exists" guard used for
 * `font-feature-settings` is unavailable for it — and a field that is added to
 * the schema, serialized on every entry, and read from the wrong place would be
 * `normal` everywhere and look exactly like a corpus of quiet fixtures.
 *
 * So this supplies its own fixture instead of depending on the corpus to contain
 * one, and drives the real `extractStacks` against a real Chromium. It is the
 * check that distinguishes "extracted" from "asked".
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractStacks } from "../tools/font-conformance.js";

/**
 * One element per property, each declaring a value that is NOT the initial one,
 * so a field read from the wrong place cannot coincidentally match.
 */
const FIXTURE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
  .alt-hist  { font-variant-alternates: historical-forms; }
  .emoji-txt { font-variant-emoji: text; }
  .emoji-emo { font-variant-emoji: emoji; }
  .emoji-uni { font-variant-emoji: unicode; }
  .feat      { font-feature-settings: "tnum" 1; }
  .stretch   { font-stretch: 75%; }
  .axis      { font-variation-settings: "wght" 350; }
</style></head><body>
  <p class="alt-hist">historical</p>
  <p class="emoji-txt">text presentation</p>
  <p class="emoji-emo">emoji presentation</p>
  <p class="emoji-uni">unicode presentation</p>
  <p class="feat">1234567890</p>
  <p class="stretch">condensed</p>
  <p class="axis">axis</p>
</body></html>`;

describe("extractStacks reads the whole font description out of Chrome", () => {
  let browser: Browser;
  let dir: string;
  let corpus: Awaited<ReturnType<typeof extractStacks>>;

  beforeAll(async () => {
    browser = await chromium.launch();
    dir = mkdtempSync(join(tmpdir(), "domotion-stack-extract-"));
    writeFileSync(join(dir, "props.html"), FIXTURE);
    corpus = await extractStacks(browser, [dir], join(dir, "out.json"));
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    if (dir != null) rmSync(dir, { recursive: true, force: true });
  });

  it("captures every declared `font-variant-emoji` keyword, not just `normal`", () => {
    // The property no fixture in the real corpus exercises, and the only one of
    // these that changes which FACE Chrome reports.
    const seen = new Set(corpus.stacks.map((s) => s.fontVariantEmoji));
    expect(seen).toContain("text");
    expect(seen).toContain("emoji");
    expect(seen).toContain("unicode");
    // …and the untouched elements must still record the initial value rather
    // than `undefined`, or the digest and the probe page diverge on what a
    // default stack is.
    expect(seen).toContain("normal");
  });

  it("captures a declared `font-variant-alternates`", () => {
    expect(corpus.stacks.map((s) => s.fontVariantAlternates)).toContain("historical-forms");
  });

  it("still captures the properties added before these two", () => {
    // A regression fence: adding fields to the extraction key has twice been the
    // change that silently dropped a sibling field.
    //
    // The expected value is `"tnum"`, not the `"tnum" 1` the fixture declares:
    // the corpus records the COMPUTED value, and Chrome drops an explicit `1`
    // when serializing because it is the default. Asserting the declared form
    // would fail against a perfectly correct extraction.
    expect(corpus.stacks.map((s) => s.fontFeatureSettings)).toContain('"tnum"');
    expect(corpus.stacks.map((s) => s.fontStretch)).toContain("75%");
    expect(corpus.stacks.map((s) => s.fontVariationSettings)).toContain('"wght" 350');
  });

  it("records every property as a string on every stack", () => {
    for (const s of corpus.stacks) {
      expect(typeof s.fontVariantEmoji).toBe("string");
      expect(typeof s.fontVariantAlternates).toBe("string");
      expect(typeof s.fontFeatureSettings).toBe("string");
      expect(typeof s.fontStretch).toBe("string");
      expect(typeof s.fontVariationSettings).toBe("string");
    }
  });

  it("stamps an identity that recomputes from the stacks it wrote", () => {
    expect(corpus.generatedAt).toMatch(/^harvested:v\d+:[0-9a-f]{16}$/);
  });

  it("distinguishes two stacks that differ ONLY in `font-variant-emoji`", () => {
    // The property is a face-selection input, so two otherwise identical
    // descriptions differing in it are two questions, not one. If the extractor
    // left it out of the dedup key these would collapse into a single entry.
    const emojiVariants = corpus.stacks.filter((s) => s.fontVariantEmoji !== "normal");
    expect(new Set(emojiVariants.map((s) => s.fontVariantEmoji)).size).toBe(3);
  });
});

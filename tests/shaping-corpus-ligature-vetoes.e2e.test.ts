/**
 * The shaping oracle's run corpus must be able to SEE the letter-spacing /
 * text-rendering ligature vetoes (docs/108, DM-1983).
 *
 * Blink emits `liga` / `clig` / `calt` disables whenever `letter-spacing` is
 * non-zero or `text-rendering` is `optimizeSpeed` — `FontFeatureRange::
 * FromFontDescription` (`platform/fonts/shaping/font_features.cc:52-86`, rev
 * 7d859f27) — and `letter_spacing` is the FIRST term of that disjunction, so it
 * outranks the author's `font-variant-ligatures` keyword outright.
 *
 * The corpus recorded none of the three properties, so every swept run had
 * letter-spacing `normal` and text-rendering `auto` and neither veto could fire.
 * A sample that is blind rather than wrong, scoring well.
 *
 * This pins the extractor end of that: the properties are harvested, and — the
 * part that actually matters — runs differing ONLY in them stay DISTINCT rather
 * than deduping into one spec. Without the last, the fixture's
 * "letter-spacing + common-ligatures" rows would collapse onto the plain
 * letter-spacing rows and the case that separates a veto from an overridable
 * default would silently not be swept.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractRuns, type RunCorpus, type RunSpec } from "../tools/shaping-conformance.js";

/** Single words, no whitespace, so the corpus's whitespace-free rule keeps them
 *  and this measures the properties rather than that filter. Each one forms a
 *  common ligature in Times, which is what makes the veto observable at all. */
const WORDS = ["office", "waffle", "affix", "flight"] as const;

const FIXTURE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title><style>
  .t { font-family: Times, serif; font-size: 24px; }
  .ls { letter-spacing: 2px; }
  .speed { text-rendering: optimizeSpeed; }
  .ls-liga { letter-spacing: 2px; font-variant-ligatures: common-ligatures; }
</style></head><body>
${WORDS.map((w) => `<p class="t">${w}</p>`).join("\n")}
${WORDS.map((w) => `<p class="t ls">${w}</p>`).join("\n")}
${WORDS.map((w) => `<p class="t speed">${w}</p>`).join("\n")}
${WORDS.map((w) => `<p class="t ls-liga">${w}</p>`).join("\n")}
</body></html>`;

let browser: Browser;
let dir = "";
let corpus: RunCorpus;

const forWord = (w: string): RunSpec[] => corpus.runs.filter((r) => r.text === w);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "shaping-vetoes-"));
  const fixtures = join(dir, "fixtures");
  mkdirSync(fixtures);
  writeFileSync(join(fixtures, "f.html"), FIXTURE);
  browser = await chromium.launch();
  corpus = await extractRuns(browser, [fixtures], join(dir, "corpus.json"));
}, 120_000);

afterAll(async () => {
  await browser?.close();
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

describe("the run corpus records the shaping inputs that disable ligatures (DM-1983)", () => {
  it("harvests the runs at all — the non-vacuity floor", () => {
    // Without this, every assertion below would pass on an extractor that
    // harvested nothing.
    expect(corpus.runs.length).toBeGreaterThan(0);
    for (const w of WORDS) expect(forWord(w).length).toBeGreaterThan(0);
  });

  it("records letter-spacing, text-rendering and font-variant-ligatures on every run", () => {
    for (const r of corpus.runs) {
      expect(r.letterSpacing, `letterSpacing missing on "${r.text}"`).toBeDefined();
      expect(r.textRendering, `textRendering missing on "${r.text}"`).toBeDefined();
      expect(r.fontVariantLigatures, `fontVariantLigatures missing on "${r.text}"`).toBeDefined();
    }
  });

  it("keeps the four variants of a word DISTINCT rather than deduping them", () => {
    // The assertion that carries the weight. The four rows differ in nothing a
    // pre-DM-1983 spec recorded — same text, family, size, weight, style, axes,
    // stretch and feature settings — so before these fields existed they were
    // ONE run, and three quarters of this fixture would have been swept as a
    // duplicate of the first.
    for (const w of WORDS) {
      const variants = forWord(w).map((r) =>
        `${r.letterSpacing}|${r.textRendering}|${r.fontVariantLigatures}`);
      expect(new Set(variants).size, `"${w}" collapsed to ${variants.join(" , ")}`).toBe(4);
    }
  });

  it("carries the specific values the vetoes read", () => {
    const all = corpus.runs;
    expect(all.some((r) => r.letterSpacing === "2px" && r.fontVariantLigatures === "normal")).toBe(true);
    // Chrome serializes this computed keyword ALL-LOWERCASE, not as the CSS
    // spelling `optimizeSpeed`. Asserted literally because an exact match
    // against the spec spelling is what silently failed to fire when the
    // renderer first modeled this.
    expect(all.some((r) => r.textRendering === "optimizespeed")).toBe(true);
    // The keyword-outranked pair: letter-spacing AND an explicit enable.
    expect(all.some((r) => r.letterSpacing === "2px" && r.fontVariantLigatures === "common-ligatures")).toBe(true);
    // …and the plain control, so a change that stamped a veto on everything
    // would fail here rather than look like coverage.
    expect(all.some((r) => r.letterSpacing === "normal" && r.textRendering === "auto")).toBe(true);
  });
});

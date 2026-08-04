/**
 * The shaping oracle's run corpus must not contain a run it cannot sweep
 * faithfully (docs/108).
 *
 * `chromeShaping` synthesizes its probe page with `setContent` and re-declares
 * only the run's font PROPERTIES — no `@font-face` rule travels with it. So a
 * run whose fixture resolved its family through `@font-face` gets shaped on the
 * probe page by whatever the stack falls through to, and our side falls through
 * as well. The two then agree about a font the fixture never painted, which
 * reads as coverage while measuring nothing.
 *
 * Measured on the fixture corpus's own `@font-face` file (rules that are
 * `src: local(...)` only): the page paints Georgia and Menlo, the probe page
 * paints Times and Courier, and the runs scored 28 agree-exact / 4 agree-count.
 *
 * The extractor therefore drops those nodes. This pins that, and pins it
 * NON-VACUOUSLY: the control fixture is identical except that it declares no
 * `@font-face`, and its run must still be harvested. A test that only asserted
 * the absence would also pass if the extractor stopped harvesting the family
 * for some unrelated reason, or harvested nothing at all.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractRuns, type RunCorpus } from "../tools/shaping-conformance.js";

/**
 * One word, no whitespace, so the corpus's whitespace-free rule keeps it and
 * this test measures the `@font-face` exclusion rather than that filter.
 */
const WORD = "Hamburgefonstiv";
const FAMILY = "ProbeAliasFamily";

const body = (fontFaceRule: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title><style>
${fontFaceRule}
.probe { font-family: "${FAMILY}", serif; font-size: 20px; }
</style></head><body><p class="probe">${WORD}</p></body></html>`;

/** `src: local(...)` keeps the fixture self-contained — no font bytes needed. */
const FONT_FACE_RULE = `@font-face { font-family: "${FAMILY}"; src: local("Georgia"), local("Times New Roman"); }`;

let browser: Browser;
let dir = "";
let aliased: RunCorpus;
let control: RunCorpus;

const namesFamily = (c: RunCorpus): boolean =>
  c.runs.some((r) => r.fontFamily.toLowerCase().includes(FAMILY.toLowerCase()));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "shaping-fontface-"));
  const aliasedDir = join(dir, "aliased");
  const controlDir = join(dir, "control");
  mkdirSync(aliasedDir);
  mkdirSync(controlDir);
  writeFileSync(join(aliasedDir, "f.html"), body(FONT_FACE_RULE));
  writeFileSync(join(controlDir, "f.html"), body(""));

  browser = await chromium.launch();
  aliased = await extractRuns(browser, [aliasedDir], join(dir, "aliased.json"));
  control = await extractRuns(browser, [controlDir], join(dir, "control.json"));
}, 120_000);

afterAll(async () => {
  await browser?.close();
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

describe("the run corpus excludes @font-face-resolved families", () => {
  it("harvests the run when the family is NOT declared by @font-face", () => {
    // The non-vacuity control. Without this, an extractor that harvested
    // nothing — or that had simply stopped seeing this family — would pass the
    // exclusion assertion below for entirely the wrong reason.
    expect(control.runs.length).toBeGreaterThan(0);
    expect(namesFamily(control)).toBe(true);
    expect(control.runs.some((r) => r.text === WORD)).toBe(true);
  });

  it("drops the identical run once an @font-face declares that family", () => {
    expect(namesFamily(aliased)).toBe(false);
    expect(aliased.runs.some((r) => r.text === WORD)).toBe(false);
  });

  it("differs from the control ONLY by the excluded family", () => {
    // The exclusion must be surgical: it drops the nodes whose family came from
    // `@font-face` and leaves everything else the fixture renders alone. The two
    // documents are byte-identical apart from the rule, so any other difference
    // would mean the guard is over-reaching.
    const others = (c: RunCorpus): string[] =>
      c.runs.filter((r) => !r.fontFamily.toLowerCase().includes(FAMILY.toLowerCase()))
        .map((r) => `${r.text}|${r.fontFamily}`).sort();
    expect(others(aliased)).toEqual(others(control));
  });
});

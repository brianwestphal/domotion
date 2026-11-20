import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser, Page } from "@playwright/test";
import { __pickWebfontVariantMetaForTest, resolveFont } from "@domotion/text-engine/testing";
import { launchChromium } from "../src/capture/index.js";
import { clearWebfonts, registerWebfont } from "../src/render/font-resolution.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// When several @font-face capability groups tie for a request, Chrome keeps the
// group whose key comes first in FontFaceCache's HashTable bucket order
// (core/css/font_face_cache.cc:227-258, Chromium 7d859f27). The groups below
// share one font file and differ only in `size-adjust`, so the painted width
// says which group Chrome chose.
const mono = readFileSync(
  new URL("../packages/text-engine/assets/fonts/fixture/DomotionFixtureMono-Regular.ttf", import.meta.url),
).toString("base64");

type Range = [number, number];
interface Group {
  width: Range;
  slope: Range;
  weight: Range;
}

/** Deterministic tie configurations: every group contains the request
 *  (weight 400, width 100%, slope 0), so all distances are 0. Six groups take
 *  the table past its first growth from 8 to 16 buckets. */
function generatedCases(count: number, seed: number): Group[][] {
  let state = seed;
  const next = (n: number) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state % n;
  };
  const cases: Group[][] = [];
  while (cases.length < count) {
    const size = 2 + next(5);
    const seen = new Set<string>();
    const groups: Group[] = [];
    while (groups.length < size) {
      const group: Group = {
        width: [[50, 75, 100][next(3)], [100, 125, 200][next(3)]],
        slope: [[0, -5, -20][next(3)], [0, 5, 20][next(3)]],
        weight: [100 + 10 * next(31), 400 + 10 * next(51)],
      };
      const key = JSON.stringify(group);
      if (seen.has(key)) continue;
      seen.add(key);
      groups.push(group);
    }
    cases.push(groups);
  }
  return cases;
}

const descriptors = (g: Group) =>
  `font-weight:${g.weight[0]} ${g.weight[1]};font-stretch:${g.width[0]}% ${g.width[1]}%;font-style:${
    g.slope[0] === 0 && g.slope[1] === 0 ? "normal" : `oblique ${g.slope[0]}deg ${g.slope[1]}deg`
  }`;

async function nativeIndex(page: Page, groups: Group[]): Promise<number> {
  const css = groups
    .map(
      (g, i) =>
        `@font-face{font-family:T;src:url(data:font/ttf;base64,${mono});${descriptors(g)};size-adjust:${100 + 10 * i}%}`,
    )
    .join("");
  await page.setContent(
    `<style>${css} #t{font:400 40px T;font-stretch:100%;font-style:normal;white-space:pre}</style><span id="t">iiiiiiiiii</span>`,
  );
  await page.evaluate(() => document.fonts.load("400 40px T", "i"));
  await page.evaluate(() => document.fonts.ready);
  const width = await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("t")!);
    return range.getBoundingClientRect().width;
  });
  // JetBrains Mono advances 0.6 em: ten glyphs at 40px are 240px at 100%.
  const index = (width / 240 - 1) * 10;
  expect(Math.abs(index - Math.round(index))).toBeLessThan(0.01);
  return Math.round(index);
}

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => {
  clearWebfonts();
  await closeBrowserSafely(browser);
});

it("selects tied capability groups in Chrome's FontFaceCache bucket order", async () => {
  const page = await browser.newPage();
  const cases = generatedCases(24, 0x5eed);
  const rows: { groups: number; native: number; engine: number; primary: number | undefined }[] = [];
  try {
    for (const [caseIndex, groups] of cases.entries()) {
      const native = await nativeIndex(page, groups);
      clearWebfonts();
      const family = `Tie ${caseIndex}`;
      for (const g of groups) {
        const style = g.slope[0] === 0 && g.slope[1] === 0 ? "normal" : `oblique ${g.slope[0]}deg ${g.slope[1]}deg`;
        expect(
          registerWebfont(
            family,
            g.weight[0],
            style,
            Buffer.from(mono, "base64"),
            undefined,
            `${g.width[0]}% ${g.width[1]}%`,
            `${g.weight[0]} ${g.weight[1]}`,
            style,
          ),
        ).toBe(true);
      }
      const engine = __pickWebfontVariantMetaForTest(family, 400, false)?.declarationIndex ?? -1;
      // The shipped primary-font path materializes the same declaration.
      const primary = resolveFont(`"${family}"`, 400, 40, 0)?.webfontDeclarationOrder;
      rows.push({ groups: groups.length, native, engine, primary });
    }
  } finally {
    clearWebfonts();
    await page.close();
  }
  console.log("Webfont tie-order native witness:", JSON.stringify({ platform: process.platform, rows }));
  expect(rows.filter((row) => row.engine !== row.native)).toEqual([]);
  expect(rows.filter((row) => row.primary !== row.native)).toEqual([]);
  // Negative control: the sample must contain ties that neither source-order
  // rule explains, or it could not tell bucket order from either of them.
  expect(rows.some((row) => row.native !== 0)).toBe(true);
  expect(rows.some((row) => row.native !== row.groups - 1)).toBe(true);
  expect(rows.filter((row) => row.native === 0 || row.native === row.groups - 1).length).toBeLessThan(rows.length);
});

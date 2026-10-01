// Rasterize an SVG via Playwright to compare to the test runner output
import { readFileSync } from "node:fs";
import { withBrowser } from "./lib/browser.js";
import { isMain, parseCommand, runMain } from "./lib/cli.js";

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { positionals } = parseCommand(argv, {});
  if (positionals.length !== 2) throw new Error("usage: rasterize-svg.ts <input.svg> <output.png>");
  const [svgPath, outPath] = positionals;
  const svg = readFileSync(svgPath, "utf8");
  const m = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  const w = m ? parseInt(m[1]) : 1280;
  const h = m ? parseInt(m[2]) : 6000;

  await withBrowser(async (browser) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff">${svg}</body></html>`);
    await page.waitForTimeout(500);
    await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: w, height: h } });
    console.log("wrote", outPath);
  });
}

if (isMain(import.meta.url)) await runMain(() => main());

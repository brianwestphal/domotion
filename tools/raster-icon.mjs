import { readFileSync, writeFileSync } from "node:fs";
import { withBrowser } from "./lib/browser.mjs";
import { isMain, parseCommand, runMain } from "./lib/cli.mjs";

async function main(argv) {
  const { positionals } = parseCommand(argv, {});
  if (positionals.length > 0) throw new Error("unexpected positional arguments");
  try {
    const svg = readFileSync("tests/output/real-world/resend-mobile-entire-page.svg", "utf8");
    await withBrowser(async (browser) => {
      const page = await browser.newPage({ viewport: { width: 390, height: 6000 } });
      await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`);
      // Full icon column region: x 40..110, y 3620..4420
      const buf = await page.screenshot({ clip: { x: 40, y: 3620, width: 120, height: 800 } });
      writeFileSync("tests/output/raster-icon-column.png", buf);
      console.log("wrote raster-icon-column.png");
    });
    return 0;
  } catch (error) {
    console.error(error);
    return 1;
  }
}

if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));

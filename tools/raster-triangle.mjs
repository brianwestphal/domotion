import { readFileSync, writeFileSync } from "node:fs";
import { withBrowser } from "./lib/browser.mjs";
import { isMain, parseCommand, runMain } from "./lib/cli.mjs";

async function main(argv) {
  const { positionals } = parseCommand(argv, {});
  if (positionals.length > 0) throw new Error("unexpected positional arguments");
  try {
    const block = readFileSync("tests/output/triangle-block.txt", "utf8");
    // Wrap in a minimal svg, shifting the icon to origin for a tight 24x24 view.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="55 3638 24 24" width="240" height="240">${block}</svg>`;
    await withBrowser(async (browser) => {
      const page = await browser.newPage({ viewport: { width: 240, height: 240 } });
      await page.setContent(`<!doctype html><html><body style="margin:0;background:#0b0e14">${svg}</body></html>`);
      writeFileSync("tests/output/triangle-isolated.png", await page.screenshot());
      console.log("wrote triangle-isolated.png");
    });
    return 0;
  } catch (error) {
    console.error(error);
    return 1;
  }
}

if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));

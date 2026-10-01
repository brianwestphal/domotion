import { resolve } from "node:path";
import { withBrowser } from "./lib/browser.mjs";
import { isMain, parseCommand, runMain } from "./lib/cli.mjs";

async function main(argv) {
  const { positionals } = parseCommand(argv, {});
  if (positionals.length > 0) throw new Error("unexpected positional arguments");
  try {
    const url =
      "file://" + resolve("/Users/westphal/Documents/domotion/external/html-test/24-deep-initial-letter.html");
    await withBrowser(async (browser) => {
      const page = await (await browser.newContext({ viewport: { width: 1024, height: 1800 } })).newPage();
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      // Screenshot then sample pixel inside the W glyph at .drop-5.
      const buf = await page.screenshot({ omitBackground: false });
      import("node:fs").then((fs) => fs.writeFileSync("/tmp/claude/chrome-paint.png", buf));
      // Get the rect of the W glyph.
      const wEl = await page.$(".drop-5 p:first-of-type");
      const r = await wEl.boundingBox();
      console.log("drop-5 p rect:", r);
    });
    return 0;
  } catch (error) {
    console.error(error);
    return 1;
  }
}

if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));

// DM-1093 byte oracle: capture a tree with styled ::first-letter (font/color/
// background/border) and an `initial-letter` drop-cap — exercises
// buildFirstLetterSegment incl. the cap-height equalisation path.
import { chromium } from "@playwright/test";
import { captureElementTree } from "/Users/westphal/Documents/domotion/dist/capture/index.js";
import { createHash } from "node:crypto";
const html = `<!doctype html><meta charset=utf8><style>
p { font: 20px/1.4 serif; width: 360px; }
.a::first-letter { color: #c30; font-weight: bold; font-size: 200%; background: #ffd; border: 1px solid #333; padding: 2px; }
.drop::first-letter { -webkit-initial-letter: 3; initial-letter: 3; color: #069; font-weight: bold; }
.b::first-letter { color: green; font-style: italic; }
</style><body style="margin:0">
<p class=a>Alpha first letter styled with a box.</p>
<p class=drop>Drop cap paragraph spanning a few lines so the initial-letter sizing matters here.</p>
<p class=b>Green italic first letter here.</p>
</body>`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 420, height: 360 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.setContent(html, { waitUntil: "networkidle" });
const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 420, height: 360 });
console.log(createHash("sha256").update(JSON.stringify(tree)).digest("hex"));
await browser.close();

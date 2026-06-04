// DM-1086 byte oracle: capture a tree with @counter-style custom markers (which
// exercise the counter-style pre-walk + resolver) and hash it.
import { chromium } from "@playwright/test";
import { captureElementTree } from "/Users/westphal/Documents/domotion/dist/capture/index.js";
import { createHash } from "node:crypto";
const html = `<!doctype html><meta charset=utf8><style>
@counter-style circled { system: fixed; symbols: "①" "②" "③" "④"; suffix: " "; }
@counter-style myroman { system: additive; additive-symbols: 10 "X", 9 "IX", 5 "V", 4 "IV", 1 "I"; }
@counter-style dashed { system: cyclic; symbols: "–"; suffix: " "; negative: "(" ")"; pad: 2 "0"; range: 1 5; }
ol.a { list-style-type: circled; } ol.b { list-style-type: myroman; } ol.c { list-style-type: dashed; }
</style><body style="margin:0;font-size:18px">
<ol class=a><li>one</li><li>two</li></ol>
<ol class=b><li>seven</li><li>fourteen</li></ol>
<ol class=c><li>x</li><li>y</li></ol>
</body>`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 400, height: 400 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.setContent(html, { waitUntil: "networkidle" });
const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 400, height: 400 });
console.log(createHash("sha256").update(JSON.stringify(tree)).digest("hex"));
await browser.close();

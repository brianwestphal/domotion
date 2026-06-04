// DM-1088 byte oracle: capture a tree with ::before/::after content (quoted,
// attr(), counter()/counters() incl. custom @counter-style, quotes, url, and
// an empty-content decorative box) — exercises parsePseudoContent + the
// empty-content branch.
import { chromium } from "@playwright/test";
import { captureElementTree } from "/Users/westphal/Documents/domotion/dist/capture/index.js";
import { createHash } from "node:crypto";
const html = `<!doctype html><meta charset=utf8><style>
@counter-style prefixed { system: numeric; symbols: "0" "1" "2" "3" "4" "5" "6" "7" "8" "9"; prefix: "Step "; suffix: ": "; pad: 2 "0"; }
ol { counter-reset: step; } li { counter-increment: step; }
li::before { content: counter(step, prefixed); color: #07a; }
.lbl::after { content: " (" attr(data-tag) ")"; color: green; }
q::before { content: open-quote; } q::after { content: close-quote; }
.ico::before { content: ""; display: inline-block; width: 12px; height: 0; border-bottom: 2px solid #c12; }
.sep::after { content: ""; display: block; height: 6px; background: linear-gradient(90deg,#f00,#00f); }
</style><body style="margin:0;font-size:16px">
<ol><li>alpha</li><li>beta</li></ol>
<p class=lbl data-tag="v2">Release</p>
<p><q>quoted text</q></p>
<span class=ico>hairline</span><div class=sep>section</div>
</body>`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 400, height: 360 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.setContent(html, { waitUntil: "networkidle" });
const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 400, height: 360 });
console.log(createHash("sha256").update(JSON.stringify(tree)).digest("hex"));
await browser.close();

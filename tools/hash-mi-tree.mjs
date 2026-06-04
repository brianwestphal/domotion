// DM-1087 byte oracle: capture a tree with MathML <mi> single-token elements
// (which exercise mathItalicChar) and hash it, to verify the hoist is byte-neutral.
import { chromium } from "@playwright/test";
import { captureElementTree } from "/Users/westphal/Documents/domotion/dist/capture/index.js";
import { createHash } from "node:crypto";
const html = `<!doctype html><meta charset=utf8><body style="margin:0;font-size:24px">
<math><mrow><mi>a</mi><mo>+</mo><mi>x</mi><mo>=</mo><mi>h</mi><mi>α</mi><mi>ϑ</mi><mi>∇</mi></mrow></math>
<p style="font-size:40px">Drop cap paragraph with a styled <span style="font-weight:bold">first</span> word.</p>
</body>`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 600, height: 300 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.setContent(html, { waitUntil: "networkidle" });
const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 600, height: 300 });
console.log(createHash("sha256").update(JSON.stringify(tree)).digest("hex"));
await browser.close();

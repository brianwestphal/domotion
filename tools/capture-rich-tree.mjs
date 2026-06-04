// DM-1085 byte oracle: capture one rich tree exercising the renderElement phases
// (border-radius, clip-path geo-box, overflow clip, mask, 2D transform, opacity,
// filter, blend) so elementTreeToSvg output can be hashed before/after an
// extraction. Writes the tree JSON to /tmp for the hash probe.
import { chromium } from "@playwright/test";
import { captureElementTree } from "/Users/westphal/Documents/domotion/dist/capture/index.js";
import { writeFileSync } from "node:fs";
const html = `<!doctype html><meta charset=utf8><body style="margin:0">
<div style="position:relative;width:400px;height:300px;background:#eee;padding:20px">
  <div style="width:120px;height:80px;background:linear-gradient(45deg,#f00,#00f);border-radius:10px 30px 50px 70px;border:4px solid #333;padding:8px"></div>
  <div style="width:100px;height:100px;background:#3a3;clip-path:circle(40% at center);transform:rotate(20deg) scale(1.1);opacity:0.8;margin-top:10px"></div>
  <div style="width:90px;height:90px;background:#06c;clip-path:inset(10px 20px content-box);filter:blur(1px);mix-blend-mode:multiply"></div>
  <div style="width:80px;height:60px;overflow:hidden;border-radius:12px;background:#fc0"><div style="width:300px;height:200px;background:#909"></div></div>
  <svg width="0" height="0"><defs><clipPath id="cp1"><path d="M0,0 L50,0 L25,50 Z"/></clipPath></defs></svg>
  <div style="width:70px;height:70px;background:#0aa;clip-path:url(#cp1)"></div>
</div></body>`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.setContent(html, { waitUntil: "networkidle" });
const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 800, height: 600 });
writeFileSync("/tmp/claude/dm1085-tree.json", JSON.stringify(tree));
console.log("captured tree elements:", Array.isArray(tree) ? tree.length : "?");
await browser.close();

/* eslint-disable */
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureElementTree } from "../src/capture/index.js";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  await context.routeFromHAR(resolve(CACHE_DIR, "stripe-mobile.har"), { url: "**/*", update: false, notFound: "fallback" });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  await page.goto("https://stripe.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const rawHeight = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
  const canvasH = Math.min(6000, Math.max(844, rawHeight));
  await page.setViewportSize({ width: 390, height: canvasH });
  await page.waitForTimeout(400);
  await page.evaluate(async (h) => { window.scrollTo(0, h); await new Promise((r) => setTimeout(r, 400)); window.scrollTo(0, 0); }, canvasH);
  await page.waitForTimeout(1800);

  await page.evaluate(() => {
    try {
      if (typeof document.getAnimations === "function") {
        for (const a of document.getAnimations()) { try { a.pause(); } catch {} }
      }
    } catch {}
  });

  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 390, height: canvasH });

  // Walk to find elements with the payment-button class and payment-methods-item class
  const found: any[] = [];
  const walk = (el: any, depth: number, path: string) => {
    const cls = el.className ?? "";
    const seg = el.tag + (cls ? "." + cls.split(/\s+/).slice(0, 1).join('.') : "");
    const p = path ? path + " > " + seg : seg;
    const t = el.styles?.transform || '';
    const txt = el.text || '';
    const hasInterestingTransform = /^matrix\(1,?\s*0,?\s*0,?\s*1,?\s*0,?\s*-?(?:6[0-9]|13[0-9]|16[0-9])\.?\d*\)$/.test(t) || /matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*-?\d+\)/.test(t);
    if (hasInterestingTransform || /^(Continue|Affirm|Card|Cash App|Crypto|US bank account)/i.test(txt.trim())) {
      found.push({
        depth,
        path: p.slice(-200),
        rect: { x: el.x, y: el.y, w: el.width, h: el.height },
        transform: el.styles?.transform,
        transformOrigin: el.styles?.transformOrigin,
        position: el.styles?.position,
        display: el.styles?.display,
        text: (el.text || '').slice(0, 30),
        childCount: Array.isArray(el.children) ? el.children.length : 0,
      });
    }
    if (Array.isArray(el.children)) for (const c of el.children) walk(c, depth + 1, p);
  };
  for (const r of tree) walk(r, 0, "");

  for (const f of found) console.log(JSON.stringify(f));
  console.log("---total:", found.length);
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });

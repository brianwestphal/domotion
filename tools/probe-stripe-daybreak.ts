/**
 * Investigate why "Daybreak Yoga" text isn't in our SVG for the
 * stripe-mobile-entire-page fixture. Walks the live DOM and reports the
 * ancestor chain for the Daybreak Yoga text node, with a special focus on
 * iframes and shadow roots that our captureElementTree may not traverse.
 */
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureElementTree } from "../src/capture/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(HERE, "../tests/cache/real-world");

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  await context.routeFromHAR(resolve(CACHE_DIR, "stripe-mobile.har"), {
    url: "**/*",
    update: false,
    notFound: "fallback",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  await page.goto("https://stripe.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const rawH = await page.evaluate(() =>
    Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
  );
  const canvasH = Math.min(6000, Math.max(844, rawH));
  await page.setViewportSize({ width: 390, height: canvasH });
  await page.waitForTimeout(400);
  await page.evaluate(async (h) => {
    window.scrollTo(0, h);
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
  }, canvasH);
  await page.waitForTimeout(1800);

  // (a) Is the text present in the top document at all?
  const top = await page.evaluate(() => {
    const all = document.querySelectorAll("*");
    let hit: Element | null = null;
    for (const el of all) {
      const t = (el.textContent ?? "").trim();
      if (t === "Daybreak Yoga") { hit = el; break; }
    }
    return {
      foundInTop: hit != null,
      iframeCount: document.querySelectorAll("iframe").length,
    };
  });
  console.log("TOP DOC:", top);

  // (b) Iframes: list their src, isSameOrigin, and whether any contain Daybreak text.
  const iframes = page.frames();
  console.log(`\nALL FRAMES (${iframes.length}):`);
  for (const fr of iframes) {
    const url = fr.url();
    let found = false;
    try {
      found = await fr.evaluate(() => document.body && /Daybreak Yoga/.test(document.body.innerText));
    } catch (e) {
      // cross-origin frame
    }
    const sameOrigin = url.startsWith("https://stripe.com") || url === "about:blank" || url.startsWith("about:");
    console.log(`  url=${url.slice(0, 100)} sameOrigin=${sameOrigin} containsDaybreak=${found}`);
  }

  // (c) For each element in the top doc whose text is exactly "Daybreak Yoga",
  // dump rect + computed-style ancestor chain.
  const chain = await page.evaluate(() => {
    const out: any[] = [];
    const all = document.querySelectorAll("*");
    let target: Element | null = null;
    for (const el of all) {
      if ((el.textContent ?? "").trim() === "Daybreak Yoga") { target = el; break; }
    }
    if (target == null) return { found: false, chain: [] };
    const path: any[] = [];
    let cur: Element | null = target;
    let depth = 0;
    while (cur != null && depth < 30) {
      const r = cur.getBoundingClientRect();
      const cs = getComputedStyle(cur);
      path.push({
        depth,
        tag: cur.nodeName.toLowerCase(),
        cls: (cur as HTMLElement).className || "",
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        display: cs.display,
        visibility: cs.visibility,
        opacity: cs.opacity,
        overflow: cs.overflow,
        clipPath: cs.clipPath === "none" ? null : cs.clipPath,
        position: cs.position,
        transform: cs.transform === "none" ? null : cs.transform,
        innerText0_40: ((cur as HTMLElement).innerText || "").slice(0, 40),
      });
      cur = cur.parentElement;
      depth++;
    }
    return { found: true, chain: path };
  });
  console.log("\nDAYBREAK YOGA ELEMENT CHAIN (LIVE DOM):");
  console.log(JSON.stringify(chain, null, 2).split("\n").slice(0, 60).join("\n"));

  // Run our actual captureElementTree pass and search the result for "Daybreak Yoga".
  console.log("\n=== Running captureElementTree on the page ===");
  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 390, height: canvasH });
  let foundDaybreakInCapture = false;
  let foundDaybreakRect: any = null;
  function walk(el: any) {
    if (el.text === "Daybreak Yoga" || (Array.isArray(el.textSegments) && el.textSegments.some((s: any) => s.text === "Daybreak Yoga"))) {
      foundDaybreakInCapture = true;
      foundDaybreakRect = { x: el.x, y: el.y, w: el.width, h: el.height };
    }
    if (Array.isArray(el.children)) for (const c of el.children) walk(c);
  }
  for (const root of tree) walk(root);
  console.log(`captureElementTree found "Daybreak Yoga": ${foundDaybreakInCapture}`);
  if (foundDaybreakInCapture) console.log(`  rect:`, foundDaybreakRect);

  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });

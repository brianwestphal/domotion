/**
 * Investigate the multi-language-variant hypothesis for DM-587.
 *
 * The earlier probe at REGION [1] (260,1077,126,225) revealed that the
 * captured tree contains both English "Card" (x=328) and German "Karte"
 * (x=360) at the same y row inside a payment-method grid. In Chrome's
 * expected.png only one language variant is visible per row — so the live
 * DOM must clip the alternates via overflow:hidden somewhere up the tree.
 *
 * This probe lists the overflow / clip-path / mask values of every ancestor
 * of the visible "Card" element so we can see exactly which ancestor does
 * the clipping in Chrome, and decide whether our renderer respects that
 * property.
 */
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");

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
  page.setDefaultNavigationTimeout(90_000);
  await page.goto("https://stripe.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const rawHeight = await page.evaluate(() =>
    Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
  );
  const canvasH = Math.min(6000, Math.max(844, rawHeight));
  await page.setViewportSize({ width: 390, height: canvasH });
  await page.waitForTimeout(400);
  await page.evaluate(async (h) => {
    window.scrollTo(0, h);
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
  }, canvasH);
  await page.waitForTimeout(1800);

  // Find the "Card" payment-method label (English variant).
  const trace = await page.evaluate(() => {
    const all = document.querySelectorAll("*");
    let target: Element | null = null;
    let karte: Element | null = null;
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const txt = (el.textContent ?? "").trim();
      if (target == null && txt === "Card") target = el;
      if (karte == null && txt === "Karte") karte = el;
      if (target != null && karte != null) break;
    }
    if (target == null) return { found: false, path: [] as any[] };
    const path: any[] = [];
    let cur: Element | null = target;
    let depth = 0;
    while (cur != null && depth < 50) {
      const r = cur.getBoundingClientRect();
      const cs = getComputedStyle(cur);
      const seg: any = {
        depth,
        tag: cur.nodeName.toLowerCase(),
        cls: (cur as HTMLElement).className || "",
        id: (cur as HTMLElement).id || "",
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        overflow: cs.overflow,
        overflowX: cs.overflowX,
        overflowY: cs.overflowY,
        clipPath: cs.clipPath === "none" ? null : cs.clipPath,
        mask: cs.mask === "none" ? null : cs.mask,
        position: cs.position,
        display: cs.display,
        transform: cs.transform === "none" ? null : cs.transform,
        zIndex: cs.zIndex,
      };
      path.push(seg);
      cur = cur.parentElement;
      depth++;
    }
    const karteRect = karte ? karte.getBoundingClientRect() : null;
    const cardRect = target.getBoundingClientRect();
    return {
      found: true,
      cardRect: cardRect ? { x: Math.round(cardRect.left), y: Math.round(cardRect.top), w: Math.round(cardRect.width), h: Math.round(cardRect.height) } : null,
      karteRect: karteRect ? { x: Math.round(karteRect.left), y: Math.round(karteRect.top), w: Math.round(karteRect.width), h: Math.round(karteRect.height) } : null,
      path,
    };
  });

  console.log(JSON.stringify(trace, null, 2));

  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });

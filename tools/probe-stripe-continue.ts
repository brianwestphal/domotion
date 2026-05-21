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

  // Inline all logic — no helper declarations to avoid esbuild __name injection.
  const result = await page.evaluate(() => {
    const container = document.querySelector('.payments-graphic__checkout-payment-methods');
    const out: any = { container: null, children: [], descendants: [], continueElement: null };

    if (container) {
      const r = container.getBoundingClientRect();
      const cs = getComputedStyle(container);
      out.container = {
        cls: (container as HTMLElement).className,
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        display: cs.display,
        position: cs.position,
        gridTemplateRows: cs.gridTemplateRows,
        gridTemplateColumns: cs.gridTemplateColumns,
        flexDirection: cs.flexDirection,
        transform: cs.transform === "none" ? null : cs.transform,
      };
      // Children: enumerate direct children with their layout info
      for (const c of Array.from(container.children)) {
        const cr = c.getBoundingClientRect();
        const ccs = getComputedStyle(c);
        out.children.push({
          tag: c.nodeName.toLowerCase(),
          cls: (c as HTMLElement).className.slice(0, 80),
          rect: { x: Math.round(cr.left), y: Math.round(cr.top), w: Math.round(cr.width), h: Math.round(cr.height) },
          display: ccs.display,
          position: ccs.position,
          order: ccs.order,
          gridRow: ccs.gridRow,
          gridColumn: ccs.gridColumn,
          transform: ccs.transform === "none" ? null : ccs.transform,
          text: (c.textContent || "").trim().slice(0, 60),
        });
      }
    }

    // Find Continue button anywhere on page
    const all = document.querySelectorAll('*');
    for (const el of all) {
      const txt = (el.textContent || "").trim();
      const cls = (el as HTMLElement).className || "";
      if (typeof cls !== 'string') continue;
      if (cls.includes('payments-graphic__checkout-button') || cls.includes('checkout-payment-button')) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        // Walk ancestors
        const ancestors: any[] = [];
        let cur: Element | null = el;
        let d = 0;
        while (cur && d < 10) {
          const ar = cur.getBoundingClientRect();
          const acs = getComputedStyle(cur);
          ancestors.push({
            depth: d,
            tag: cur.nodeName.toLowerCase(),
            cls: ((cur as HTMLElement).className || "").slice(0, 60),
            rect: { x: Math.round(ar.left), y: Math.round(ar.top), w: Math.round(ar.width), h: Math.round(ar.height) },
            display: acs.display,
            position: acs.position,
            transform: acs.transform === "none" ? null : acs.transform,
            order: acs.order,
            gridRow: acs.gridRow,
          });
          cur = cur.parentElement;
          d++;
        }
        out.continueElement = {
          cls: cls.slice(0, 80),
          rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
          display: cs.display,
          position: cs.position,
          text: txt.slice(0, 60),
          ancestors,
        };
        break;
      }
    }
    return out;
  });

  console.log(JSON.stringify(result, null, 2));
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });

import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
  });
  await context.routeFromHAR(resolve(CACHE_DIR, "framer-desktop.har"), { url: "**/*", update: false, notFound: "fallback" });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.goto("https://www.framer.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // Region [3] is (922, 3868, 312, 66) — the toolbar at y ≈ 3868 inside canvas-mockup
  // First, scroll to that region so it actually paints (lazy-loaded sections).
  await page.evaluate(() => window.scrollTo(0, 3500));
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);

  const result = await page.evaluate(() => {
    const out: any = {};

    // 1. Find all elements that look like the toolbar: framer-17fh9ce or similar
    const toolbars = document.querySelectorAll('[class*="framer-17fh9ce"]');
    out.toolbarCount = toolbars.length;

    // 2. Find all <use href="#..."> that point at icon-like ids
    const uses = document.querySelectorAll('use');
    const sampleUses: any[] = [];
    for (let i = 0; i < uses.length && sampleUses.length < 12; i++) {
      const u = uses[i];
      const href = u.getAttribute('href') || u.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
      if (!href.startsWith('#')) continue;
      const targetId = href.slice(1);
      const target = document.getElementById(targetId);
      const r = u.getBoundingClientRect();
      sampleUses.push({
        href,
        useRect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        useParent: u.parentElement?.tagName + '.' + (u.parentElement?.className?.toString?.().slice(0, 30) ?? ''),
        targetExists: target != null,
        targetTag: target?.tagName,
        targetNS: target?.namespaceURI,
        targetViewBox: target?.getAttribute?.('viewBox'),
        targetChildCount: target?.children?.length,
        targetFirstChildTag: target?.firstElementChild?.tagName,
        targetOuterStart: target?.outerHTML?.slice(0, 200),
      });
    }
    out.totalUses = uses.length;
    out.sampleUses = sampleUses;

    // 3. Look at the toolbar region specifically (y around 3868)
    const region = document.elementsFromPoint(1000, 850); // viewport coord (3868 - scrollY)
    // Actually we need scrollY to know what's at the painted region. Let's just find
    // toolbars by class pattern that contains svg+use
    const svgContainers = document.querySelectorAll('.svgContainer');
    out.svgContainerCount = svgContainers.length;
    const svgContainerSamples: any[] = [];
    for (let i = 0; i < svgContainers.length && svgContainerSamples.length < 6; i++) {
      const c = svgContainers[i];
      const r = c.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const svg = c.querySelector('svg');
      const use = svg?.querySelector('use');
      const href = use?.getAttribute('href') || '';
      const targetId = href.startsWith('#') ? href.slice(1) : '';
      const target = targetId ? document.getElementById(targetId) : null;
      svgContainerSamples.push({
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        svgOuter: svg?.outerHTML?.slice(0, 150),
        targetExists: target != null,
        targetTag: target?.tagName,
        targetViewBox: target?.getAttribute?.('viewBox'),
        targetWidth: target?.getAttribute?.('width'),
        targetHeight: target?.getAttribute?.('height'),
        targetOuterStart: target?.outerHTML?.slice(0, 250),
      });
    }
    out.svgContainerSamples = svgContainerSamples;

    return out;
  });

  console.log(JSON.stringify(result, null, 2));

  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });

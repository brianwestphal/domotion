import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureElementTree } from "../src/render/element-tree-to-svg.js";
import type { CapturedElement } from "../src/capture/types.js";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");

function walk(n: CapturedElement, pred: (n: CapturedElement) => boolean, out: CapturedElement[]) {
  if (pred(n)) out.push(n);
  for (const c of n.children ?? []) walk(c, pred, out);
}

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

  await page.setViewportSize({ width: 1280, height: 6000 });
  await page.waitForTimeout(400);

  // Same freeze pattern real-world.tsx applies
  await page.evaluate(() => {
    try { if (typeof document.getAnimations === "function") for (const a of document.getAnimations()) { try { a.pause(); } catch {} } } catch {}
  });

  // Capture the tree the test would capture
  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 1280, height: 6000 });

  // Find all captured svg elements and check their svgContent
  const svgs: CapturedElement[] = [];
  walk(tree[0]!, (n) => n.tag === 'svg', svgs);
  console.log(`Total captured <svg> elements: ${svgs.length}`);

  // Region [3] is (922, 3868, 312, 66) — find svgs near this region
  const svgsNearToolbar = svgs.filter((s) => {
    return s.x >= 800 && s.x <= 1280 && s.y >= 3800 && s.y <= 3950;
  });
  console.log(`\nSvgs near toolbar region (922, 3868, 312, 66): ${svgsNearToolbar.length}`);
  for (const s of svgsNearToolbar) {
    console.log(`  svg at (${Math.round(s.x)},${Math.round(s.y)},${Math.round(s.width)},${Math.round(s.height)})`);
    const sc = (s as any).svgContent as string | undefined;
    console.log(`    svgContent: ${sc ? sc.slice(0, 200) + '...' : 'NONE'}`);
    console.log(`    svgContent length: ${sc?.length ?? 0}`);
    console.log(`    has <use:`, sc?.includes('<use'));
    console.log(`    has <path:`, sc?.includes('<path'));
    console.log(`    children count:`, s.children?.length ?? 0);
  }

  // Also look at the actual DOM structure at this region
  const domStructure = await page.evaluate(() => {
    // Find toolbar
    const tb = document.querySelector('[class*="framer-17fh9ce"]');
    if (!tb) return { error: 'no toolbar' };
    const r = (tb as Element).getBoundingClientRect();
    // Get children that are svgContainers
    const containers = tb.querySelectorAll('.svgContainer');
    const out: any = { tbRect: { x: r.left, y: r.top, w: r.width, h: r.height }, containers: [] };
    for (let i = 0; i < containers.length && i < 6; i++) {
      const c = containers[i];
      const cr = c.getBoundingClientRect();
      const innerSvg = c.querySelector('svg');
      const isr = innerSvg?.getBoundingClientRect();
      out.containers.push({
        containerRect: cr.width === 0 ? null : { x: cr.left, y: cr.top, w: cr.width, h: cr.height },
        innerSvgRect: isr ? { x: isr.left, y: isr.top, w: isr.width, h: isr.height } : null,
        innerSvgOuter: innerSvg?.outerHTML.slice(0, 300),
        innerSvgParent: innerSvg?.parentElement?.outerHTML.slice(0, 200),
      });
    }
    return out;
  });
  console.log('\nDOM structure of toolbar:');
  console.log(JSON.stringify(domStructure, null, 2));

  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });

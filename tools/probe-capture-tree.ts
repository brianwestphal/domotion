/* eslint-disable */
// Runs the REAL capture function on a target page, then walks the captured
// tree to find elements in a region of interest. Outputs full captured
// state so we can see exactly what the walker produces (pseudoSegments,
// pseudoImages, pseudoBoxes, textSegments, etc.).
//
// Usage: tweak the SITE / VIEWPORT / TARGET_RECT constants below and run.
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureElementTree } from "../src/capture/index.js";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");

const SITE = process.argv[2] || "apple";
const VIEWPORT = process.argv[3] || "mobile";
const TARGET_X = parseFloat(process.argv[4] || "0");
const TARGET_Y = parseFloat(process.argv[5] || "0");
const TARGET_W = parseFloat(process.argv[6] || "390");
const TARGET_H = parseFloat(process.argv[7] || "844");

const HAR = resolve(CACHE_DIR, `${SITE}-${VIEWPORT}.har`);

const SITE_URLS: Record<string, string> = {
  apple: "https://www.apple.com/",
  framer: "https://www.framer.com/",
  google: "https://www.google.com/",
  nytimes: "https://www.nytimes.com/",
  resend: "https://resend.com/",
  slashdot: "https://slashdot.org/",
  stripe: "https://stripe.com/",
};

async function main() {
  const isMobile = VIEWPORT === "mobile";
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: isMobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    isMobile,
    userAgent: isMobile
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
      : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });
  await context.routeFromHAR(HAR, { url: "**/*", update: false, notFound: "abort" });
  const page = await context.newPage();
  await page.goto(SITE_URLS[SITE], { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3000);

  const vp = isMobile ? { x: 0, y: 0, width: 390, height: 844 } : { x: 0, y: 0, width: 1280, height: 800 };
  const tree = await captureElementTree(page, "body", vp);

  // Walk the tree and find elements whose rect intersects the target region.
  const intersects = (el: any): boolean => {
    if (!el || typeof el.x !== "number") return false;
    const left = el.x;
    const top = el.y;
    const right = left + (el.width || 0);
    const bot = top + (el.height || 0);
    return !(right < TARGET_X || left > TARGET_X + TARGET_W || bot < TARGET_Y || top > TARGET_Y + TARGET_H);
  };

  const hits: any[] = [];
  const walk = (el: any, depth: number): void => {
    if (intersects(el)) {
      const summary: any = {
        depth,
        tag: el.tag,
        x: el.x, y: el.y, w: el.width, h: el.height,
        text: el.text ? el.text.slice(0, 40) : undefined,
        textSegments: Array.isArray(el.textSegments) ? el.textSegments.map((s: any) => ({
          text: typeof s.text === "string" ? s.text.slice(0, 30) : "",
          textChars: typeof s.text === "string" ? s.text.split("").map((c: string) => "U+" + c.charCodeAt(0).toString(16)).join(" ") : "",
          x: s.x, y: s.y, w: s.width, h: s.height,
          fontFamily: s.fontFamily,
          fontSize: s.fontSize,
          color: s.color,
          rasterRect: s.rasterRect,
          rasterDataUri: s.rasterDataUri ? `${s.rasterDataUri.slice(0, 50)}...(${s.rasterDataUri.length}b)` : undefined,
        })) : undefined,
        pseudoImages: el.pseudoImages,
        pseudoBoxes: el.pseudoBoxes,
        imageSrc: el.imageSrc,
        replacedSnapshot: el.replacedSnapshot,
        bg: el.styles?.backgroundColor,
        inputXOffsets: el.inputXOffsets,
        isPlaceholderText: el.isPlaceholderText,
        textLeft: el.textLeft,
        textTop: el.textTop,
        elementRaster: el.elementRaster ? {
          x: el.elementRaster.x, y: el.elementRaster.y,
          width: el.elementRaster.width, height: el.elementRaster.height,
          dataUriBytes: el.elementRaster.dataUri ? el.elementRaster.dataUri.length : null,
        } : undefined,
      };
      // Drop noisy huge fields
      hits.push(summary);
    }
    if (el && Array.isArray(el.children)) {
      for (const c of el.children) walk(c, depth + 1);
    }
  };
  for (const root of tree) walk(root, 0);

  // Print one leaf element fully to see the real shape
  console.log("=== Sample leaf element (first text-bearing element) ===");
  const findLeaf = (el: any): any => {
    if (el?.text && el.text.length > 0) return el;
    for (const c of (el?.children ?? [])) {
      const r = findLeaf(c);
      if (r) return r;
    }
    return null;
  };
  const leaf = tree[0] ? findLeaf(tree[0]) : null;
  if (leaf) {
    const c = { ...leaf };
    delete (c as any).children;
    delete (c as any).styles;
    delete (c as any).textSegments;
    console.log(JSON.stringify(c, null, 2));
  }
  console.log("=== Root tree keys ===");
  if (tree[0]) console.log(Object.keys(tree[0]));
  console.log("=== Root tree[0] x/y/width/height ===");
  if (tree[0]) {
    const t = tree[0] as any;
    console.log(`x=${JSON.stringify(t.x)} y=${JSON.stringify(t.y)} w=${t.width} h=${t.height} children=${t.children?.length}`);
    // Print first 3 leaf-like children for shape inspection
    let scout = t.children?.[0];
    let depth = 0;
    while (scout && depth < 6) {
      console.log(`  L${depth}: tag=${scout.tag} x=${JSON.stringify(scout.x)} y=${JSON.stringify(scout.y)} w=${scout.width} h=${scout.height} children=${scout.children?.length}`);
      scout = scout.children?.[0];
      depth++;
    }
  }
  console.log(`\nFound ${hits.length} captured elements intersecting rect (${TARGET_X},${TARGET_Y},${TARGET_W},${TARGET_H})`);
  console.log(JSON.stringify(hits, null, 2));
  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });

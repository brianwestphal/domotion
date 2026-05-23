import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureElementTree } from "../src/render/element-tree-to-svg.js";
import type { CapturedElement } from "../src/capture/types.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function walk(n: CapturedElement, pred: (n: CapturedElement) => boolean, out: CapturedElement[]) {
  if (pred(n)) out.push(n);
  for (const c of n.children ?? []) walk(c, pred, out);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setViewportSize({ width: 1024, height: 1500 });
await page.goto(`file://${ROOT}/external/html-test/34-mathml-layout.html`);
await page.waitForTimeout(500);

const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 1024, height: 1500 });
const mis: CapturedElement[] = [];
walk(tree[0]!, (n) => n.tag === 'mi', mis);

for (const mi of mis.slice(0, 4)) {
  const styles: any = mi.styles;
  console.log(`<mi> "${mi.text}":`);
  console.log(`  el.x=${mi.x} el.y=${mi.y} w=${mi.width} h=${mi.height}`);
  console.log(`  el.textTop=${(mi as any).textTop} el.textLeft=${(mi as any).textLeft}`);
  console.log(`  el.textHeight=${(mi as any).textHeight} el.textWidth=${(mi as any).textWidth}`);
  console.log(`  el.fontAscent=${(mi as any).fontAscent}`);
  console.log(`  fontFamily=${styles.fontFamily}, fontSize=${styles.fontSize}`);
  console.log(`  textSegments count=${(mi as any).textSegments?.length ?? 0}`);
  if ((mi as any).textSegments && (mi as any).textSegments.length > 0) {
    const s = (mi as any).textSegments[0];
    console.log(`  seg[0] text="${s.text}" x=${s.x} y=${s.y} fontAscent=${s.fontAscent}`);
  }
}

await browser.close();

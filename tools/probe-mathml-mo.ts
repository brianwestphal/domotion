import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1024, height: 1500 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(`file://${ROOT}/external/html-test/34-mathml-layout.html`);
  await page.waitForTimeout(500);

  const result = await page.evaluate(() => {
    const out: any[] = [];
    // Find the 2×2 matrix row at the top
    const rows = document.querySelectorAll('.row');
    for (let ri = 0; ri < Math.min(rows.length, 5); ri++) {
      const row = rows[ri];
      const mos = row.querySelectorAll('mo');
      for (let mi = 0; mi < Math.min(mos.length, 3); mi++) {
        const mo = mos[mi];
        const r = (mo as Element).getBoundingClientRect();
        if (r.width === 0) continue;
        // Get the text node's bbox via Range
        const textNode = mo.firstChild;
        let textRect: any = null;
        if (textNode && textNode.nodeType === 3) {
          const range = document.createRange();
          range.selectNodeContents(textNode);
          const tr = range.getBoundingClientRect();
          textRect = { x: tr.left, y: tr.top, w: tr.width, h: tr.height };
        }
        const parent = mo.parentElement!;
        const pr = parent.getBoundingClientRect();
        const cs = getComputedStyle(mo);
        out.push({
          row: ri,
          moIdx: mi,
          moText: mo.textContent?.slice(0, 5),
          moRect: { x: r.left, y: r.top, w: r.width, h: r.height },
          textRect,
          parentTag: parent.tagName,
          parentRect: { x: pr.left, y: pr.top, w: pr.width, h: pr.height },
          fontSize: cs.fontSize,
          lineHeight: cs.lineHeight,
        });
      }
    }
    return out;
  });

  console.log(JSON.stringify(result, null, 2));
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });

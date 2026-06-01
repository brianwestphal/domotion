// Crop the top diff regions of DM-1001 and save as before/after pairs.
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const regions = [
  { i: 1, x: 17, y: 5082, w: 373, h: 370 },
  { i: 2, x: 0, y: 3837, w: 352, h: 83 },
  { i: 3, x: 17, y: 5462, w: 213, h: 48 },
  { i: 4, x: 252, y: 5024, w: 40, h: 40 },
  { i: 5, x: 272, y: 3779, w: 40, h: 40 },
  { i: 11, x: 353, y: 126, w: 34, h: 17 }, // "East"
  { i: 15, x: 381, y: 2930, w: 9, h: 18 },
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const kind of ["expected", "actual", "diff"]) {
  await page.goto(`file://${process.cwd()}/tests/output/real-world/nytimes-mobile-entire-page-${kind}.png`);
  for (const reg of regions) {
    const buf = await page.screenshot({
      clip: { x: reg.x, y: reg.y, width: reg.w, height: reg.h }
    });
    writeFileSync(`/tmp/dm1001-r${reg.i}-${kind}.png`, buf);
  }
}
await browser.close();
console.log("written /tmp/dm1001-rN-{expected,actual,diff}.png");

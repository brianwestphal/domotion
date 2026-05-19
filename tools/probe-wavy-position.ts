import { chromium } from "@playwright/test";
import sharp from "sharp";

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
await page.setContent(`
<style>
  body { font: 16px/1.5 -apple-system, sans-serif; margin: 20px; background: white; }
  .high { color: #b91c1c; font-weight: bold; text-decoration: underline wavy; }
</style>
<span class="high" id="t">High severity item</span>
`);
const meas = await page.evaluate(() => {
  const span = document.getElementById("t")!;
  const r = span.getBoundingClientRect();
  const probe = document.createElement("span");
  probe.style.cssText = "display:inline-block;width:1px;height:0;vertical-align:baseline;";
  span.appendChild(probe);
  const pr = probe.getBoundingClientRect();
  probe.remove();
  return { spanTop: r.top, spanBottom: r.bottom, baseline: pr.bottom };
});
console.log("meas:", meas);

await page.screenshot({ path: "/tmp/wavy-probe.png", fullPage: true });
await browser.close();

const img = await sharp("/tmp/wavy-probe.png").raw().toBuffer({ resolveWithObject: true });
const { data, info } = img;
console.log(`image: ${info.width}x${info.height} channels=${info.channels}`);
// scan a few columns to find wavy line bands
for (const colX of [110, 130, 150]) {
  const reds: number[] = [];
  for (let y = Math.max(0, Math.floor(meas.spanTop - 5)); y < Math.min(info.height, meas.spanBottom + 30); y++) {
    const idx = (info.width * y + colX) * info.channels;
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];
    if (r > 150 && g < 100 && b < 100) reds.push(y);
  }
  console.log(`col=${colX} red rows:`, reds);
}
console.log(`baseline=${meas.baseline}, spanBottom=${meas.spanBottom}`);

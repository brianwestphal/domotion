// Hosted-macOS repro: does the capture API's first raster screenshot on a
// just-launched browser hit the empty-surface race? Each iteration launches a
// browser with launchChromium, sets content that needs rasters (native
// controls, an emoji) and calls the capture API at once. page.screenshot is
// wrapped so a rejection that capture code swallows is still counted.
//   ARM=capture        captureElementTreeWithWarnings
//   ARM=capture-debug  captureElementTreeWithDebug
//   ARM=capture-raf    two animation frames first, then captureElementTreeWithWarnings
import { appendFileSync } from "node:fs";
import { captureElementTreeWithDebug, captureElementTreeWithWarnings, launchChromium } from "../../dist/index.js";

const arm = process.env.ARM ?? "capture";
const iterations = Number(process.env.ITERATIONS ?? 300);
const parallel = Number(process.env.PARALLEL ?? 6);
const out = process.env.OUT ?? `repro-${arm}.jsonl`;
const VIEWPORT = { x: 0, y: 0, width: 320, height: 200 };
const HTML = `<!doctype html><style>body{margin:0;font:16px sans-serif}</style>
<input type="checkbox" checked> <input type="radio" checked> <input type="range"> <select><option>a</option></select>
<progress value="0.4"></progress> <p>emoji 😀🎉</p>`;
const tally = { runs: 0, captureErrors: 0, emptySurfaceRejections: 0, iterationsWithEmptySurface: 0, otherRejections: 0, screenshots: 0 };
let next = 0;

async function one(index) {
  const browser = await launchChromium();
  const record = { arm, index, screenshots: 0, emptySurface: 0, other: [] };
  try {
    const page = await browser.newPage({ viewport: { width: VIEWPORT.width, height: VIEWPORT.height } });
    const original = page.screenshot.bind(page);
    page.screenshot = async (options) => {
      record.screenshots++;
      try {
        return await original(options);
      } catch (error) {
        if (/Unable to capture screenshot/.test(String(error))) record.emptySurface++;
        else record.other.push(String(error).split("\n")[0]);
        throw error;
      }
    };
    await page.setContent(HTML);
    if (arm === "capture-raf")
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    const result =
      arm === "capture-debug"
        ? await captureElementTreeWithDebug(page, "body", VIEWPORT)
        : await captureElementTreeWithWarnings(page, "body", VIEWPORT);
    record.warnings = (result.warnings ?? []).map((w) => w.feature);
  } catch (error) {
    record.captureError = String(error).split("\n")[0];
  } finally {
    await browser.close();
  }
  tally.runs++;
  tally.screenshots += record.screenshots;
  tally.emptySurfaceRejections += record.emptySurface;
  if (record.emptySurface > 0) tally.iterationsWithEmptySurface++;
  tally.otherRejections += record.other.length;
  if (record.captureError) tally.captureErrors++;
  if (record.emptySurface > 0 || record.captureError || record.other.length > 0) console.log("EVENT", JSON.stringify(record));
  appendFileSync(out, JSON.stringify(record) + "\n");
}

async function worker() {
  while (next < iterations) await one(next++);
}
await Promise.all(Array.from({ length: parallel }, worker));
console.log("TALLY", JSON.stringify({ arm, ...tally }));

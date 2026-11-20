// Hosted-macOS repro for "Unable to capture screenshot" on the first capture of
// a fresh browser. Each iteration launches a browser, opens a page, sets content
// and captures once. Arm "plain" captures right after setContent (the CI shape);
// arm "raf" first waits for two animation frames. On a plain failure it waits
// two frames and captures again to see whether the condition clears.
import { chromium } from "@playwright/test";
import { appendFileSync } from "node:fs";

const iterations = Number(process.env.ITERATIONS ?? 300);
const parallel = Number(process.env.PARALLEL ?? 2);
const out = process.env.OUT ?? "repro.jsonl";
const shapes = {
  dpr4: { viewport: { width: 360, height: 1680 }, deviceScaleFactor: 4 },
  dpr1: {},
};
const tally = {};
let next = 0;

async function one(index) {
  const arm = index % 2 === 0 ? "plain" : "raf";
  const shape = index % 4 < 2 ? "dpr4" : "dpr1";
  const t0 = Date.now();
  const browser = await chromium.launch({ headless: true });
  const record = { index, arm, shape, ok: true };
  try {
    const page = await browser.newPage(shapes[shape]);
    await page.setContent("<!doctype html><style>body{margin:0;background:#fff}</style><div style='width:200px;height:100px;background:#000'></div>");
    if (arm === "raf")
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    record.beforeCaptureMs = Date.now() - t0;
    try {
      await page.screenshot();
    } catch (error) {
      record.ok = false;
      record.error = String(error).split("\n")[0];
      record.failedAtMs = Date.now() - t0;
      const f0 = Date.now();
      const presented = await page.evaluate(
        () =>
          new Promise((r) => {
            const timer = setTimeout(() => r(false), 5000);
            requestAnimationFrame(() => requestAnimationFrame(() => (clearTimeout(timer), r(true))));
          }),
      );
      record.rafAfterFailure = { presented, ms: Date.now() - f0 };
      try {
        await page.screenshot();
        record.recoveredAfterRaf = true;
      } catch (error2) {
        record.recoveredAfterRaf = false;
        record.error2 = String(error2).split("\n")[0];
      }
    }
  } catch (error) {
    record.ok = false;
    record.setupError = String(error).split("\n")[0];
  } finally {
    await browser.close();
  }
  const key = `${arm}/${shape}`;
  tally[key] ??= { runs: 0, failures: 0, recovered: 0 };
  tally[key].runs++;
  if (!record.ok) {
    tally[key].failures++;
    if (record.recoveredAfterRaf) tally[key].recovered++;
    console.log("FAILURE", JSON.stringify(record));
  }
  appendFileSync(out, JSON.stringify(record) + "\n");
}

async function worker() {
  while (next < iterations) await one(next++);
}
await Promise.all(Array.from({ length: parallel }, worker));
console.log("TALLY", JSON.stringify(tally));

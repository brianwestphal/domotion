// Hosted-macOS repro for production first-capture paths.
//   ARM=cli    run the built svg-to-image bin (fresh browser per invocation)
//   ARM=warm   one warm browser; each iteration opens a new context + page,
//              sets content and captures at once (the scratch-page pattern)
//   ARM=warm-raf  same as warm, but waits two animation frames first
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const arm = process.env.ARM ?? "cli";
const iterations = Number(process.env.ITERATIONS ?? 200);
const parallel = Number(process.env.PARALLEL ?? 6);
const out = process.env.OUT ?? `repro-${arm}.jsonl`;
mkdirSync("repro-out", { recursive: true });
writeFileSync(
  "repro-out/in.svg",
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120"><rect width="200" height="120" fill="#fff"/><rect x="20" y="20" width="80" height="40" fill="#000"/></svg>',
);
const tally = { runs: 0, failures: 0, emptySurface: 0, other: 0 };
let next = 0;
let warm;

function runCli(index) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/cli/svg-to-image.js", "repro-out/in.svg", "-o", `repro-out/o-${index}.png`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "";
    child.stdout.on("data", (c) => (text += c));
    child.stderr.on("data", (c) => (text += c));
    child.on("close", (code) => resolve({ ok: code === 0, code, detail: code === 0 ? undefined : text.slice(-600) }));
  });
}

async function runWarm(raf) {
  const context = await warm.newContext({ viewport: { width: 200, height: 120 } });
  try {
    const page = await context.newPage();
    await page.setContent('<body style="margin:0;background:#fff"><div style="width:80px;height:40px;background:#000"></div>');
    if (raf) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    await page.screenshot();
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: String(error).split("\n")[0] };
  } finally {
    await context.close();
  }
}

// Fresh browser per iteration, as in the first repro; "fresh-barrier" first
// awaits the GPU feature-info barrier that launchChromium applies.
async function runFresh(barrier) {
  const browser = await chromium.launch({ headless: true });
  try {
    if (barrier) {
      const { awaitGpuFeatureInfo } = await import(new URL("../../dist/capture/gpu-startup-barrier.js", import.meta.url).href);
      await awaitGpuFeatureInfo(browser);
    }
    const page = await browser.newPage();
    await page.setContent('<body style="margin:0;background:#fff"><div style="width:80px;height:40px;background:#000"></div>');
    await page.screenshot();
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: String(error).split("\n")[0] };
  } finally {
    await browser.close();
  }
}

async function one(index) {
  const started = Date.now();
  const result =
    arm === "cli"
      ? await runCli(index)
      : arm.startsWith("fresh")
        ? await runFresh(arm === "fresh-barrier")
        : await runWarm(arm === "warm-raf");
  tally.runs++;
  if (!result.ok) {
    tally.failures++;
    if (/Unable to capture screenshot/.test(result.detail ?? "")) tally.emptySurface++;
    else tally.other++;
    console.log("FAILURE", JSON.stringify({ arm, index, ms: Date.now() - started, ...result }));
  }
  appendFileSync(out, JSON.stringify({ arm, index, ms: Date.now() - started, ...result }) + "\n");
}

if (arm.startsWith("warm")) warm = await chromium.launch({ headless: true });
async function worker() {
  while (next < iterations) await one(next++);
}
await Promise.all(Array.from({ length: parallel }, worker));
if (warm) await warm.close();
console.log("TALLY", JSON.stringify({ arm, ...tally }));

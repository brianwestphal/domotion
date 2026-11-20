// Probe: does a fresh browser's first page lose a canvas drawn at load, and
// does the browser fall back to software compositing during startup?
// usage: node tools/scratch/probe-gpu-startup.mjs <launches> [barrier|raw] [extra chromium args...]
import { chromium } from "@playwright/test";

const launches = Number(process.argv[2] ?? 10);
const mode = process.argv[3] ?? "raw";
const extraArgs = process.argv.slice(4);
const results = [];
for (let i = 0; i < launches; i++) {
  const t0 = Date.now();
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: extraArgs });
  } catch (err) {
    results.push({ launch: i, error: String(err).split("\n")[0] });
    continue;
  }
  let crashed = false;
  browser.on("disconnected", () => (crashed = true));
  try {
    if (mode === "barrier") {
      const s = await browser.newBrowserCDPSession();
      await s.send("SystemInfo.getInfo");
      await s.detach();
    }
    const page = await browser.newPage({ viewport: { width: 120, height: 120 } });
    await page.setContent(`<canvas width="100" height="100"></canvas><script>
      const canvas = document.querySelector("canvas");
      window.__lost = 0; window.__lostAt = null;
      canvas.addEventListener("contextlost", () => { window.__lost++; window.__lostAt = performance.now(); });
      const context = canvas.getContext("2d");
      context.fillStyle = "rgb(0,80,240)";
      context.fillRect(0, 0, 100, 100);
    </script>`);
    await page.waitForTimeout(700);
    const r = await page.evaluate(() => ({
      lost: window.__lost,
      lostAt: window.__lostAt && Math.round(window.__lostAt),
      center: [...document.querySelector("canvas").getContext("2d").getImageData(50, 50, 1, 1).data],
    }));
    const s = await browser.newBrowserCDPSession();
    const info = await s.send("SystemInfo.getInfo");
    await s.detach();
    results.push({
      launch: i,
      ms: Date.now() - t0,
      ...r,
      compositing: info.gpu.featureStatus?.gpu_compositing,
      raster: info.gpu.featureStatus?.rasterization,
      canvas2d: info.gpu.featureStatus?.["2d_canvas"],
      gl: info.gpu.auxAttributes?.glImplementationParts,
    });
  } catch (err) {
    results.push({ launch: i, crashed, error: String(err).split("\n")[0] });
  } finally {
    await browser.close().catch(() => undefined);
  }
}
for (const r of results) console.log(JSON.stringify(r));
const lost = results.filter((r) => r.lost > 0).length;
const errors = results.filter((r) => r.error).length;
console.log(`platform=${process.platform} mode=${mode} args=${JSON.stringify(extraArgs)} lost=${lost}/${launches} errors=${errors}`);

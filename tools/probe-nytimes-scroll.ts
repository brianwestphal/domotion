import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";

async function main() {
  const svgPath = process.argv[2] ?? "tests/output/real-world/nytimes-mobile-scroll.svg";
  const svg = readFileSync(svgPath, "utf-8").replace(/^<\?xml[^?]*\?>/, "");
  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#fff} svg{display:block}</style>
</head><body>${svg}</body></html>`;
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: "load" });
  await page.waitForTimeout(300);

  // Seek to several timepoints and report what's visible
  for (const t of [0, 200, 400, 1000, 2000, 4000, 6000, 10000]) {
    await page.evaluate((timeMs) => {
      for (const a of document.getAnimations()) {
        try { a.currentTime = timeMs; a.pause(); } catch {}
      }
    }, t);
    await page.waitForTimeout(100);
    const visible = await page.evaluate(() => {
      const result: Array<{ cls: string; visibility: string; transform: string }> = [];
      const segs = document.querySelectorAll('[class^="scrl-"]');
      for (const s of segs) {
        const cs = getComputedStyle(s as Element);
        const t = (s as SVGElement).getAttribute("transform") ?? "";
        result.push({
          cls: (s as Element).getAttribute("class") ?? "",
          visibility: cs.visibility,
          transform: cs.transform === "none" ? t : `computed=${cs.transform}`,
        });
      }
      return result;
    });
    const visibleSegs = visible.filter((v) => v.cls.match(/-s\d+$/) && v.visibility === "visible");
    const composite = visible.find((v) => v.cls === "scrl-r648te");
    console.log(`t=${t}ms: composite-transform=${composite?.transform.slice(0, 80)}`);
    console.log(`  visible segments: ${visibleSegs.map((v) => v.cls.replace("scrl-r648te-", "")).join(", ")}`);

    const outPng = `/tmp/probe-t${t}.png`;
    await page.screenshot({ path: outPng });
    console.log(`  screenshot: ${outPng}`);
  }
  await ctx.close();
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });

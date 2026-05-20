import { chromium } from "@playwright/test";
import { resolve } from "node:path";

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto("file://" + resolve("external/html-test/03-lists-style-types.html"));
  await page.waitForTimeout(200);

  // Take a screenshot of the page and look at the actual pixel data around the marker.
  await page.screenshot({ path: "/tmp/claude/live-chrome-shot.png", clip: { x: 195, y: 372, width: 80, height: 18 } });

  // Measure where Chrome paints by inserting a span at a known x and matching by visual alignment.
  // Instead: use canvas measureText to predict the marker width in the page's font.
  const measurement = await page.evaluate(() => {
    // Find a decimal-leading-zero li
    const li = Array.from(document.querySelectorAll("li")).find(
      (e) => getComputedStyle(e).listStyleType === "decimal-leading-zero",
    );
    if (!li) return { error: "no li found" };
    const r = li.getBoundingClientRect();
    const cs = getComputedStyle(li);
    const markerCs = getComputedStyle(li, "::marker");
    // Measure the marker text width
    const canvas = document.createElement("canvas");
    const c = canvas.getContext("2d")!;
    c.font = `${markerCs.fontWeight} ${markerCs.fontSize} ${markerCs.fontFamily}`;
    const text = "01.";
    const m = c.measureText(text);
    // Insert a probe span at li.x - probe_width to see where it visually lands
    return {
      li: { x: r.left, y: r.top, w: r.width, h: r.height },
      markerCsFont: `${markerCs.fontWeight} ${markerCs.fontSize} ${markerCs.fontFamily}`,
      bodyCsFont: `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`,
      measuredWidth: m.width,
      actualBoundingBoxLeft: m.actualBoundingBoxLeft,
      actualBoundingBoxRight: m.actualBoundingBoxRight,
    };
  });
  console.log("MEASUREMENT:", JSON.stringify(measurement, null, 2));
  await browser.close();
}
void main();

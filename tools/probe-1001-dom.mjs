// Hit live nytimes.com mobile, scroll to the y=5050-5500 zone, and dump the
// DOM tree there with all interesting CSS styles per element so we can see
// exactly what mask-image / -webkit-mask-image / etc. is on which div.
import { chromium } from "@playwright/test";

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();
await page.goto("https://www.nytimes.com/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
await page.setViewportSize({ width: 390, height: 6000 });
await page.waitForTimeout(400);
await page.evaluate(async (h) => {
  window.scrollTo(0, h);
  await new Promise((r) => setTimeout(r, 600));
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 200));
}, 6000);
await page.waitForTimeout(1800);

// Scroll into the diff zone
await page.evaluate(() => window.scrollTo(0, 5050));
await page.waitForTimeout(400);

const dump = await page.evaluate(() => {
  const out = [];
  const all = document.querySelectorAll("*");
  for (const el of all) {
    const r = el.getBoundingClientRect();
    const ay = r.y + window.scrollY;
    if (ay < 5050 || ay > 5500) continue;
    const cs = getComputedStyle(el);
    const cls = typeof el.className === "string" ? el.className : (el.className?.baseVal ?? "");
    const sel = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "")
      + (cls ? "." + cls.split(" ").slice(0, 3).join(".") : "");
    const tag = el.tagName.toLowerCase();

    // Only emit elements where SOMETHING interesting is going on
    const interesting = {
      maskImage: cs.maskImage,
      webkitMaskImage: cs.webkitMaskImage,
      mask: cs.mask,
      webkitMask: cs.webkitMask,
      clipPath: cs.clipPath,
      overflow: cs.overflow,
      overflowX: cs.overflowX,
      contain: cs.contain,
      backgroundImage: cs.backgroundImage,
    };
    const note = [];
    for (const [k, v] of Object.entries(interesting)) {
      if (v && v !== "none" && v !== "visible" && v !== "" && v !== "auto" && !v.startsWith("none ")) {
        note.push(`${k}=${(v || "").slice(0, 100)}`);
      }
    }
    if (note.length === 0) continue;
    out.push({ sel: sel.slice(0, 100), tag, y: ay, w: r.width, h: r.height, note });
  }
  return out;
});

console.log(`Elements with interesting CSS in y=5050-5500: ${dump.length}`);
for (const e of dump) {
  console.log(`\n  <${e.sel}> y=${e.y.toFixed(0)} w=${e.w.toFixed(0)} h=${e.h.toFixed(0)}`);
  for (const n of e.note) console.log(`    ${n}`);
}

await browser.close();

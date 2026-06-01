// DM-1001 redo: the actual root cause per user feedback is a mask-image /
// -webkit-mask-image on a parent div in the y=5050-5500 zone. Find the
// element with the mask, dump its computed style, and confirm.
import { chromium } from "@playwright/test";

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
// Hit live nytimes.com instead of the HAR — DM-1001 user feedback says the
// mask-image is clearly visible in the DOM, but our HAR-replay captured tree
// shows no maskImage values. Live page may render with mask that HAR doesn't.
// await ctx.routeFromHAR("tests/cache/real-world/nytimes-mobile.har", { update: false, notFound: "fallback" });
const page = await ctx.newPage();

await page.goto("https://www.nytimes.com/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
await page.setViewportSize({ width: 390, height: 6000 });
await page.waitForTimeout(400);
await page.evaluate(async (h) => {
  window.scrollTo(0, h);
  await new Promise((r) => setTimeout(r, 400));
  window.scrollTo(0, 0);
}, 6000);
await page.waitForTimeout(1800);

// Scroll to bottom and back up (like the test does) so lazy-loaded promo
// carousels mount, then scroll to the diff zone to capture their state.
await page.evaluate(async () => {
  const h = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
  window.scrollTo(0, h);
  await new Promise((r) => setTimeout(r, 600));
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 200));
  window.scrollTo(0, 5000);
});
await page.waitForTimeout(800);

// Sweep the whole page for elements with non-default mask-image / -webkit-mask-image.
const masked = await page.evaluate(() => {
  const out = [];
  const all = document.querySelectorAll("*");
  for (const el of all) {
    const cs = getComputedStyle(el);
    const m = cs.maskImage || cs.webkitMaskImage;
    const wm = cs.webkitMaskImage;
    const mask = cs.mask;
    const wmask = cs.webkitMask;
    if ((m && m !== "none") || (wm && wm !== "none") || (mask && !mask.startsWith("none")) || (wmask && !wmask.startsWith("none"))) {
      const r = el.getBoundingClientRect();
      const sel = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "")
        + (typeof el.className === "string" && el.className ? "." + el.className.split(" ").slice(0, 2).join(".") : "");
      out.push({
        sel: sel.slice(0, 80),
        x: r.x, y: r.y + window.scrollY, w: r.width, h: r.height,
        maskImage: m || "",
        webkitMaskImage: wm || "",
        maskMode: cs.maskMode,
        maskSize: cs.maskSize,
        maskPosition: cs.maskPosition,
        maskRepeat: cs.maskRepeat,
        maskComposite: cs.maskComposite,
        maskOrigin: cs.maskOrigin,
        maskClip: cs.maskClip,
        mask: cs.mask,
        webkitMask: cs.webkitMask,
      });
    }
  }
  return out;
});

console.log(`Found ${masked.length} masked element(s) on live page`);
for (const m of masked) {
  console.log(`\n  <${m.sel}> y=${m.y.toFixed(0)} w=${m.w.toFixed(0)} h=${m.h.toFixed(0)}`);
  console.log(`    mask-image: ${m.maskImage.slice(0, 200)}`);
  console.log(`    -webkit-mask-image: ${m.webkitMaskImage.slice(0, 200)}`);
}

// Now sweep the whole 0..min(scrollHeight,6000) range by scrolling through it
console.log("\n=== Scrolling through page to find ALL mask-bearing elements ===");
const seen = new Set(masked.map((m) => m.sel + "@" + Math.round(m.y)));
for (let sy = 0; sy < 7000; sy += 1500) {
  await page.evaluate((y) => window.scrollTo(0, y), sy);
  await page.waitForTimeout(400);
  const more = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      const m = cs.maskImage || cs.webkitMaskImage;
      if (m && m !== "none") {
        const r = el.getBoundingClientRect();
        const sel = el.tagName.toLowerCase() + (typeof el.className === "string" && el.className ? "." + el.className.split(" ").slice(0, 2).join(".") : "");
        out.push({ sel: sel.slice(0, 80), y: r.y + window.scrollY, w: r.width, h: r.height, m: m.slice(0, 150) });
      }
    }
    return out;
  });
  for (const m of more) {
    const key = m.sel + "@" + Math.round(m.y);
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  y=${m.y.toFixed(0)} <${m.sel}> w=${m.w.toFixed(0)} h=${m.h.toFixed(0)} mask=${m.m.slice(0, 100)}`);
  }
}

await browser.close();

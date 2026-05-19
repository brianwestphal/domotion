/**
 * Probe: dump slashdot-mobile-fold elements at each DM-661/662/663/664 region
 * via the cached HAR. Prints computed style + tag + text + image href for any
 * element intersecting each region so we can see what should be rendered.
 */
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");

interface Region { id: string; x: number; y: number; w: number; h: number }
const REGIONS: Region[] = [
  { id: "DM-661 titlebar gradient",  x: 132, y: 0,   w: 100, h: 41 },
  { id: "DM-662 login button",       x: 296, y: 6,   w: 89,  h: 31 },
  { id: "DM-663 missing underline",  x: 16,  y: 79,  w: 90,  h: 30 },
  { id: "DM-664 italic font",        x: 5,   y: 417, w: 375, h: 141 },
];

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  await context.routeFromHAR(resolve(CACHE_DIR, "slashdot-mobile.har"), { url: "**/*", notFound: "fallback" });
  const page = await context.newPage();
  await page.goto("https://slashdot.org/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  for (const r of REGIONS) {
    console.log(`\n=== ${r.id} — region (${r.x},${r.y}) ${r.w}×${r.h} ===`);
    const found = await page.evaluate((reg) => {
      const out: any[] = [];
      const all = document.querySelectorAll("*");
      for (const el of Array.from(all)) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        // intersection
        const ix = Math.max(rect.left, reg.x);
        const iy = Math.max(rect.top, reg.y);
        const ax = Math.min(rect.right, reg.x + reg.w);
        const ay = Math.min(rect.bottom, reg.y + reg.h);
        if (ix >= ax || iy >= ay) continue;
        const cs = getComputedStyle(el);
        const text = (el as HTMLElement).innerText?.slice(0, 60);
        out.push({
          tag: el.tagName,
          id: (el as HTMLElement).id,
          cls: (el as HTMLElement).className?.toString?.()?.slice(0, 80),
          rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
          text: text && text.length > 0 ? text : undefined,
          bg: cs.background?.slice(0, 200),
          bgImage: cs.backgroundImage?.slice(0, 200),
          bgColor: cs.backgroundColor,
          color: cs.color,
          fontStyle: cs.fontStyle,
          fontFamily: cs.fontFamily,
          textDecoration: cs.textDecorationLine,
          src: (el as HTMLImageElement).src,
        });
      }
      return out;
    }, r);
    for (const e of found) {
      const summary = [
        `<${e.tag}${e.id ? "#" + e.id : ""}${e.cls ? "." + e.cls.split(/\s+/).slice(0, 2).join(".") : ""}>`,
        `rect=(${e.rect.x.toFixed(0)},${e.rect.y.toFixed(0)} ${e.rect.w.toFixed(0)}×${e.rect.h.toFixed(0)})`,
        e.text ? `text=${JSON.stringify(e.text)}` : "",
        e.bgImage && e.bgImage !== "none" ? `bgImage=${e.bgImage}` : "",
        e.bgColor && e.bgColor !== "rgba(0, 0, 0, 0)" ? `bgColor=${e.bgColor}` : "",
        e.fontStyle && e.fontStyle !== "normal" ? `fontStyle=${e.fontStyle}` : "",
        e.textDecoration && e.textDecoration !== "none" ? `td=${e.textDecoration}` : "",
        e.src ? `src=${e.src.slice(0, 100)}` : "",
        e.fontFamily ? `ff=${e.fontFamily.slice(0, 60)}` : "",
      ].filter(Boolean).join(" ");
      console.log("  " + summary);
    }
  }

  await browser.close();
}

void main();

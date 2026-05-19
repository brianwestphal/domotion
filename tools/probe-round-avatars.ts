/**
 * Probe: dump captured-tree info for the round-avatar elements flagged by
 * DM-670 (nytimes-mobile-fold, x=40 y=361 w=316 h=71 — 4 avatar circles in a
 * row) and DM-672 (framer-mobile-entire-page, x=32 y=5448 w=57 h=63 — a
 * single circular headshot deep on the page).
 */
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureElementTreeWithWarnings } from "../src/render/element-tree-to-svg.js";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");

interface Probe { site: string; har: string; url: string; viewport: { w: number; h: number; isMobile: boolean }; ua: string; region: { x: number; y: number; w: number; h: number }; scrollTo?: number }

const PROBES: Probe[] = [
  {
    site: "nytimes-mobile",
    har: "nytimes-mobile.har",
    url: "https://www.nytimes.com/",
    viewport: { w: 390, h: 844, isMobile: true },
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    region: { x: 40, y: 361, w: 316, h: 71 },
  },
  {
    site: "framer-mobile-deep",
    har: "framer-mobile.har",
    url: "https://www.framer.com/",
    viewport: { w: 390, h: 6000, isMobile: true },  // entire-page mode resizes
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    region: { x: 32, y: 5448, w: 57, h: 63 },
  },
];

async function main() {
  const browser = await chromium.launch();
  for (const p of PROBES) {
    console.log(`\n=== ${p.site} — region (${p.region.x},${p.region.y}) ${p.region.w}×${p.region.h} ===`);
    const context = await browser.newContext({
      viewport: { width: p.viewport.w, height: p.viewport.h },
      deviceScaleFactor: 1,
      isMobile: p.viewport.isMobile,
      hasTouch: p.viewport.isMobile,
      userAgent: p.ua,
    });
    await context.routeFromHAR(resolve(CACHE_DIR, p.har), { url: "**/*", notFound: "fallback" });
    const page = await context.newPage();
    try {
      await page.goto(p.url, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);
    } catch (e) {
      console.log("  page.goto failed:", e instanceof Error ? e.message : String(e));
      await context.close();
      continue;
    }
    // Live DOM probe at the region
    const liveDom = await page.evaluate((reg) => {
      const out: any[] = [];
      for (const el of Array.from(document.querySelectorAll("img, picture, *"))) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const ix = Math.max(rect.left, reg.x), iy = Math.max(rect.top, reg.y);
        const ax = Math.min(rect.right, reg.x + reg.w), ay = Math.min(rect.bottom, reg.y + reg.h);
        if (ix >= ax || iy >= ay) continue;
        const cs = getComputedStyle(el);
        if (el.tagName !== "IMG" && el.tagName !== "PICTURE" && cs.backgroundImage === "none" && cs.borderRadius === "0px" && cs.maskImage === "none" && cs.clipPath === "none") continue;
        out.push({
          tag: el.tagName,
          id: (el as HTMLElement).id,
          cls: (el as HTMLElement).className?.toString?.()?.slice(0, 60),
          rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
          borderRadius: cs.borderRadius,
          objectFit: cs.objectFit,
          objectPosition: cs.objectPosition,
          aspectRatio: cs.aspectRatio,
          maskImage: cs.maskImage?.slice(0, 80),
          clipPath: cs.clipPath?.slice(0, 80),
          backgroundImage: cs.backgroundImage?.slice(0, 80),
          backgroundSize: cs.backgroundSize,
          width: cs.width, height: cs.height,
          overflow: cs.overflow,
          src: (el as HTMLImageElement).src?.slice?.(0, 100),
        });
      }
      return out;
    }, p.region);
    for (const e of liveDom) {
      const parts = [
        `<${e.tag}${e.id ? "#" + e.id : ""}${e.cls ? "." + e.cls.split(/\s+/).slice(0, 2).join(".") : ""}>`,
        `rect=(${e.rect.x.toFixed(0)},${e.rect.y.toFixed(0)} ${e.rect.w.toFixed(0)}×${e.rect.h.toFixed(0)})`,
        e.borderRadius && e.borderRadius !== "0px" ? `bRad=${e.borderRadius}` : "",
        e.objectFit && e.objectFit !== "fill" ? `objFit=${e.objectFit}` : "",
        e.aspectRatio && e.aspectRatio !== "auto" ? `ar=${e.aspectRatio}` : "",
        e.maskImage && e.maskImage !== "none" ? `mask=${e.maskImage}` : "",
        e.clipPath && e.clipPath !== "none" ? `clip=${e.clipPath}` : "",
        e.backgroundImage && e.backgroundImage !== "none" ? `bgImg=${e.backgroundImage.slice(0, 50)}` : "",
        e.overflow && e.overflow !== "visible" ? `overflow=${e.overflow}` : "",
        e.src ? `src=${e.src.slice(0, 70)}` : "",
      ].filter(Boolean).join(" ");
      console.log("  " + parts);
    }
    await context.close();
  }
  await browser.close();
}
void main();

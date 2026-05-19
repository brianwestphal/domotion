/**
 * Probe: dump google.com desktop fold elements at each DM-665/666/667 region.
 * - DM-665: apps icon (3x3 grid) missing at (1131, 7, 66, 52)
 * - DM-666: button text vertical alignment at (474, 393, 338, 78)
 * - DM-667: rounded corners on AI Mode button at (870, 329, 120, 55)
 */
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");

interface Region { id: string; x: number; y: number; w: number; h: number }
const REGIONS: Region[] = [
  { id: "DM-665 apps icon",         x: 1131, y: 7, w: 66, h: 52 },
];

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });
  await context.routeFromHAR(resolve(CACHE_DIR, "google-desktop.har"), { url: "**/*", notFound: "fallback" });
  const page = await context.newPage();
  await page.goto("https://www.google.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  for (const r of REGIONS) {
    console.log(`\n=== ${r.id} — region (${r.x},${r.y}) ${r.w}×${r.h} ===`);
    const found = await page.evaluate((reg) => {
      const out: any[] = [];
      for (const el of Array.from(document.querySelectorAll("*"))) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const ix = Math.max(rect.left, reg.x);
        const iy = Math.max(rect.top, reg.y);
        const ax = Math.min(rect.right, reg.x + reg.w);
        const ay = Math.min(rect.bottom, reg.y + reg.h);
        if (ix >= ax || iy >= ay) continue;
        const cs = getComputedStyle(el);
        const text = (el as HTMLElement).innerText?.slice(0, 60) ?? "";
        out.push({
          tag: el.tagName, id: (el as HTMLElement).id, cls: (el as HTMLElement).className?.toString?.()?.slice(0, 60),
          rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
          text: text.length > 0 ? text : undefined,
          bg: cs.background?.slice(0, 80),
          bgImage: cs.backgroundImage?.slice(0, 100),
          bgColor: cs.backgroundColor,
          color: cs.color,
          borderRadius: cs.borderRadius,
          fontFamily: cs.fontFamily?.slice(0, 60),
          fontSize: cs.fontSize,
          lineHeight: cs.lineHeight,
          display: cs.display,
          alignItems: cs.alignItems,
          justifyContent: cs.justifyContent,
          paddingTop: cs.paddingTop,
          paddingBottom: cs.paddingBottom,
          paddingLeft: cs.paddingLeft,
          borderTopWidth: cs.borderTopWidth,
          borderLeftWidth: cs.borderLeftWidth,
          verticalAlign: cs.verticalAlign,
          fontStretch: cs.fontStretch,
          mask: cs.mask?.slice(0, 100),
          maskImage: cs.maskImage?.slice(0, 100),
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
        e.borderRadius && e.borderRadius !== "0px" ? `radius=${e.borderRadius}` : "",
        e.fontSize ? `fs=${e.fontSize} lh=${e.lineHeight}` : "",
        e.display ? `disp=${e.display}` : "",
        e.alignItems && e.alignItems !== "normal" ? `ai=${e.alignItems}` : "",
        e.paddingTop && e.paddingTop !== "0px" ? `padT=${e.paddingTop}` : "",
        e.paddingBottom && e.paddingBottom !== "0px" ? `padB=${e.paddingBottom}` : "",
        e.paddingLeft && e.paddingLeft !== "0px" ? `padL=${e.paddingLeft}` : "",
        e.borderTopWidth && e.borderTopWidth !== "0px" ? `borT=${e.borderTopWidth}` : "",
        e.verticalAlign && e.verticalAlign !== "baseline" ? `vAlign=${e.verticalAlign}` : "",
        e.maskImage && e.maskImage !== "none" ? `maskImage=${e.maskImage}` : "",
        e.src ? `src=${e.src.slice(0, 80)}` : "",
      ].filter(Boolean).join(" ");
      console.log("  " + summary);
    }
  }
  await browser.close();
}
void main();

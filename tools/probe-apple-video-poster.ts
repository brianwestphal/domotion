/* eslint-disable */
// The .start-frame picture has a SIBLING <video> at the same rect. Maybe the
// video's replacedSnapshot is painting OVER the start-frame img, hiding the
// peripheral flowers.
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { captureElementTree } from "../src/render/element-tree-to-svg.js";
import type { CapturedElement } from "../src/capture/types.js";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");

function walk(n: CapturedElement, pred: (n: CapturedElement) => boolean, out: CapturedElement[]) {
  if (pred(n)) out.push(n);
  for (const c of n.children ?? []) walk(c, pred, out);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  await context.routeFromHAR(resolve(CACHE_DIR, "apple-mobile.har"), { url: "**/*", update: false, notFound: "fallback" });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.goto("https://www.apple.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await page.evaluate(`(async () => {
    const h = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight || 0);
    window.scrollTo(0, h);
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
  })()`);
  await page.waitForTimeout(1800);

  // What's the live video?
  const live = await page.evaluate(`(function() {
    var v = document.querySelector('.inline-media-wrapper video');
    if (!v) return null;
    var cs = getComputedStyle(v);
    var r = v.getBoundingClientRect();
    return {
      tag: v.tagName,
      currentSrc: v.currentSrc,
      paused: v.paused,
      readyState: v.readyState,
      currentTime: v.currentTime,
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
      poster: v.poster,
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      visibility: cs.visibility,
      opacity: cs.opacity,
      display: cs.display,
      objectFit: cs.objectFit,
      transform: cs.transform,
    };
  })()`);
  console.log("Live <video>:", JSON.stringify(live, null, 2));

  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 390, height: 844 });
  const videos: CapturedElement[] = [];
  walk(tree[0]!, (n) => n.tag === "video", videos);
  console.log(`\nCaptured tree: ${videos.length} <video> elements`);
  for (const v of videos.slice(0, 5)) {
    const rs = (v as any).replacedSnapshot;
    console.log(` video rect=(${Math.round(v.x)},${Math.round(v.y)},${Math.round(v.width)},${Math.round(v.height)})`);
    console.log(`   opacity=${(v.styles as any).opacity} visibility=${(v.styles as any).visibility} transform="${(v.styles as any).transform || 'none'}"`);
    if (rs != null) {
      console.log(`   replacedSnapshot rect=(${rs.x},${rs.y},${rs.width},${rs.height}) dataUri.len=${(rs.dataUri || '').length}`);
      if (rs.dataUri) {
        // Save to file for inspection
        const m = String(rs.dataUri).match(/^data:image\/[a-z]+;base64,(.+)$/);
        if (m) {
          const buf = Buffer.from(m[1], 'base64');
          const out = '/tmp/apple-video-poster.png';
          writeFileSync(out, buf);
          console.log(`   poster saved to ${out} (${buf.length} bytes)`);
        }
      }
    } else {
      console.log(`   NO replacedSnapshot`);
    }
  }

  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });

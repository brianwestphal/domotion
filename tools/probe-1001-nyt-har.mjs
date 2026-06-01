// Replay nytimes-mobile HAR and find the <video> elements.
import { chromium } from "@playwright/test";

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
await ctx.routeFromHAR("tests/cache/real-world/nytimes-mobile.har", { update: false, notFound: "abort" });

const page = await ctx.newPage();
await page.goto("https://www.nytimes.com/", { waitUntil: "domcontentloaded" });
await page.waitForLoadState("networkidle").catch(() => {});
await page.waitForTimeout(5000); // SETTLE_MS

// Resize to 6000px and do the scroll-down-and-up dance like the test
await page.setViewportSize({ width: 390, height: 6000 });
await page.waitForTimeout(400);
await page.evaluate(async (h) => {
  window.scrollTo(0, h);
  await new Promise((r) => setTimeout(r, 400));
  window.scrollTo(0, 0);
}, 6000);
await page.waitForTimeout(1800);

// Now find videos
const result = await page.evaluate(() => {
  const videos = Array.from(document.querySelectorAll("video"));
  const out = [];
  for (const v of videos) {
    const r = v.getBoundingClientRect();
    out.push({
      tag: "video",
      x: r.x, y: r.y + window.scrollY, w: r.width, h: r.height,
      src: v.currentSrc || v.src || "",
      poster: v.poster || "",
      paused: v.paused,
      readyState: v.readyState,
      hasShadow: v.shadowRoot != null,
    });
  }
  // Also find big elements near y=5050-5500
  const all = Array.from(document.querySelectorAll("section, div, figure, article"));
  const big = [];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    const ay = r.y + window.scrollY;
    if (ay >= 5050 && ay <= 5500 && r.width >= 200 && r.height >= 100) {
      big.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || "",
        cls: typeof el.className === "string" ? el.className.slice(0, 60) : "",
        x: r.x, y: ay, w: r.width, h: r.height,
      });
    }
  }
  // Search for nyt-betamax players in y=5050-6000
  const allBetamax = Array.from(document.querySelectorAll("nyt-betamax"));
  const betamaxes = [];
  for (const el of allBetamax) {
    const r = el.getBoundingClientRect();
    const ay = r.y + window.scrollY;
    betamaxes.push({ y: ay, w: r.width, h: r.height, hasShadow: el.shadowRoot != null });
  }
  // Find figures at y=5298ish
  const figs = Array.from(document.querySelectorAll("figure"));
  const figsInZone = [];
  for (const f of figs) {
    const r = f.getBoundingClientRect();
    const ay = r.y + window.scrollY;
    if (ay >= 5050 && ay <= 5500) {
      figsInZone.push({ y: ay, w: r.width, h: r.height, html: f.outerHTML.slice(0, 800) });
    }
  }

  // Deep-dive: what's inside the css-1lana14 container at y=5253?
  const container = document.querySelector(".css-1lana14.e1ppw5w20");
  let containerInfo = null;
  if (container) {
    const cs = getComputedStyle(container);
    containerInfo = {
      tag: container.tagName.toLowerCase(),
      display: cs.display,
      visibility: cs.visibility,
      contentVisibility: cs.contentVisibility,
      childCount: container.children.length,
      innerHTML: container.outerHTML.slice(0, 1500),
    };
  }
  // Find all <img> in the y=5050-5500 zone
  const imgs = Array.from(document.querySelectorAll("img"));
  const imgsInZone = [];
  for (const img of imgs) {
    const r = img.getBoundingClientRect();
    const ay = r.y + window.scrollY;
    if (ay >= 5050 && ay <= 5500) {
      const cs = getComputedStyle(img);
      imgsInZone.push({
        x: r.x, y: ay, w: r.width, h: r.height,
        src: img.currentSrc || img.src,
        display: cs.display,
        visibility: cs.visibility,
        contentVisibility: cs.contentVisibility,
        complete: img.complete,
        naturalW: img.naturalWidth,
        naturalH: img.naturalHeight,
      });
    }
  }

  return { videos: out, big: big.slice(0, 15), bodyH: document.body.scrollHeight, containerInfo, imgsInZone, betamaxes, figsInZone };
});

console.log("body scrollHeight:", result.bodyH);
console.log("\nVideo elements:");
for (const v of result.videos) {
  console.log(`  y=${v.y.toFixed(0)} w=${v.w.toFixed(0)} h=${v.h.toFixed(0)} src=${v.src.slice(0, 80)} poster=${v.poster.slice(0, 60)} readyState=${v.readyState} hasShadow=${v.hasShadow}`);
}
console.log("\nBig elements in y=5050-5500:");
for (const e of result.big) {
  console.log(`  <${e.tag}> y=${e.y.toFixed(0)} w=${e.w.toFixed(0)} h=${e.h.toFixed(0)} id="${e.id}" cls="${e.cls}"`);
}
console.log("\nContainer info:");
console.log(JSON.stringify(result.containerInfo, null, 2)?.slice(0, 2000));
console.log("\nAll nyt-betamax players (y, dimensions):");
for (const b of result.betamaxes) {
  console.log(`  y=${b.y.toFixed(0)} w=${b.w.toFixed(0)} h=${b.h.toFixed(0)} hasShadow=${b.hasShadow}`);
}
console.log("\nFigures in y=5050-5500:");
for (const f of result.figsInZone) {
  console.log(`  y=${f.y.toFixed(0)} w=${f.w.toFixed(0)} h=${f.h.toFixed(0)}`);
  console.log(`    html=${f.html.slice(0, 500)}`);
}
console.log("\nImages in y=5050-5500:");
for (const img of result.imgsInZone) {
  console.log(`  <img> y=${img.y.toFixed(0)} w=${img.w.toFixed(0)} h=${img.h.toFixed(0)} display=${img.display} vis=${img.visibility} cv=${img.contentVisibility} complete=${img.complete} natural=${img.naturalW}x${img.naturalH}`);
  console.log(`    src=${img.src.slice(0, 80)}`);
}

await browser.close();

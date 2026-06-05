import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 });
await ctx.routeFromHAR("tests/cache/real-world/resend-mobile.har", { notFound: "fallback" });
const page = await ctx.newPage();
await page.goto("https://resend.com/", { waitUntil: "networkidle" }).catch(() => {});
await page.evaluate(async () => {
  for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 20)); }
  window.scrollTo(0, 0);
});
const info = await page.evaluate(() => {
  // First left-column red-triangle = the active row icon.
  let icon = null;
  for (const svg of document.querySelectorAll("svg.text-red-11")) {
    const r = svg.getBoundingClientRect();
    if (r.left < 120) { icon = svg; break; }
  }
  if (!icon) return "no icon";
  // Walk up to the "row" = the flex-row that contains the icon box (parent of the h-9 w-9 box).
  let row = icon.closest("div.flex.origin-center") || icon.parentElement.parentElement;
  function dump(el, depth, maxDepth) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const flags = [];
    if (cs.position !== "static") flags.push("pos:" + cs.position);
    if (cs.zIndex !== "auto") flags.push("z:" + cs.zIndex);
    if (cs.transform !== "none") flags.push("xform");
    if (cs.isolation !== "auto") flags.push("iso:" + cs.isolation);
    const bg = cs.backgroundColor !== "rgba(0, 0, 0, 0)" ? cs.backgroundColor : (cs.backgroundImage !== "none" ? "img" : "");
    const node = {
      t: el.tagName, c: (el.getAttribute("class") || "").slice(0, 32),
      y: Math.round(r.top + window.scrollY), h: Math.round(r.height),
      f: flags.join(","), bg, after: getComputedStyle(el, "::after").content !== "none" ? "::after" : "",
    };
    if (depth >= maxDepth) return node;
    node.kids = [...el.children].map((c) => dump(c, depth + 1, maxDepth));
    return node;
  }
  // Climb one more level so we capture the row's siblings + the card box.
  const container = row.parentElement;
  return dump(container, 0, 4);
});
console.log(JSON.stringify(info, null, 2));
await browser.close();

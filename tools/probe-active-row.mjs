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
  function compactChain(el, depth) {
    const out = [];
    let n = el;
    for (let i = 0; i < depth && n && n !== document.body; i++) {
      const cs = getComputedStyle(n);
      const flags = [];
      if (cs.position !== "static") flags.push("pos:" + cs.position);
      if (cs.zIndex !== "auto") flags.push("z:" + cs.zIndex);
      if (cs.transform !== "none") flags.push("xform");
      if (cs.isolation !== "auto") flags.push("iso");
      if (/transform|filter|perspective/.test(cs.willChange)) flags.push("wc:" + cs.willChange);
      if (cs.display === "flex" || cs.display === "grid") flags.push(cs.display);
      if (/(paint|content|strict|layout)/.test(cs.contain)) flags.push("contain");
      out.push(`${n.tagName}[${(n.getAttribute("class") || "").slice(0, 28)}]${flags.length ? " {" + flags.join(",") + "}" : ""}`);
      n = n.parentElement;
    }
    return out;
  }
  const rows = [];
  for (const cls of ["text-red-11", "text-green-11", "text-blue-11", "text-yellow-11"]) {
    for (const svg of document.querySelectorAll("svg." + cls)) {
      const r = svg.getBoundingClientRect();
      if (r.left > 120) continue;
      rows.push({ cls, docY: Math.round(r.top + window.scrollY), chain: compactChain(svg, 5) });
    }
  }
  rows.sort((a, b) => a.docY - b.docY);
  return rows;
});
console.log(JSON.stringify(info, null, 2));
await browser.close();

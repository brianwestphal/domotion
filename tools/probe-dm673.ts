/**
 * DM-673: probe what Chrome paints for the .pin elements vs what our
 * capture captures. Two pins exist on the page:
 *   - Pin 0 (Reference section): position:fixed, no transform-ancestor →
 *     should pin to VIEWPORT bottom-right.
 *   - Pin 1 (transform section): position:fixed inside .frame-transform →
 *     should pin to .frame (the transform-CB ancestor) bottom-right.
 *
 * For each pin, report:
 *   - Chrome's painted rect (getBoundingClientRect)
 *   - The nearest fixed-CB ancestor's rect (the box the pin should anchor
 *     against per CSS Position 3 §3.2)
 *   - The .pin's effective `right` / `bottom` offsets per computed style
 */
import { chromium } from "@playwright/test";
import { resolve } from "node:path";
import { captureElementTreeWithWarnings } from "../src/render/element-tree-to-svg.js";

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto("file://" + resolve("external/html-test/13-deep-fixed-in-transform.html"));
  await page.waitForTimeout(200);

  const probeScript = `(() => {
    function isFixedCb(el) {
      var cs = getComputedStyle(el);
      if (cs.transform && cs.transform !== "none") return true;
      if (cs.filter && cs.filter !== "none") return true;
      if (cs.perspective && cs.perspective !== "none") return true;
      if (cs.willChange && /\b(transform|filter|perspective|contain)\b/.test(cs.willChange)) return true;
      if (cs.contain && /\b(paint|strict|content|layout)\b/.test(cs.contain)) return true;
      return false;
    }
    function findCbAncestor(el) {
      var p = el.parentElement;
      while (p) {
        if (isFixedCb(p)) return p;
        p = p.parentElement;
      }
      return null;
    }
    var out = [];
    var pins = document.querySelectorAll(".pin");
    for (var i = 0; i < pins.length; i++) {
      var pin = pins[i];
      var cs = getComputedStyle(pin);
      var r = pin.getBoundingClientRect();
      var cb = findCbAncestor(pin);
      var cbCs = cb ? getComputedStyle(cb) : null;
      var cbR = cb ? cb.getBoundingClientRect() : null;
      out.push({
        text: pin.innerText,
        pinRect: { x: r.left, y: r.top, w: r.width, h: r.height },
        position: cs.position,
        right: cs.right, bottom: cs.bottom,
        cbAncestor: cb ? cb.className : "(viewport)",
        cbProps: cbCs ? { transform: cbCs.transform, filter: cbCs.filter, willChange: cbCs.willChange, contain: cbCs.contain } : null,
        cbRect: cbR ? { x: cbR.left, y: cbR.top, w: cbR.width, h: cbR.height } : null,
      });
    }
    return out;
  })()`;
  const probe = await page.evaluate(probeScript);
  console.log("LIVE CHROME PINS:");
  for (const p of probe) console.log("  " + JSON.stringify(p));

  const cap = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 1024, height: 768 });
  console.log("\nCAPTURED PINS (.pin elements in tree):");
  function walk(n: any, depth = 0): void {
    if (depth > 30) return;
    if (n.classList && n.classList.includes("pin")) {
      console.log(`  d=${depth} <${n.tag}.${n.classList.join(".")}> rect=(${n.x.toFixed(1)}, ${n.y.toFixed(1)}, ${n.width.toFixed(1)}, ${n.height.toFixed(1)}) text="${n.text?.slice(0, 30)}"`);
      console.log(`    styles.position=${n.styles?.position} fixedCBAncestor=${n.fixedCBAncestor ?? "(none)"} hoistedTo=${n.viewportFixed ? "viewport" : "none"}`);
    }
    for (const c of (n.children ?? [])) walk(c, depth + 1);
  }
  for (const root of cap.tree) walk(root);
  await browser.close();
}
void main();

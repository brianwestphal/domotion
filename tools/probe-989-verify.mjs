// Compare each drop-cap's computed effective fontSize to what would
// produce the exactly-painted width via probe rendering.
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1184 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/24-deep-initial-letter.html", "utf-8"));
await page.waitForLoadState("networkidle");

const data = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll("p:first-of-type").forEach((p) => {
    const parent = p.closest("[class*='drop-'], [class*='raise'], [class*='multi'], [class*='sans-']");
    if (!parent) return;
    const cls = Array.from(parent.classList).join(" ");
    const fl = getComputedStyle(p, "::first-letter");
    const firstNode = Array.from(p.childNodes).find((n) => n.nodeType === Node.TEXT_NODE);
    if (!firstNode) return;
    const raw = firstNode.textContent ?? "";
    const offset = raw.length - raw.replace(/^\s+/, "").length;
    const ch = raw[offset];
    const r = document.createRange();
    r.setStart(firstNode, offset);
    r.setEnd(firstNode, offset + 1);
    const cr = r.getBoundingClientRect();
    const pseudoComputedW = parseFloat(fl.width);
    const padR = parseFloat(fl.paddingRight) || 0;
    const padL = parseFloat(fl.paddingLeft) || 0;
    // Probe natural width at 100px
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    ctx.font = `${fl.fontStyle} ${fl.fontWeight} 100px ${fl.fontFamily}`;
    const m = ctx.measureText(ch);
    const natural100 = m.width;
    // Method A: use pseudoComputedW (current code)
    const fsA = 100 * pseudoComputedW / natural100;
    // Method B: subtract padding
    const fsB = 100 * (pseudoComputedW - padL - padR) / natural100;
    // Method C: use cRec width (Range)
    const cRecW = cr.width;
    const fsC = 100 * cRecW / natural100;
    // Method D: cRec.width minus padding
    const fsD = 100 * (cRecW - padL - padR) / natural100;
    // Now probe-render at each fontSize to find which gives matching width visually
    const tryFs = [parseFloat(fl.fontSize), fsA, fsB, fsC, fsD, fsA*0.92, fsA*0.95, fsA*0.93];
    const probeResults = tryFs.map((fs) => {
      const sp = document.createElement('span');
      sp.style.font = `${fl.fontStyle} ${fl.fontWeight} ${fs}px ${fl.fontFamily}`;
      sp.style.position = 'absolute'; sp.style.left = '0'; sp.style.top = '-1000px';
      sp.style.lineHeight = 'normal';
      sp.textContent = ch;
      document.body.appendChild(sp);
      const rr = document.createRange();
      rr.selectNodeContents(sp);
      const rrr = rr.getBoundingClientRect();
      const w = +rrr.width.toFixed(2);
      document.body.removeChild(sp);
      return { fs: +fs.toFixed(2), w };
    });
    out.push({
      cls, ch,
      pseudoFontSize: fl.fontSize,
      pseudoComputedW, padR, padL,
      cRecW: +cr.width.toFixed(2),
      cRecH: +cr.height.toFixed(2),
      cRecY: +cr.y.toFixed(2),
      natural100: +natural100.toFixed(2),
      fsA: +fsA.toFixed(2),
      fsB: +fsB.toFixed(2),
      fsC: +fsC.toFixed(2),
      fsD: +fsD.toFixed(2),
      probes: probeResults,
    });
  });
  return out;
});

console.log(JSON.stringify(data, null, 2));
await browser.close();

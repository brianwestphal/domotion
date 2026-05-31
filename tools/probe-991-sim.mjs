import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const page = await ctx.newPage();
await page.setContent(`<textarea style="width:296px;height:60px;padding:6px;font:13.33px sans-serif;border:1px solid #ccc;box-sizing:border-box">Pre-populated content.
Second line of content.</textarea>`);
await page.waitForLoadState("networkidle");

const result = await page.evaluate(() => {
  const ta = document.querySelector("textarea");
  const cs = getComputedStyle(ta);
  const text = ta.value;
  // mimic the probe
  const probe = document.createElement('div');
  probe.style.position = 'absolute';
  probe.style.left = '0';
  probe.style.top = '-100000px';
  probe.style.visibility = 'hidden';
  probe.style.boxSizing = 'content-box';
  // content box width = rect.width - bl - br - pl - pr
  const r = ta.getBoundingClientRect();
  const pl = parseFloat(cs.paddingLeft);
  const pr = parseFloat(cs.paddingRight);
  const bl = parseFloat(cs.borderLeftWidth);
  const br = parseFloat(cs.borderRightWidth);
  const contentBoxW = r.width - bl - br - pl - pr;
  probe.style.width = contentBoxW + 'px';
  probe.style.padding = '0';
  probe.style.margin = '0';
  probe.style.border = '0';
  probe.style.fontFamily = cs.fontFamily;
  probe.style.fontSize = cs.fontSize;
  probe.style.whiteSpace = 'pre-wrap';
  probe.textContent = text;
  document.body.appendChild(probe);
  const probeNode = probe.firstChild;
  const probeBox = probe.getBoundingClientRect();
  const ys = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') { ys.push({ i, ch: '\\n', y: 'skip' }); continue; }
    const rng = document.createRange();
    rng.setStart(probeNode, i);
    rng.setEnd(probeNode, i + 1);
    const cr = rng.getBoundingClientRect();
    ys.push({ i, ch, x: (cr.left - probeBox.left).toFixed(1), y: (cr.top - probeBox.top).toFixed(1), w: cr.width.toFixed(1) });
  }
  return { contentBoxW, probeBox: { w: probeBox.width, h: probeBox.height }, ys };
});

console.log("contentBoxW:", result.contentBoxW, "probe box:", result.probeBox);
for (const e of result.ys.slice(0, 30)) console.log(JSON.stringify(e));
console.log("...");
for (const e of result.ys.slice(-5)) console.log(JSON.stringify(e));
await browser.close();

import { chromium } from "@playwright/test";
import * as fs from "node:fs";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const page = await ctx.newPage();

// Compare OLD attachment-actual vs CURRENT actual (after recent commits) and against expected.
const oldActual = fs.readFileSync("/Users/westphal/Documents/domotion/.hotsheet/attachments/DM-363_13-pos-sticky-actual.png");
const newActual = fs.readFileSync("/Users/westphal/Documents/domotion/tests/output/html-test/13-pos-sticky-actual.png");
const expected = fs.readFileSync("/Users/westphal/Documents/domotion/tests/output/html-test/13-pos-sticky-expected.png");

await page.setContent("<html><body></body></html>");
const result = await page.evaluate(async ([oldB64, newB64, expB64]) => {
  async function decode(b64) {
    const img = new Image(); img.src = "data:image/png;base64," + b64;
    await new Promise((r) => { img.onload = r; });
    const cvs = document.createElement("canvas"); cvs.width = img.width; cvs.height = img.height;
    const cx = cvs.getContext("2d"); cx.drawImage(img, 0, 0);
    return { d: cx.getImageData(0, 0, img.width, img.height), w: img.width, h: img.height };
  }
  const O = await decode(oldB64), N = await decode(newB64), E = await decode(expB64);
  // Find the BOTTOM border of the scroller in each by scanning x=33 column for darkest pixel
  function bottomBorderY(im) {
    // Search the whole image for #334155 ish (51,65,85)
    const out = [];
    for (let y = 100; y < im.h; y++) {
      const i = (y * im.w + 500) * 4;
      const r = im.d.data[i], g = im.d.data[i + 1], b = im.d.data[i + 2];
      if (r >= 40 && r <= 70 && g >= 55 && g <= 80 && b >= 75 && b <= 100) out.push({ y, rgb: [r, g, b] });
    }
    return out.slice(0, 10);
  }
  return {
    expected: bottomBorderY(E),
    newActual: bottomBorderY(N),
    oldActual: bottomBorderY(O),
    sizes: { exp: [E.w, E.h], new: [N.w, N.h], old: [O.w, O.h] },
  };
}, [oldActual.toString("base64"), newActual.toString("base64"), expected.toString("base64")]);

console.log(JSON.stringify(result, null, 2));
await browser.close();

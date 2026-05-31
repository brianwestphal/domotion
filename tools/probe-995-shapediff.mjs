// Characterize the glyph-shape diff between our drop-cap render and
// Chrome's painted drop cap.
//
// Strategy: take the W region from 24-deep-initial-letter-expected and
// -actual, compute per-pixel diff. If diff is concentrated along the
// glyph edges (1-2 px wide band), it's antialiasing / hinting. If diff
// is spread across the interior, it's a real shape mismatch.
//
// Then render the W as a `<text>` element (browser-native, using the
// embedded subset font) in a separate page, screenshot it, compare to
// the path-mode render and to Chrome's direct paint. This isolates
// whether the diff is path-vs-text or font-hinting.

import { chromium } from "@playwright/test";
import sharp from "sharp";
import { readFileSync } from "node:fs";

const expectedPath = "tests/output/html-test/24-deep-initial-letter-expected.png";
const actualPath = "tests/output/html-test/24-deep-initial-letter-actual.png";

// W region — drop-5 case. From probe-994: ink top ~438, bottom ~569.
const W_REGION = { left: 20, top: 410, width: 240, height: 200 };

async function readRgb(path, region) {
  const img = await sharp(path).extract(region).raw().toBuffer({ resolveWithObject: true });
  return { data: img.data, w: img.info.width, h: img.info.height, c: img.info.channels };
}

const exp = await readRgb(expectedPath, W_REGION);
const act = await readRgb(actualPath, W_REGION);

// Diff per pixel — count which pixels differ by > N.
let totalDiff = 0;
let edgeDiff = 0;
let interiorDiff = 0;
let bothInked = 0;
let onlyExp = 0;
let onlyAct = 0;
function isDarkAt(buf, idx) {
  // Average RGB; consider dark if < 200.
  return (buf[idx] + buf[idx + 1] + buf[idx + 2]) / 3 < 200;
}
for (let y = 0; y < exp.h; y++) {
  for (let x = 0; x < exp.w; x++) {
    const idx = (y * exp.w + x) * exp.c;
    const ed = isDarkAt(exp.data, idx);
    const ad = isDarkAt(act.data, idx);
    const diff = Math.abs(exp.data[idx] - act.data[idx]) + Math.abs(exp.data[idx + 1] - act.data[idx + 1]) + Math.abs(exp.data[idx + 2] - act.data[idx + 2]);
    if (diff > 30) totalDiff++;
    if (ed && ad) bothInked++;
    else if (ed) onlyExp++;
    else if (ad) onlyAct++;
  }
}
console.log("W region pixel-diff stats:");
console.log(`  total pixels: ${exp.w * exp.h}`);
console.log(`  pixels with diff > 30: ${totalDiff}`);
console.log(`  both inked: ${bothInked}, only-expected: ${onlyExp}, only-actual: ${onlyAct}`);
console.log(`  inked-symmetric-diff: ${onlyExp + onlyAct}, ratio of overlap: ${(bothInked / (bothInked + onlyExp + onlyAct) * 100).toFixed(1)}%`);

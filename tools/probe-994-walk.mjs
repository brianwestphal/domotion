// Compare expected vs actual painted W in 24-deep-initial-letter to
// characterise where the diff comes from: shape, position, or both.
//
// Strategy: walk the expected and actual PNGs row-by-row in the W region,
// find the inkiest (most-non-white) pixel column for each row, plot the
// ink extent in both images. If the ink rows align vertically, the diff
// is glyph shape only. If they're shifted, it's baseline-y precision.

import { readFileSync } from "node:fs";
import sharp from "sharp";

const expectedPath = "tests/output/html-test/24-deep-initial-letter-expected.png";
const actualPath = "tests/output/html-test/24-deep-initial-letter-actual.png";

async function readGray(path, region) {
  const img = await sharp(path)
    .extract(region)
    .raw()
    .greyscale()
    .toBuffer({ resolveWithObject: true });
  return { data: img.data, info: img.info };
}

// W region — drop-5 W per probe at x=35.59 y=427.02 w=208.45 h=116.
// Pad generous around it.
const region = { left: 20, top: 410, width: 240, height: 160 };

const exp = await readGray(expectedPath, region);
const act = await readGray(actualPath, region);

function inkExtent(grayBuf, info, threshold = 200) {
  // For each row, find leftmost+rightmost ink pixel. Returns array of {row, left, right, dark}.
  const rows = [];
  for (let y = 0; y < info.height; y++) {
    let left = -1, right = -1, dark = 0;
    for (let x = 0; x < info.width; x++) {
      const v = grayBuf[y * info.width + x];
      if (v < threshold) {
        if (left === -1) left = x;
        right = x;
        dark++;
      }
    }
    rows.push({ row: y, left, right, dark });
  }
  return rows;
}

const expRows = inkExtent(exp.data, exp.info);
const actRows = inkExtent(act.data, act.info);

// Find the first and last rows with ink in each, to characterise vertical extent.
const expInkRows = expRows.filter((r) => r.dark > 5);
const actInkRows = actRows.filter((r) => r.dark > 5);
const expTop = expInkRows[0]?.row;
const expBot = expInkRows[expInkRows.length - 1]?.row;
const actTop = actInkRows[0]?.row;
const actBot = actInkRows[actInkRows.length - 1]?.row;
console.log("expected ink: row", expTop, "→", expBot, "(height", expBot - expTop + 1, ") in absolute y:", 410 + expTop, "→", 410 + expBot);
console.log("actual   ink: row", actTop, "→", actBot, "(height", actBot - actTop + 1, ") in absolute y:", 410 + actTop, "→", 410 + actBot);

// Find the leftmost ink pixel across all rows (W's left edge)
const expLeftMin = Math.min(...expInkRows.map(r => r.left));
const actLeftMin = Math.min(...actInkRows.map(r => r.left));
const expRightMax = Math.max(...expInkRows.map(r => r.right));
const actRightMax = Math.max(...actInkRows.map(r => r.right));
console.log("expected W: left=" + (20 + expLeftMin) + " right=" + (20 + expRightMax) + " width=" + (expRightMax - expLeftMin + 1));
console.log("actual   W: left=" + (20 + actLeftMin) + " right=" + (20 + actRightMax) + " width=" + (actRightMax - actLeftMin + 1));

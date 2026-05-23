import sharp from "sharp";

async function readGray(path, x0, y0, w, h) {
  const buf = await sharp(path).extract({ left: x0, top: y0, width: w, height: h }).greyscale().raw().toBuffer();
  return { buf, w, h };
}

// Find the y range where there's ink in a tight column at the (.
// Region around (394, 229) for the `(` mo glyph in row 0.
const x0 = 394, y0 = 215, w = 12, h = 50;
for (const variant of ["expected", "actual"]) {
  const { buf } = await readGray(`tests/output/html-test/34-mathml-layout-${variant}.png`, x0, y0, w, h);
  // For each row, count "dark" pixels (gray < 128)
  const rows = [];
  for (let y = 0; y < h; y++) {
    let dark = 0;
    for (let x = 0; x < w; x++) {
      const v = buf[y * w + x];
      if (v < 128) dark++;
    }
    rows.push(dark);
  }
  // Find first and last row with at least 1 dark pixel
  let firstY = -1, lastY = -1;
  for (let y = 0; y < h; y++) { if (rows[y] > 0) { firstY = y; break; } }
  for (let y = h - 1; y >= 0; y--) { if (rows[y] > 0) { lastY = y; break; } }
  const topY = y0 + firstY;
  const botY = y0 + lastY;
  const inkH = botY - topY + 1;
  console.log(`${variant}: ink y=${topY} to ${botY} (height ${inkH}); center y=${(topY+botY)/2}`);
  // Print per-row counts for the glyph region
  console.log(`  row dark counts:`);
  for (let y = firstY; y <= lastY; y++) {
    console.log(`    y=${y0+y}: ${rows[y]}`);
  }
}

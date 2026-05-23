import sharp from "sharp";

const items = [
  // (mo): x≈395, y≈229
  { name: "mo (", x0: 394, y0: 220, w: 12, h: 40 },
  // mi a: x≈411, y≈220
  { name: "mi a", x0: 408, y0: 218, w: 16, h: 28 },
  // mi b: x≈441, y≈220
  { name: "mi b", x0: 438, y0: 215, w: 16, h: 28 },
  // mi c: x≈412, y≈245
  { name: "mi c", x0: 408, y0: 248, w: 16, h: 22 },
];

async function readGray(path, x0, y0, w, h) {
  const buf = await sharp(path).extract({ left: x0, top: y0, width: w, height: h }).greyscale().raw().toBuffer();
  return { buf, w, h };
}

for (const it of items) {
  console.log(`\n--- ${it.name} ---`);
  for (const variant of ["expected", "actual"]) {
    const { buf } = await readGray(`tests/output/html-test/34-mathml-layout-${variant}.png`, it.x0, it.y0, it.w, it.h);
    const rows = [];
    for (let y = 0; y < it.h; y++) {
      let dark = 0;
      for (let x = 0; x < it.w; x++) if (buf[y * it.w + x] < 128) dark++;
      rows.push(dark);
    }
    let firstY = -1, lastY = -1;
    for (let y = 0; y < it.h; y++) { if (rows[y] > 0) { firstY = y; break; } }
    for (let y = it.h - 1; y >= 0; y--) { if (rows[y] > 0) { lastY = y; break; } }
    const topY = it.y0 + firstY;
    const botY = it.y0 + lastY;
    console.log(`  ${variant}: ink y=${topY} to ${botY} (h=${botY-topY+1}); center=${(topY+botY)/2}`);
  }
}

import sharp from "sharp";
const base = "tests/output/html-test/32-real-world-pricing-table";
const meta = await sharp(`${base}-expected.png`).metadata();
console.log("size:", meta.width, "x", meta.height);
// Crop a wide view
async function crop(src, dst, top, h) {
  await sharp(src).extract({ left: 0, top, width: Math.min(1024, meta.width), height: h }).toFile(dst);
}
// Visit several regions: top, middle, bottom
for (const [name, top, h] of [["top", 0, 600], ["mid", 600, 600], ["bot", 1200, Math.min(800, meta.height - 1200)]]) {
  await crop(`${base}-expected.png`, `/tmp/p928-${name}-e.png`, top, h);
  await crop(`${base}-actual.png`, `/tmp/p928-${name}-a.png`, top, h);
}

import sharp from "sharp";
async function crop(src, dst, ymin, ymax) {
  const meta = await sharp(src).metadata();
  await sharp(src).extract({ left: 0, top: ymin, width: Math.min(800, meta.width), height: ymax - ymin }).toFile(dst);
}
const base = "tests/output/html-test/20-deep-first-letter-line";
// Just save full-size diff for human view
await crop(`${base}-expected.png`, "/tmp/20df-expected.png", 0, 700);
await crop(`${base}-actual.png`, "/tmp/20df-actual.png", 0, 700);
await crop(`${base}-diff.png`, "/tmp/20df-diff.png", 0, 700);
await sharp({ create: { width: 2410, height: 720, channels: 3, background: { r: 255, g: 255, b: 255 } } })
  .composite([
    { input: "/tmp/20df-expected.png", left: 5, top: 10 },
    { input: "/tmp/20df-actual.png", left: 805, top: 10 },
    { input: "/tmp/20df-diff.png", left: 1605, top: 10 },
  ])
  .toFile("/tmp/20df-sbs.png");
console.log("done");

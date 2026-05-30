import sharp from "sharp";
const base = "tests/output/html-test/20-deep-first-letter-line";
async function crop(src, dst, top, h) {
  await sharp(src).extract({ left: 0, top, width: 600, height: h }).toFile(dst);
}
const top = 800;
const h = 300;
await crop(`${base}-expected.png`, "/tmp/20df-dec-e.png", top, h);
await crop(`${base}-actual.png`, "/tmp/20df-dec-a.png", top, h);
await crop(`${base}-diff.png`, "/tmp/20df-dec-d.png", top, h);
await sharp({ create: { width: 1820, height: 320, channels: 3, background: { r: 255, g: 255, b: 255 } } })
  .composite([
    { input: "/tmp/20df-dec-e.png", left: 5, top: 10 },
    { input: "/tmp/20df-dec-a.png", left: 610, top: 10 },
    { input: "/tmp/20df-dec-d.png", left: 1215, top: 10 },
  ])
  .toFile("/tmp/20df-dec-sbs.png");
console.log("done");

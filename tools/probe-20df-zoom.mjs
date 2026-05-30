import sharp from "sharp";
const base = "tests/output/html-test/20-deep-first-letter-line";
// Zoom into the floated drop cap area (third example, lower in image)
// "Floated drop cap" header should be around y=450ish
const meta = await sharp(`${base}-expected.png`).metadata();
console.log("expected size:", meta.width, "x", meta.height);
async function crop(src, dst, top, h) {
  await sharp(src).extract({ left: 0, top, width: 600, height: h }).toFile(dst);
}
// Bottom half
const top = 380;
const h = 280;
await crop(`${base}-expected.png`, "/tmp/20df-z-e.png", top, h);
await crop(`${base}-actual.png`, "/tmp/20df-z-a.png", top, h);
await crop(`${base}-diff.png`, "/tmp/20df-z-d.png", top, h);
await sharp({ create: { width: 1820, height: 300, channels: 3, background: { r: 255, g: 255, b: 255 } } })
  .composite([
    { input: "/tmp/20df-z-e.png", left: 5, top: 10 },
    { input: "/tmp/20df-z-a.png", left: 610, top: 10 },
    { input: "/tmp/20df-z-d.png", left: 1215, top: 10 },
  ])
  .toFile("/tmp/20df-zoom.png");
console.log("done");

import sharp from "sharp";
// Crop the .drop-fancy area from both expected and actual
// p rect: x=32, y=770.125, w=720, h=112
// But the first-letter starts at y≈722 (sticks above the baseline)
// Crop a region: x=0, y=700, w=300, h=200
async function crop(src, dst) {
  await sharp(src).extract({ left: 0, top: 700, width: 300, height: 200 }).toFile(dst);
}
await crop("tests/output/html-test/24-deep-initial-letter-expected.png", "/tmp/dm931-fl-expected.png");
await crop("tests/output/html-test/24-deep-initial-letter-actual.png", "/tmp/dm931-fl-actual.png");
await crop("tests/output/html-test/24-deep-initial-letter-diff.png", "/tmp/dm931-fl-diff.png");
// Side-by-side
await sharp({ create: { width: 920, height: 220, channels: 3, background: { r: 255, g: 255, b: 255 } } })
  .composite([
    { input: "/tmp/dm931-fl-expected.png", left: 5, top: 10 },
    { input: "/tmp/dm931-fl-actual.png", left: 310, top: 10 },
    { input: "/tmp/dm931-fl-diff.png", left: 615, top: 10 },
  ])
  .toFile("/tmp/dm931-fl-sbs.png");
console.log("done");

import sharp from "sharp";
const base = "tests/output/html-test/32-real-world-pricing-table";
const x = 53, y = 616, w = 251, h = 41;
async function crop(src, dst) {
  await sharp(src).extract({ left: x, top: y, width: w, height: h }).toFile(dst);
}
await crop(`${base}-expected.png`, "/tmp/p928-li-e.png");
await crop(`${base}-actual.png`, "/tmp/p928-li-a.png");
await crop(`${base}-diff.png`, "/tmp/p928-li-d.png");
async function zoom(src, dst) {
  const m = await sharp(src).metadata();
  await sharp(src).resize(m.width*5, m.height*5, { kernel: "nearest" }).toFile(dst);
}
await zoom("/tmp/p928-li-e.png", "/tmp/p928-li-ez.png");
await zoom("/tmp/p928-li-a.png", "/tmp/p928-li-az.png");
await zoom("/tmp/p928-li-d.png", "/tmp/p928-li-dz.png");
await sharp({ create: { width: 3795, height: 220, channels: 3, background: {r:255,g:255,b:255} } })
  .composite([
    { input: "/tmp/p928-li-ez.png", left: 5, top: 10 },
    { input: "/tmp/p928-li-az.png", left: 1265, top: 10 },
    { input: "/tmp/p928-li-dz.png", left: 2530, top: 10 },
  ])
  .toFile("/tmp/p928-li-sbs.png");
console.log("done");

import sharp from "sharp";
const base = "tests/output/html-test/32-real-world-pricing-table";
// Zoom into one feature list item - the user's REGION was at y=616 to 882
async function crop(src, dst, x, y, w, h) {
  await sharp(src).extract({ left: x, top: y, width: w, height: h }).toFile(dst);
}
// Crop a single pricing card's feature list
const x = 360, y = 600, w = 350, h = 350;
await crop(`${base}-expected.png`, "/tmp/p928-card-e.png", x, y, w, h);
await crop(`${base}-actual.png`, "/tmp/p928-card-a.png", x, y, w, h);
await crop(`${base}-diff.png`, "/tmp/p928-card-d.png", x, y, w, h);
// Zoom 3x for clarity
async function zoom(src, dst) {
  const m = await sharp(src).metadata();
  await sharp(src).resize(m.width*3, m.height*3, { kernel: "nearest" }).toFile(dst);
}
await zoom("/tmp/p928-card-e.png", "/tmp/p928-card-ez.png");
await zoom("/tmp/p928-card-a.png", "/tmp/p928-card-az.png");
await zoom("/tmp/p928-card-d.png", "/tmp/p928-card-dz.png");
await sharp({ create: { width: 3210, height: 1080, channels: 3, background: {r:255,g:255,b:255} } })
  .composite([
    { input: "/tmp/p928-card-ez.png", left: 5, top: 10 },
    { input: "/tmp/p928-card-az.png", left: 1070, top: 10 },
    { input: "/tmp/p928-card-dz.png", left: 2135, top: 10 },
  ])
  .toFile("/tmp/p928-card-sbs.png");
console.log("done");

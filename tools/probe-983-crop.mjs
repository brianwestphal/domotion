import sharp from "sharp";
const base = "tests/output/html-test-unicode/12480-1254F-early-dynastic-cuneiform";
const m = await sharp(`${base}-expected.png`).metadata();
console.log("dims:", m.width, "x", m.height);
async function crop(src, dst) {
  await sharp(src).extract({ left: 0, top: 0, width: Math.min(800, m.width), height: Math.min(400, m.height) }).toFile(dst);
}
await crop(`${base}-expected.png`, "/tmp/p983-e.png");
await crop(`${base}-actual.png`, "/tmp/p983-a.png");
await crop(`${base}-diff.png`, "/tmp/p983-d.png");
await sharp({ create: { width: 2420, height: 420, channels: 3, background: {r:255,g:255,b:255} } })
  .composite([
    { input: "/tmp/p983-e.png", left: 5, top: 10 },
    { input: "/tmp/p983-a.png", left: 810, top: 10 },
    { input: "/tmp/p983-d.png", left: 1615, top: 10 },
  ])
  .toFile("/tmp/p983-sbs.png");
console.log("done");

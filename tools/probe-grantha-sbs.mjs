import sharp from "sharp";
const base = "tests/output/html-test-unicode/11300-1137F-grantha";
async function crop(s, d) { await sharp(s).extract({ left: 0, top: 0, width: 800, height: 400 }).toFile(d); }
await crop(`${base}-expected.png`, "/tmp/grantha-e.png");
await crop(`${base}-actual.png`, "/tmp/grantha-a.png");
await sharp({ create: { width: 1620, height: 420, channels: 3, background: {r:255,g:255,b:255} } })
  .composite([
    { input: "/tmp/grantha-e.png", left: 5, top: 10 },
    { input: "/tmp/grantha-a.png", left: 810, top: 10 },
  ])
  .toFile("/tmp/grantha-sbs.png");

import sharp from "sharp";
async function sbs(e, a, out, height) {
  await sharp({ create: { width: 2070, height: height + 20, channels: 3, background: {r:255,g:255,b:255} } })
    .composite([
      { input: e, left: 5, top: 10 },
      { input: a, left: 1035, top: 10 },
    ])
    .toFile(out);
}
await sbs("/tmp/p928-top-e.png", "/tmp/p928-top-a.png", "/tmp/p928-top-sbs.png", 600);
await sbs("/tmp/p928-mid-e.png", "/tmp/p928-mid-a.png", "/tmp/p928-mid-sbs.png", 600);
await sbs("/tmp/p928-bot-e.png", "/tmp/p928-bot-a.png", "/tmp/p928-bot-sbs.png", 200);
console.log("done");

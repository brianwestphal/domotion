import sharp from "sharp";
const region = { left: 64, top: 268, width: 269, height: 68 };
// Scale up 3x for legibility in the ticket UI.
async function crop(src, dst) {
  const meta = await sharp(src).extract(region).toBuffer();
  await sharp(meta).resize(region.width * 3, region.height * 3, { kernel: "nearest" }).toFile(dst);
}
// BEFORE = the recorded attachment actual (pre-fix, full-tint).
await crop(".hotsheet/attachments/DM-1051_resend-mobile-entire-page-actual.png", "tests/output/dm1051-region-before.png");
// AFTER = the freshly regenerated actual (dark pill + thin gradient border).
await crop("tests/output/real-world/resend-mobile-entire-page-actual.png", "tests/output/dm1051-region-after.png");
// EXPECTED = Chromium reference.
await crop("tests/output/real-world/resend-mobile-entire-page-expected.png", "tests/output/dm1051-region-expected.png");
console.log("wrote before/after/expected region crops (3x)");

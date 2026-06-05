import sharp from "sharp";
const region = { left: 64, top: 268, width: 269, height: 68 };
async function diffPct(aPath, bPath) {
  const a = await sharp(aPath).extract(region).raw().toBuffer();
  const b = await sharp(bPath).extract(region).raw().toBuffer();
  let diff = 0, n = 0;
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (d > 30) diff++;
    n++;
  }
  return (100 * diff / n).toFixed(2);
}
const before = await diffPct(
  ".hotsheet/attachments/DM-1051_resend-mobile-entire-page-actual.png",
  ".hotsheet/attachments/DM-1051_resend-mobile-entire-page-expected.png",
);
const after = await diffPct(
  "tests/output/real-world/resend-mobile-entire-page-actual.png",
  "tests/output/real-world/resend-mobile-entire-page-expected.png",
);
console.log(`region [1] differing-pixel %:  before=${before}%  after=${after}%`);

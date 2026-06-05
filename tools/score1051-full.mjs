import sharp from "sharp";
async function fullPct(aPath, bPath) {
  const a = sharp(aPath);
  const b = sharp(bPath);
  const [ab, bb] = await Promise.all([a.raw().toBuffer({ resolveWithObject: true }), b.raw().toBuffer({ resolveWithObject: true })]);
  const A = ab.data, B = bb.data;
  const n = Math.min(A.length, B.length);
  let diff = 0, tot = 0;
  for (let i = 0; i + 2 < n; i += ab.info.channels) {
    const d = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
    if (d > 30) diff++;
    tot++;
  }
  return { pct: (100 * diff / tot).toFixed(3), w: ab.info.width, h: ab.info.height };
}
const before = await fullPct(
  ".hotsheet/attachments/DM-1051_resend-mobile-entire-page-actual.png",
  ".hotsheet/attachments/DM-1051_resend-mobile-entire-page-expected.png",
);
const after = await fullPct(
  "tests/output/real-world/resend-mobile-entire-page-actual.png",
  "tests/output/real-world/resend-mobile-entire-page-expected.png",
);
console.log("whole-image differing-pixel %:");
console.log("  before:", before);
console.log("  after :", after);

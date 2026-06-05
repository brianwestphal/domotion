import sharp from "sharp";
const reg = { left: 36, top: 1541, width: 317, height: 126 };
for (const [tag, src] of [
  ["expected", "tests/output/real-world/resend-mobile-entire-page-expected.png"],
  ["actual", "tests/output/real-world/resend-mobile-entire-page-actual.png"],
]) {
  await sharp(src).extract(reg).resize(reg.width * 2, reg.height * 2, { kernel: "nearest" }).toFile(`tests/output/dm1053-${tag}.png`);
}
console.log("done");

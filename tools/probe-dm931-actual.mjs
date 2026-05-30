import sharp from "sharp";
async function bbox(src) {
  const img = sharp(src);
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, ch = info.channels;
  const get = (x, y) => {
    const i = (y * w + x) * ch;
    return [data[i], data[i+1], data[i+2]];
  };
  const isGradient = (r, g, b) => {
    if (g > 100) return false;
    if (b < 150) return false;
    return true;
  };
  let minX = w, maxX = 0, minY = h, maxY = 0;
  for (let y = 700; y < 900 && y < h; y++) {
    for (let x = 0; x < Math.min(300, w); x++) {
      const [r, g, b] = get(x, y);
      if (isGradient(r, g, b)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, maxX, minY, maxY, w: maxX-minX+1, h: maxY-minY+1 };
}
console.log("Expected.png box:", await bbox("tests/output/html-test/24-deep-initial-letter-expected.png"));
console.log("Actual.png box:  ", await bbox("tests/output/html-test/24-deep-initial-letter-actual.png"));

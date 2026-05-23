// Find the ACTUAL painted bounds of each drop-cap (W, B, T) in Chrome's
// expected.png by detecting the colored / black pixel ranges.
import sharp from 'sharp';

const targets = [
  { name: 'W (drop-5)', cropX: 13, cropY: 422, cropW: 275, cropH: 237, colorTest: (r, g, b) => r > 100 && g < 80 && b < 80 },
  { name: 'B (drop-fancy)', cropX: 24, cropY: 742, cropW: 177, cropH: 191, colorTest: (r, g, b) => b > 100 && r < 100 }, // blue/purple bg
  { name: 'T (multi)', cropX: 23, cropY: 1259, cropW: 135, cropH: 158, colorTest: (r, g, b) => b > 100 && r < 100 }, // blue
];

for (const tgt of targets) {
  for (const which of ['expected', 'actual']) {
    const path = `/Users/westphal/Documents/domotion/tests/output/html-test/24-deep-initial-letter-${which}.png`;
    const { data, info } = await sharp(path)
      .extract({ left: tgt.cropX, top: tgt.cropY, width: tgt.cropW, height: tgt.cropH })
      .raw().toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height, ch = info.channels;
    let minX = W, maxX = -1, minY = H, maxY = -1, count = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * ch;
        if (tgt.colorTest(data[i], data[i + 1], data[i + 2])) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          count++;
        }
      }
    }
    const absX = tgt.cropX + minX, absY = tgt.cropY + minY;
    const wd = maxX - minX + 1, ht = maxY - minY + 1;
    console.log(`${tgt.name.padEnd(20)} ${which.padEnd(8)} cropbox=${minX},${minY}+${wd}x${ht}  page=(${absX},${absY},${wd},${ht})  pixels=${count}`);
  }
}

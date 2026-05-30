import sharp from "sharp";
const img = sharp("/tmp/dm931-wide.png");
const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
const w = info.width, h = info.height, ch = info.channels;
const get = (x, y) => {
  const i = (y * w + x) * ch;
  return [data[i], data[i+1], data[i+2]];
};
// The gradient: linear-gradient(135deg, rgb(29, 78, 216), rgb(109, 40, 217))
// Sample STRONG blue/purple gradient — but limit to drop cap y region (730..850)
const isGradient = (r, g, b) => {
  // Blue band: r low, b high
  return r < 130 && b > 180 && Math.abs(b - 215) < 60;
};
let minX = w, maxX = 0, minY = h, maxY = 0;
const yStart = 20, yEnd = 170; // viewport 720..870
for (let y = yStart; y < yEnd; y++) {
  for (let x = 0; x < w; x++) {
    const [r, g, b] = get(x, y);
    if (isGradient(r, g, b)) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
console.log("Gradient box bbox (drop cap region only):");
console.log("  viewport x:", minX, "to", maxX, "(width", maxX-minX+1, ")");
console.log("  viewport y:", 700+minY, "to", 700+maxY, "(height", maxY-minY+1, ")");
// Sample colors at expected corners
console.log("\nSample pixels:");
for (const [vx, vy] of [[32, 723], [32, 830], [140, 723], [140, 830], [32, 770], [110, 770]]) {
  console.log(`  (${vx}, ${vy}) =`, get(vx, vy - 700));
}

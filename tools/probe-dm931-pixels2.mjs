import sharp from "sharp";
const img = sharp("/tmp/dm931-wide.png");
const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
const w = info.width, h = info.height, ch = info.channels;
const get = (x, y) => {
  const i = (y * w + x) * ch;
  return [data[i], data[i+1], data[i+2]];
};
// More inclusive: any gradient endpoint or intermediate purple/blue
const isGradient = (r, g, b) => {
  // Strong blue OR strong purple OR intermediate (both endpoints blue+red dominant, green low)
  if (g > 100) return false;
  if (b < 150) return false;
  return true;
};
let minX = w, maxX = 0, minY = h, maxY = 0;
for (let y = 0; y < 170; y++) {
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
console.log("Gradient box bbox:");
console.log("  viewport x:", minX, "to", maxX, "(width", maxX-minX+1, ")");
console.log("  viewport y:", 700+minY, "to", 700+maxY, "(height", maxY-minY+1, ")");
// Sample corners of the actual box found
console.log("\nCorners:");
console.log(`  TL (${minX}, ${700+minY}) =`, get(minX, minY));
console.log(`  TR (${maxX}, ${700+minY}) =`, get(maxX, minY));
console.log(`  BL (${minX}, ${700+maxY}) =`, get(minX, maxY));
console.log(`  BR (${maxX}, ${700+maxY}) =`, get(maxX, maxY));

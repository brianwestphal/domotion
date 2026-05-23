import sharp from "sharp";
import { mkdirSync } from "node:fs";

mkdirSync("/tmp/claude", { recursive: true });

const regions = [
  { id: "r1", x: 361, y: 113, w: 29, h: 43 },
  { id: "r2", x: 370, y: 2922, w: 20, h: 31 },
];

const variants = ["actual", "expected"];
for (const v of variants) {
  for (const r of regions) {
    await sharp(`tests/output/real-world/nytimes-mobile-entire-page-${v}.png`)
      .extract({ left: r.x, top: r.y, width: r.w, height: r.h })
      .toFile(`/tmp/claude/nyt-${r.id}-${v}.png`);
  }
}
console.log("Done");

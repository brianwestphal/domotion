import sharp from "sharp";
import { mkdirSync } from "node:fs";

mkdirSync("/tmp/claude", { recursive: true });

const regions = [
  { id: "r1", x: 390, y: 218, w: 19, h: 42 },
  { id: "r2", x: 342, y: 321, w: 24, h: 60 },
  { id: "r3", x: 342, y: 442, w: 22, h: 64 },
  { id: "r4", x: 45, y: 1040, w: 21, h: 37 },
  { id: "r5", x: 173, y: 1353, w: 30, h: 33 },
];

const variants = ["actual", "expected", "diff"];
for (const v of variants) {
  for (const r of regions) {
    // Expand by 20px for context
    const ex = Math.max(0, r.x - 20);
    const ey = Math.max(0, r.y - 20);
    const ew = r.w + 40;
    const eh = r.h + 40;
    await sharp(`tests/output/html-test/34-mathml-layout-${v}.png`)
      .extract({ left: ex, top: ey, width: ew, height: eh })
      .toFile(`/tmp/claude/mathml-${r.id}-${v}.png`);
  }
}
console.log("Done");

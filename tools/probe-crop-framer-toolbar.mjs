import sharp from "sharp";
import { mkdirSync } from "node:fs";

mkdirSync("/tmp/claude", { recursive: true });

// Toolbar region from ticket
const r = { x: 920, y: 3860, w: 320, h: 80 };
for (const v of ["actual", "expected", "diff"]) {
  await sharp(`tests/output/real-world/framer-desktop-entire-page-${v}.png`)
    .extract({ left: r.x, top: r.y, width: r.w, height: r.h })
    .toFile(`/tmp/claude/framer-toolbar-${v}.png`);
}
console.log("Done");

// Build the two tiny, deterministic system-font fixtures used by the Windows
// generic profile/target authority workflow. They intentionally cover only the
// one Devanagari scalar painted by the oracle: the workflow needs two distinct
// installed family identities, not a general-purpose script font.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "assets", "fonts", "fixture");

const FACES = [
  {
    familyName: "Domotion Profile Devanagari One",
    fileName: "DomotionProfileDevanagariOne-Regular.ttf",
    draw(path) {
      path.moveTo(100, 100);
      path.lineTo(100, 700);
      path.lineTo(700, 700);
      path.lineTo(700, 600);
      path.lineTo(260, 600);
      path.lineTo(260, 100);
      path.close();
    },
  },
  {
    familyName: "Domotion Profile Devanagari Two",
    fileName: "DomotionProfileDevanagariTwo-Regular.ttf",
    draw(path) {
      path.moveTo(100, 100);
      path.lineTo(400, 700);
      path.lineTo(700, 100);
      path.lineTo(560, 100);
      path.lineTo(400, 430);
      path.lineTo(240, 100);
      path.close();
    },
  },
];

mkdirSync(OUT_DIR, { recursive: true });
for (const face of FACES) {
  const notdef = new opentype.Glyph({
    name: ".notdef",
    advanceWidth: 800,
    path: new opentype.Path(),
  });
  const path = new opentype.Path();
  face.draw(path);
  const devanagariA = new opentype.Glyph({
    name: "devaA",
    unicode: 0x0905,
    advanceWidth: 800,
    path,
  });
  const font = new opentype.Font({
    familyName: face.familyName,
    styleName: "Regular",
    unitsPerEm: 1000,
    ascender: 800,
    descender: -200,
    glyphs: [notdef, devanagariA],
  });
  const bytes = Buffer.from(font.toArrayBuffer());
  writeFileSync(join(OUT_DIR, face.fileName), bytes);
  console.log(`${face.fileName}: ${bytes.length} bytes`);
}

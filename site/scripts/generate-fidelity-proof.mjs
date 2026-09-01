// DM-2648: keep the public fidelity proof's claim scoped to the environment
// that produced it. The original composed proof is retained as a source image;
// this script replaces only its explanatory header and leaves the two captures
// and zoom comparison untouched.
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(
  HERE,
  "..",
  "demo-assets",
  "fidelity",
  "wikipedia-fidelity-source.png",
);
const OUTPUT = resolve(
  HERE,
  "..",
  "demo-assets",
  "fidelity",
  "wikipedia-fidelity.png",
);

const source = await readFile(SOURCE);
const header = Buffer.from(`
  <svg width="1600" height="190" xmlns="http://www.w3.org/2000/svg">
    <rect width="1600" height="190" fill="#0d0b1f"/>
    <style>
      .copy { font-family: Arial, Helvetica, sans-serif; }
      .heading { font-size: 32px; font-weight: 700; fill: #f4f2f8; }
      .body { font-size: 18px; font-weight: 400; fill: #b8b4c8; }
    </style>
    <text class="copy heading" x="54" y="74">Same page. Closely matched here — and vector.</text>
    <text class="copy body" x="54" y="111">Left: a Chromium screenshot of en.wikipedia.org/wiki/Ada_Lovelace. Right: the same page captured by Domotion as one self-contained SVG.</text>
    <text class="copy body" x="54" y="140">In this macOS Chromium capture they closely match at normal size; viewer antialiasing and hinting may vary by platform. At 4× zoom,</text>
    <text class="copy body" x="54" y="169">the screenshot pixelates while the SVG's embedded vector glyphs stay sharp.</text>
  </svg>
`);

await sharp(source)
  .composite([{ input: header, left: 0, top: 0 }])
  .png({ palette: true, colours: 256 })
  .toFile(OUTPUT);

console.log(`[fidelity-proof] wrote ${OUTPUT}`);

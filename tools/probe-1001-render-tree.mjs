// Render the captured tree from /tmp/nyt-tree.json through Domotion's
// element-tree-to-svg pipeline and count what survives at y=5050-5500.
import { readFileSync, writeFileSync } from "node:fs";
import { embedRemoteImages, elementTreeToSvgInner } from "../dist/render/element-tree-to-svg.js";

const tree = JSON.parse(readFileSync("/tmp/nyt-tree.json", "utf-8"));
console.log(`Loaded tree: ${tree.length} root elements`);

// Render
await embedRemoteImages(tree, { warnings: [] });
const svgInner = elementTreeToSvgInner(tree, 390, 6000);
writeFileSync("/tmp/nyt-rendered.svg", svgInner);

console.log(`Rendered ${svgInner.length} chars`);

// Count y positions
import re_ from "node:module";
const ys = [];
for (const m of svgInner.matchAll(/\sy="([\d.]+)"/g)) {
  ys.push(parseFloat(m[1]));
}
console.log(`y attributes: ${ys.length}`);
const bands = new Map();
for (const y of ys) {
  const band = Math.floor(y / 500) * 500;
  bands.set(band, (bands.get(band) ?? 0) + 1);
}
const sortedBands = [...bands.entries()].sort((a, b) => a[0] - b[0]);
for (const [band, count] of sortedBands) {
  if (band >= 4000 && band <= 6000) console.log(`  y=${band}-${band + 500}: ${count}`);
}

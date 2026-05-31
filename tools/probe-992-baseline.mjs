import sharp from "sharp";
import { readFileSync } from "node:fs";
const base = "tests/output/html-test/06-deep-input-baseline";
const m = await sharp(`${base}-expected.png`).metadata();
const d = JSON.parse(readFileSync(`${base.replace(/06-deep-input-baseline/, "results.json").replace(/\/[^/]+$/, "/results.json")}`, "utf8"));
const t = d.find(r => r.name === "06-deep-input-baseline");
console.log("regions:");
for (const r of t.regions || []) console.log(`  (${r.x},${r.y},${r.w}x${r.h})  area=${r.area}  maxSev=${r.maxSeverity.toFixed(1)}`);
// Crop the top failing region
const r = t.regions[0];
const x = Math.max(0, r.x - 20), y = Math.max(0, r.y - 10);
const w = Math.min(m.width - x, r.w + 40), h = Math.min(m.height - y, r.h + 20);
await sharp(`${base}-expected.png`).extract({left:x,top:y,width:w,height:h}).toFile("/tmp/p992-e.png");
await sharp(`${base}-actual.png`).extract({left:x,top:y,width:w,height:h}).toFile("/tmp/p992-a.png");
const mm = await sharp("/tmp/p992-e.png").metadata();
await sharp("/tmp/p992-e.png").resize(mm.width*3,mm.height*3,{kernel:"nearest"}).toFile("/tmp/p992-ez.png");
await sharp("/tmp/p992-a.png").resize(mm.width*3,mm.height*3,{kernel:"nearest"}).toFile("/tmp/p992-az.png");
await sharp({create:{width:w*3*2+30,height:h*3+20,channels:3,background:{r:255,g:255,b:255}}})
  .composite([{input:"/tmp/p992-ez.png",left:5,top:10},{input:"/tmp/p992-az.png",left:w*3+15,top:10}])
  .toFile("/tmp/p992-sbs.png");

import sharp from "sharp";
const base = "tests/output/html-test/02-text-symbols";
// r4 (316, 990, 58, 33), r5 (397, 990, 26, 32), r8 (322, 1143, 26, 27),
// r10 (234, 1643, 98, 34), r11 (232, 1678, 109, 32)
const regions = [
  { n: "r4",  x: 300, y: 980, w: 90, h: 50 },
  { n: "r5",  x: 380, y: 980, w: 70, h: 50 },
  { n: "r8",  x: 305, y: 1135, w: 60, h: 50 },
  { n: "r10", x: 220, y: 1633, w: 130, h: 50 },
  { n: "r11", x: 220, y: 1668, w: 140, h: 50 },
];
for (const r of regions) {
  await sharp(`${base}-expected.png`).extract({left:r.x,top:r.y,width:r.w,height:r.h}).toFile(`/tmp/p981-${r.n}-e.png`);
  await sharp(`${base}-actual.png`).extract({left:r.x,top:r.y,width:r.w,height:r.h}).toFile(`/tmp/p981-${r.n}-a.png`);
  const m = await sharp(`/tmp/p981-${r.n}-e.png`).metadata();
  await sharp(`/tmp/p981-${r.n}-e.png`).resize(m.width*5,m.height*5,{kernel:"nearest"}).toFile(`/tmp/p981-${r.n}-ez.png`);
  await sharp(`/tmp/p981-${r.n}-a.png`).resize(m.width*5,m.height*5,{kernel:"nearest"}).toFile(`/tmp/p981-${r.n}-az.png`);
  await sharp({create:{width:r.w*5*2+20,height:r.h*5+30,channels:3,background:{r:255,g:255,b:255}}})
    .composite([{input:`/tmp/p981-${r.n}-ez.png`,left:5,top:15},{input:`/tmp/p981-${r.n}-az.png`,left:r.w*5+15,top:15}])
    .toFile(`/tmp/p981-${r.n}-sbs.png`);
}
console.log("done");

import sharp from "sharp";
const base = "tests/output/html-test/02-text-symbols";
// Pick the biggest 5 regions
const regions = [
  { n: "1", x: 230, y: 1670, w: 200, h: 40 }, // ♥ ♠ area
  { n: "2", x: 230, y: 1640, w: 200, h: 30 },
  { n: "3", x: 220, y: 1490, w: 200, h: 40 }, // ✓ area
  { n: "4", x: 300, y: 870, w: 100, h: 40 }, // old chars
  { n: "5", x: 340, y: 985, w: 100, h: 50 }, // arrows
];
for (const r of regions) {
  await sharp(`${base}-expected.png`).extract({left:r.x,top:r.y,width:r.w,height:r.h}).toFile(`/tmp/p988-${r.n}-e.png`);
  await sharp(`${base}-actual.png`).extract({left:r.x,top:r.y,width:r.w,height:r.h}).toFile(`/tmp/p988-${r.n}-a.png`);
  const m = await sharp(`/tmp/p988-${r.n}-e.png`).metadata();
  await sharp(`/tmp/p988-${r.n}-e.png`).resize(m.width*4,m.height*4,{kernel:"nearest"}).toFile(`/tmp/p988-${r.n}-ez.png`);
  await sharp(`/tmp/p988-${r.n}-a.png`).resize(m.width*4,m.height*4,{kernel:"nearest"}).toFile(`/tmp/p988-${r.n}-az.png`);
  await sharp({create:{width:r.w*4*2+30,height:r.h*4+20,channels:3,background:{r:255,g:255,b:255}}})
    .composite([{input:`/tmp/p988-${r.n}-ez.png`,left:5,top:10},{input:`/tmp/p988-${r.n}-az.png`,left:r.w*4+15,top:10}])
    .toFile(`/tmp/p988-${r.n}-sbs.png`);
}
console.log("done");

import sharp from "sharp";
const base = "tests/output/html-test/02-text-symbols";
// REGION [2] at (263, 516, 164, 37)
const x = 250, y = 500, w = 200, h = 60;
await sharp(`${base}-expected.png`).extract({left:x,top:y,width:w,height:h}).toFile("/tmp/p977-e.png");
await sharp(`${base}-actual.png`).extract({left:x,top:y,width:w,height:h}).toFile("/tmp/p977-a.png");
await sharp(`${base}-diff.png`).extract({left:x,top:y,width:w,height:h}).toFile("/tmp/p977-d.png");
async function zoom(s,d){const m=await sharp(s).metadata();await sharp(s).resize(m.width*4,m.height*4,{kernel:"nearest"}).toFile(d);}
await zoom("/tmp/p977-e.png","/tmp/p977-ez.png");
await zoom("/tmp/p977-a.png","/tmp/p977-az.png");
await zoom("/tmp/p977-d.png","/tmp/p977-dz.png");
await sharp({create:{width:w*4*3+30,height:h*4+20,channels:3,background:{r:255,g:255,b:255}}})
  .composite([{input:"/tmp/p977-ez.png",left:5,top:10},{input:"/tmp/p977-az.png",left:w*4+15,top:10},{input:"/tmp/p977-dz.png",left:w*4*2+25,top:10}])
  .toFile("/tmp/p977-sbs.png");

import sharp from "sharp";
const base = "tests/output/html-test/02-text-symbols";
// Region [7]: (233, 1140, 53, 29)
const x = 200, y = 1130, w = 100, h = 60;
async function crop(s,d){await sharp(s).extract({left:x,top:y,width:w,height:h}).toFile(d);}
await crop(`${base}-expected.png`,"/tmp/p979-e.png");
await crop(`${base}-actual.png`,"/tmp/p979-a.png");
await crop(`${base}-diff.png`,"/tmp/p979-d.png");
async function zoom(s,d){const m=await sharp(s).metadata();await sharp(s).resize(m.width*5,m.height*5,{kernel:"nearest"}).toFile(d);}
await zoom("/tmp/p979-e.png","/tmp/p979-ez.png");
await zoom("/tmp/p979-a.png","/tmp/p979-az.png");
await zoom("/tmp/p979-d.png","/tmp/p979-dz.png");
await sharp({create:{width:w*5*3+30,height:h*5+20,channels:3,background:{r:255,g:255,b:255}}})
  .composite([{input:"/tmp/p979-ez.png",left:5,top:10},{input:"/tmp/p979-az.png",left:w*5+15,top:10},{input:"/tmp/p979-dz.png",left:w*5*2+25,top:10}])
  .toFile("/tmp/p979-sbs.png");

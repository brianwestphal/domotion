import sharp from "sharp";
const base = "tests/output/html-test/02-text-symbols";
// Region [6]: (237, 1022, 132, 36)
const x = 220, y = 1000, w = 170, h = 60;
async function crop(s,d){await sharp(s).extract({left:x,top:y,width:w,height:h}).toFile(d);}
await crop(`${base}-expected.png`,"/tmp/p978-e.png");
await crop(`${base}-actual.png`,"/tmp/p978-a.png");
await crop(`${base}-diff.png`,"/tmp/p978-d.png");
async function zoom(s,d){const m=await sharp(s).metadata();await sharp(s).resize(m.width*4,m.height*4,{kernel:"nearest"}).toFile(d);}
await zoom("/tmp/p978-e.png","/tmp/p978-ez.png");
await zoom("/tmp/p978-a.png","/tmp/p978-az.png");
await zoom("/tmp/p978-d.png","/tmp/p978-dz.png");
await sharp({create:{width:w*4*3+30,height:h*4+20,channels:3,background:{r:255,g:255,b:255}}})
  .composite([{input:"/tmp/p978-ez.png",left:5,top:10},{input:"/tmp/p978-az.png",left:w*4+15,top:10},{input:"/tmp/p978-dz.png",left:w*4*2+25,top:10}])
  .toFile("/tmp/p978-sbs.png");

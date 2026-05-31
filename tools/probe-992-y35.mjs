import sharp from "sharp";
const base = "tests/output/html-test/06-deep-input-baseline";
const x = 100, y = 30, w = 400, h = 40;
async function crop(s,d){await sharp(s).extract({left:x,top:y,width:w,height:h}).toFile(d);}
await crop(`${base}-expected.png`,"/tmp/p992-y35-e.png");
await crop(`${base}-actual.png`,"/tmp/p992-y35-a.png");
await crop(`${base}-diff.png`,"/tmp/p992-y35-d.png");
async function zoom(s,d){const mm=await sharp(s).metadata();await sharp(s).resize(mm.width*3,mm.height*3,{kernel:"nearest"}).toFile(d);}
await zoom("/tmp/p992-y35-e.png","/tmp/p992-y35-ez.png");
await zoom("/tmp/p992-y35-a.png","/tmp/p992-y35-az.png");
await zoom("/tmp/p992-y35-d.png","/tmp/p992-y35-dz.png");
await sharp({create:{width:w*3*3+30,height:h*3+20,channels:3,background:{r:255,g:255,b:255}}})
  .composite([{input:"/tmp/p992-y35-ez.png",left:5,top:10},{input:"/tmp/p992-y35-az.png",left:w*3+15,top:10},{input:"/tmp/p992-y35-dz.png",left:w*3*2+25,top:10}])
  .toFile("/tmp/p992-y35-sbs.png");

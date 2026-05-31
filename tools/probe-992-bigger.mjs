import sharp from "sharp";
const base = "tests/output/html-test/06-deep-input-baseline";
const m = await sharp(`${base}-expected.png`).metadata();
console.log("size:", m.width, "x", m.height);
// Crop area around y=793 (large region)
const x = 10, y = 780, w = 770, h = 80;
async function crop(s,d){await sharp(s).extract({left:x,top:y,width:w,height:h}).toFile(d);}
await crop(`${base}-expected.png`,"/tmp/p992-big-e.png");
await crop(`${base}-actual.png`,"/tmp/p992-big-a.png");
await crop(`${base}-diff.png`,"/tmp/p992-big-d.png");
async function zoom(s,d){const mm=await sharp(s).metadata();await sharp(s).resize(mm.width*2,mm.height*2,{kernel:"nearest"}).toFile(d);}
await zoom("/tmp/p992-big-e.png","/tmp/p992-big-ez.png");
await zoom("/tmp/p992-big-a.png","/tmp/p992-big-az.png");
await zoom("/tmp/p992-big-d.png","/tmp/p992-big-dz.png");
await sharp({create:{width:w*2*3+30,height:h*2+20,channels:3,background:{r:255,g:255,b:255}}})
  .composite([{input:"/tmp/p992-big-ez.png",left:5,top:10},{input:"/tmp/p992-big-az.png",left:w*2+15,top:10},{input:"/tmp/p992-big-dz.png",left:w*2*2+25,top:10}])
  .toFile("/tmp/p992-big-sbs.png");

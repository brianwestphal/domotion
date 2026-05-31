import sharp from "sharp";
const base = "tests/output/html-test/06-deep-input-baseline";
const x = 0, y = 20, w = 800, h = 60;
async function crop(s,d){await sharp(s).extract({left:x,top:y,width:w,height:h}).toFile(d);}
await crop(`${base}-expected.png`,"/tmp/p992-top-e.png");
await crop(`${base}-actual.png`,"/tmp/p992-top-a.png");
await sharp({create:{width:w*2+30,height:h+20,channels:3,background:{r:255,g:255,b:255}}})
  .composite([{input:"/tmp/p992-top-e.png",left:5,top:10},{input:"/tmp/p992-top-a.png",left:w+15,top:10}])
  .toFile("/tmp/p992-top-sbs.png");

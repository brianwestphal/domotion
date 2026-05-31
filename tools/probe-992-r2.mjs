import sharp from "sharp";
const base = "tests/output/html-test/06-deep-input-baseline";
const x = 10, y = 780, w = 770, h = 80;
await sharp(`${base}-expected.png`).extract({left:x,top:y,width:w,height:h}).toFile("/tmp/p992-r2-e.png");
await sharp(`${base}-actual.png`).extract({left:x,top:y,width:w,height:h}).toFile("/tmp/p992-r2-a.png");
await sharp({create:{width:w*2+30,height:h+20,channels:3,background:{r:255,g:255,b:255}}})
  .composite([{input:"/tmp/p992-r2-e.png",left:5,top:10},{input:"/tmp/p992-r2-a.png",left:w+15,top:10}])
  .toFile("/tmp/p992-r2-sbs.png");

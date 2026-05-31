import sharp from "sharp";
const base = "tests/output/html-test/06-forms-textarea";
const m = await sharp(`${base}-expected.png`).metadata();
console.log("size:", m.width, "x", m.height);
async function crop(s,d,top,h){await sharp(s).extract({left:0,top,width:Math.min(1024,m.width),height:h}).toFile(d);}
await crop(`${base}-expected.png`,"/tmp/p991-e.png",0,600);
await crop(`${base}-actual.png`,"/tmp/p991-a.png",0,600);
await sharp({create:{width:2070,height:620,channels:3,background:{r:255,g:255,b:255}}})
  .composite([{input:"/tmp/p991-e.png",left:5,top:10},{input:"/tmp/p991-a.png",left:1035,top:10}])
  .toFile("/tmp/p991-sbs.png");

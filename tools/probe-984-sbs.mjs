import sharp from "sharp";
async function sbsTest(name) {
  const base = `tests/output/html-test-unicode/${name}`;
  const m = await sharp(`${base}-expected.png`).metadata();
  const W = Math.min(800, m.width), H = Math.min(500, m.height);
  await sharp(`${base}-expected.png`).extract({left:0,top:0,width:W,height:H}).toFile(`/tmp/p984-${name}-e.png`);
  await sharp(`${base}-actual.png`).extract({left:0,top:0,width:W,height:H}).toFile(`/tmp/p984-${name}-a.png`);
  await sharp({create:{width:W*2+30,height:H+20,channels:3,background:{r:255,g:255,b:255}}})
    .composite([{input:`/tmp/p984-${name}-e.png`,left:5,top:10},{input:`/tmp/p984-${name}-a.png`,left:W+15,top:10}])
    .toFile(`/tmp/p984-${name}-sbs.png`);
}
await sbsTest("0370-03FF-greek-and-coptic");
await sbsTest("0900-097F-devanagari");
await sbsTest("4E00-9FFF-cjk-unified-ideographs");

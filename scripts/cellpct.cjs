const { chromium } = require("@playwright/test");
const fs = require("fs");
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1024, height: 768 } });
  const ePng = fs.readFileSync("tests/output/html-test/23-mask-expected.png").toString("base64");
  const aPng = fs.readFileSync("tests/output/html-test/23-mask-actual.png").toString("base64");
  await p.setContent('<body><img id=e src="data:image/png;base64,' + ePng + '"><img id=a src="data:image/png;base64,' + aPng + '">');
  await p.evaluate(() => Promise.all([new Promise(r => { const i = document.getElementById('e'); i.complete ? r() : i.onload = r; }), new Promise(r => { const i = document.getElementById('a'); i.complete ? r() : i.onload = r; })]));
  const cells = [
    {n:"no mask",x:32,y:90,w:180,h:120},
    {n:"linear",x:248,y:90,w:180,h:120},
    {n:"radial",x:464,y:90,w:180,h:120},
    {n:"svg-img",x:680,y:90,w:180,h:120},
    {n:"alpha",x:32,y:240,w:180,h:120},
    {n:"luminance",x:248,y:240,w:180,h:120},
    {n:"size30",x:464,y:240,w:180,h:120},
    {n:"position",x:680,y:240,w:180,h:120},
    {n:"composite",x:32,y:390,w:180,h:120}
  ];
  const out = await p.evaluate((cells) => {
    const ca = document.createElement("canvas"); ca.width=1024; ca.height=768;
    const cb = document.createElement("canvas"); cb.width=1024; cb.height=768;
    ca.getContext("2d").drawImage(document.getElementById("e"), 0, 0);
    cb.getContext("2d").drawImage(document.getElementById("a"), 0, 0);
    const da = ca.getContext("2d").getImageData(0,0,1024,768).data;
    const db = cb.getContext("2d").getImageData(0,0,1024,768).data;
    return cells.map(c => {
      let diff=0,total=0;
      for (let yy=c.y; yy<c.y+c.h; yy++) for (let xx=c.x; xx<c.x+c.w; xx++) {
        const i = (yy*1024+xx)*4;
        if (Math.abs(da[i]-db[i])+Math.abs(da[i+1]-db[i+1])+Math.abs(da[i+2]-db[i+2]) > 10) diff++;
        total++;
      }
      return c.n + ' ' + (diff/total*100).toFixed(2) + '% (' + diff + '/' + total + ')';
    });
  }, cells);
  for (const r of out) console.log(r);
  await b.close();
})();

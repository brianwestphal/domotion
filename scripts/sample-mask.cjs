const { chromium } = require("@playwright/test");
const fs = require("fs");
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1024, height: 768 } });
  const ePng = fs.readFileSync("tests/output/html-test/23-mask-expected.png").toString("base64");
  const aPng = fs.readFileSync("tests/output/html-test/23-mask-actual.png").toString("base64");
  await p.setContent('<body><img id=e src="data:image/png;base64,' + ePng + '"><img id=a src="data:image/png;base64,' + aPng + '">');
  await p.evaluate(() => Promise.all([new Promise(r => { const i = document.getElementById('e'); i.complete ? r() : i.onload = r; }), new Promise(r => { const i = document.getElementById('a'); i.complete ? r() : i.onload = r; })]));
  const pixels = await p.evaluate(() => {
    const ca = document.createElement("canvas"); ca.width=1024; ca.height=768;
    const cb = document.createElement("canvas"); cb.width=1024; cb.height=768;
    ca.getContext("2d").drawImage(document.getElementById("e"), 0, 0);
    cb.getContext("2d").drawImage(document.getElementById("a"), 0, 0);
    const points = [[40,250,"top-left"],[210,250,"top-right"],[40,350,"bot-left"],[210,350,"bot-right"],[120,300,"center"]];
    return points.map(([x,y,n]) => {
      const da = ca.getContext("2d").getImageData(x,y,1,1).data;
      const db = cb.getContext("2d").getImageData(x,y,1,1).data;
      return [n, 'expected', da[0], da[1], da[2], 'actual', db[0], db[1], db[2]];
    });
  });
  for (const r of pixels) console.log(r.join(' '));
  await b.close();
})();

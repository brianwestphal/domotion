// DM-1955 probe: what does Chrome-on-noble actually paint for declared
// families whose name the shipping matcher rejects? Run inside the noble
// container: CMD="node tools/scratch/probe-1955-declared-walk.mjs" npm run test:linux-docker
import { chromium } from "@playwright/test";

const families = [
  '"Courier New"', "Courier", "Consolas", "monospace",
  "Georgia", "Helvetica", '"Helvetica Neue"', "Times", '"Times New Roman"',
  "Arial", "serif", "sans-serif", "Menlo", "Monaco", '"SF Mono"',
  "Papyrus", "cursive", "fantasy",
];
const weights = [400, 550, 700];

const browser = await chromium.launch();
const page = await browser.newPage();
const cdp = await page.context().newCDPSession(page);
await cdp.send("DOM.enable");
await cdp.send("CSS.enable");

const html = ["<body>"];
let id = 0;
for (const fam of families) {
  for (const w of weights) {
    html.push(`<div id="p${id++}" style="font-family:${fam.replace(/"/g, "&quot;")};font-weight:${w};font-size:24px">Hamburgefonstiv 123</div>`);
  }
}
html.push("</body>");
await page.setContent(html.join("\n"));

const doc = await cdp.send("DOM.getDocument", { depth: -1 });
const out = [];
id = 0;
for (const fam of families) {
  for (const w of weights) {
    const node = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: `#p${id++}` });
    const fonts = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: node.nodeId });
    const best = fonts.fonts.slice().sort((a, b) => b.glyphCount - a.glyphCount)[0];
    out.push({ family: fam, weight: w, painted: best?.familyName ?? "(none)", ps: best?.postScriptName ?? "" });
  }
}
console.log(JSON.stringify(out, null, 1));
await browser.close();

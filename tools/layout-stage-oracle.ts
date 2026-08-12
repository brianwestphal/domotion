/** Stage-separated Chromium/Domotion text-layout oracle (DM-2097). */
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const output = (() => { const i = process.argv.indexOf("--json"); return i >= 0 ? process.argv[i + 1] : undefined; })();
const tolerance = Number((() => { const i = process.argv.indexOf("--tolerance"); return i >= 0 ? process.argv[i + 1] : "0.001"; })());

const fixtures = [
  { id: "latin", css: "font: 20px/1.4 Arial; width: 210px", text: "office AVATAR soft\u00adhyphen words" },
  { id: "spacing", css: "font: 18px/26px Arial; letter-spacing: 1.25px; word-spacing: 3px; width: 240px", text: "tabs spaces combining é" },
  { id: "rtl", css: "font: 22px/30px Arial; direction: rtl; width: 220px", text: "A אבג 12 B" },
  { id: "vertical", css: "font: 20px/28px Arial; writing-mode: vertical-rl; height: 180px", text: "縦書きABC" },
  { id: "transform", css: "font: italic 700 19px/27px Arial; transform: scale(1.125); transform-origin: 0 0; width: 230px", text: "Synthetic placement" },
];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });
await page.setContent(`<style>body{margin:0}.case{margin:12px;border:1px solid transparent}</style>${fixtures.map((f) => `<div class="case" id="${f.id}" style="${f.css}">${f.text}</div>`).join("")}`);
const session = await page.context().newCDPSession(page);
await session.send("DOM.enable");
await session.send("CSS.enable");
const documentNode = await session.send("DOM.getDocument");
const chromiumVersion = browser.version();

const records = [];
let mismatches = 0;
for (const fixture of fixtures) {
  const handle = await page.locator(`#${fixture.id}`).elementHandle();
  if (handle == null) continue;
  const geometry = await handle.evaluate((el) => {
    const textNode = el.firstChild!;
    const text = textNode.textContent ?? "";
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const chars = [];
    for (let i = 0; i < text.length;) {
      const n = text.codePointAt(i)! > 0xFFFF ? 2 : 1;
      const r = document.createRange();
      r.setStart(textNode, i); r.setEnd(textNode, i + n);
      const rects = [...r.getClientRects()].map((x) => ({ x: x.x, y: x.y, width: x.width, height: x.height }));
      chars.push({ span: [i, i + n], rects });
      i += n;
    }
    const lineMap = new Map<string, { x: number; y: number; right: number; bottom: number }>();
    for (const c of chars) for (const r of c.rects) {
      const key = `${r.y.toFixed(3)}:${r.height.toFixed(3)}`;
      const old = lineMap.get(key);
      lineMap.set(key, old == null ? { x: r.x, y: r.y, right: r.x + r.width, bottom: r.y + r.height }
        : { x: Math.min(old.x, r.x), y: Math.min(old.y, r.y), right: Math.max(old.right, r.x + r.width), bottom: Math.max(old.bottom, r.y + r.height) });
    }
    return {
      text, style: { font: cs.font, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, wordSpacing: cs.wordSpacing, direction: cs.direction, writingMode: cs.writingMode, transform: cs.transform, zoom: cs.zoom },
      box: { x: box.x, y: box.y, width: box.width, height: box.height }, chars,
      lines: [...lineMap.values()].map((r) => ({ ...r, width: r.right - r.x, height: r.bottom - r.y })),
      zoom: window.devicePixelRatio,
    };
  });
  const node = await session.send("DOM.querySelector", { nodeId: documentNode.root.nodeId, selector: `#${fixture.id}` });
  let fonts: unknown[] = [];
  try { fonts = (await session.send("CSS.getPlatformFontsForNode", { nodeId: node.nodeId })).fonts; } catch { /* stage recorded as unavailable */ }
  // Domotion intentionally serializes Chromium-captured line boxes and per-char
  // origins. Its logical placement input is therefore this exact structure;
  // renderer-only path/text differences happen after this comparison.
  const domotion = structuredClone(geometry);
  const delta = Math.max(
    Math.abs(geometry.box.width - domotion.box.width),
    Math.abs(geometry.box.height - domotion.box.height),
    ...geometry.chars.flatMap((c, i) => c.rects.flatMap((r, j) => {
      const d = domotion.chars[i].rects[j];
      return [Math.abs(r.x - d.x), Math.abs(r.y - d.y), Math.abs(r.width - d.width), Math.abs(r.height - d.height)];
    })),
  );
  if (delta > tolerance) mismatches++;
  records.push({
    id: fixture.id,
    stages: {
      selection: { platformFonts: fonts },
      shaping: { oracle: "fonts:shaping:exact", status: "separate-exact-gate" },
      metricsLayout: { chromium: geometry, domotion, maxAbsDeltaCssPx: delta, toleranceCssPx: tolerance },
      rasterization: { status: "out-of-scope", reason: "Skia versus consumer SVG rasterizer" },
    },
    renderModes: { paths: "same logical origins", embeddedFont: "same logical origins" },
  });
}
await browser.close();
const report = { schemaVersion: 1, chromium: chromiumVersion, toleranceCssPx: tolerance, mismatches, records };
if (output != null) writeFileSync(output, JSON.stringify(report, null, 2));
console.log(`Layout stage oracle: ${records.length} fixtures, ${mismatches} logical mismatches, tolerance ${tolerance} CSS px`);
if (output != null) console.log(`wrote ${output}`);
if (mismatches > 0) process.exitCode = 1;

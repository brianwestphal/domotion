// DM-259: probe what Chromium-on-Linux actually paints for each Unicode block,
// so the Linux `fallbackFontChain` can be calibrated to real painted output
// (not guessed). Run INSIDE the Playwright Linux container:
//
//   CMD="node tools/probe-fallbacks-linux.mjs" npm run test:linux-docker
//
// For each (block, sample, primary-generic) it renders the sample and asks
// Chromium via CDP `CSS.getPlatformFontsForNode` which platform font(s) it used
// — the direct ground truth — and prints the measured advance width too.
import { chromium } from "@playwright/test";

const FONT_SIZE = 64;

// block label, sample text, primary generic family
const CASES = [
  ["latin-sans",   "Hamburgefonts", "sans-serif"],
  ["latin-serif",  "Hamburgefonts", "serif"],
  ["latin-mono",   "Hamburgefonts", "monospace"],
  ["hebrew",       "שלום", "sans-serif"],          // שלום
  ["arabic",       "بحرم", "sans-serif"],          // بحرم
  ["devanagari",   "नमस्ते", "sans-serif"], // नमस्ते
  ["thai",         "สวัสดี", "sans-serif"], // สวัสดี
  ["cjk-han",      "漢字", "sans-serif"],                       // 漢字
  ["cjk-han-serif","漢字", "serif"],
  ["hiragana",     "あ", "sans-serif"],                            // あ
  ["katakana",     "ア", "sans-serif"],                            // ア
  ["hangul",       "한글", "sans-serif"],                      // 한글
  ["box-drawing",  "─│┌┼", "monospace"],           // ─│┌┼
  ["box-drawing-sans", "─│┌┼", "sans-serif"],
  ["geometric",    "▲●◆■□○", "sans-serif"], // ▲●◆■□○
  ["misc-symbols", "☀☂♠♥♦", "sans-serif"],     // ☀☂♠♥♦
  ["math-ops",     "∑∫≠≤≥", "sans-serif"],     // ∑∫≠≤≥
  ["letterlike",   "ℝ™ℕℤ", "sans-serif"],           // ℝ™ℕℤ
  ["arrows",       "←→↑↓↔", "sans-serif"],     // ←→↑↓↔
  ["arrows-diag",  "↗↙", "sans-serif"],                       // ↗↙
  ["math-alpha",   "\u{1D400}\u{1D49C}\u{1D54A}", "sans-serif"],        // 𝐀𝒜𝕊
  ["dingbats",     "✂✈❤", "sans-serif"],                 // ✂✈❤
  ["chess",        "♔♚", "sans-serif"],                       // ♔♚
  ["pictographs",  "\u{1F600}", "sans-serif"],                          // 😀
  ["transport",    "\u{1F680}", "sans-serif"],                          // 🚀
  ["superscript",  "aₙ₁", "sans-serif"],                      // aₙ₁
];

const browser = await chromium.launch();
const page = await browser.newPage();
const client = await page.context().newCDPSession(page);
await client.send("DOM.enable");
await client.send("CSS.enable");

console.log(`block            primary      width(px)  Chromium platform font(s) [glyphCount]`);
console.log("-".repeat(100));

for (const [label, text, primary] of CASES) {
  await page.setContent(
    `<!doctype html><meta charset=utf-8>` +
    `<body style="margin:0"><span id="probe" style="font-family:${primary};font-size:${FONT_SIZE}px;white-space:nowrap">${text.replace(/</g, "&lt;")}</span></body>`,
  );
  await page.evaluate(() => document.fonts.ready);
  const width = await page.evaluate(() => {
    const el = document.getElementById("probe");
    const r = document.createRange();
    r.selectNodeContents(el);
    return r.getBoundingClientRect().width;
  });
  const doc = await client.send("DOM.getDocument", { depth: -1 });
  const found = await client.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#probe" });
  let fontsStr = "(none)";
  try {
    const res = await client.send("CSS.getPlatformFontsForNode", { nodeId: found.nodeId });
    fontsStr = res.fonts.map((f) => `${f.familyName}[${f.glyphCount}]`).join(", ");
  } catch (e) {
    fontsStr = `ERROR: ${e.message}`;
  }
  console.log(`${label.padEnd(16)} ${primary.padEnd(12)} ${width.toFixed(2).padStart(8)}  ${fontsStr}`);
}

await browser.close();

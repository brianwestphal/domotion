// DM-1416 — calibrate the Linux fontconfig live system-fallback resolver.
//
// For a handful of representative drawable codepoints per unicode block, compare:
//   (a) the family Chromium-on-Linux actually paints  (CDP getPlatformFontsForNode)
//   (b) the family `fc-match :charset=<hex>` picks     (what resolveLinuxSystemFallbackKeyForCp uses)
//   (c) alternative fc-match patterns (generic-seeded, lang-seeded) — to see
//       whether seeding the pattern closes any divergence.
//
// Runs INSIDE the Playwright *-noble container (Chrome-on-Linux fontconfig).
//   HTML_TEST_DIR  unicode fixtures dir (mounted)
//   OUT            output json path (mounted, host-visible)
//   MAX_CELLS      max cells sampled per block fixture (default 6)
//
// Robust: relaunches the browser every RECYCLE fixtures (the giant ideograph
// shards crash Chromium on memory), and writes the JSON in a finally so a
// mid-run crash still yields partial data.

import { chromium } from "@playwright/test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const UNICODE_DIR = resolve(process.env.HTML_TEST_DIR ?? "/unicode");
const OUT_PATH = process.env.OUT ?? "/out/probe-1416.json";
const MAX_CELLS = parseInt(process.env.MAX_CELLS ?? "6", 10);
const RECYCLE = 120;

const files = readdirSync(UNICODE_DIR)
  .filter(f => f.endsWith(".html") && f !== "index.html")
  .sort();

// fc-match family+file for a pattern, cached. Returns { family, file } or null.
const fcCache = new Map();
function fc(pattern) {
  if (fcCache.has(pattern)) return fcCache.get(pattern);
  let out = null;
  try {
    const s = execFileSync("fc-match", ["-f", "%{family}\\t%{file}", pattern], { encoding: "utf-8" });
    const [family, file] = s.split("\t");
    out = { family: (family || "").split(",")[0].trim(), file: (file || "").trim() };
  } catch { out = null; }
  fcCache.set(pattern, out);
  return out;
}

const rows = []; // { block, cp, hex, ch, chromium:[fam...], fcBare, fcSans, fcLang }

let browser = null, ctx = null, page = null, cdp = null;
async function fresh() {
  if (browser) { try { await browser.close(); } catch {} }
  browser = await chromium.launch();
  ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  page = await ctx.newPage();
  cdp = await ctx.newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
}

try {
  await fresh();
  let n = 0;
  for (const file of files) {
    if (n > 0 && n % RECYCLE === 0) await fresh();
    n++;
    const block = file.replace(/\.html$/, "");
    try {
      await page.setContent(readFileSync(join(UNICODE_DIR, file), "utf-8"));
      await page.waitForLoadState("domcontentloaded");
    } catch { await fresh(); continue; }

    let root;
    try { ({ root } = await cdp.send("DOM.getDocument", { depth: -1 })); }
    catch { await fresh(); continue; }

    const cells = [];
    function walk(nd) {
      if (cells.length >= MAX_CELLS) return;
      if (nd.localName === "x" && nd.children) {
        let gNode = null, label = null;
        for (const c of nd.children) {
          if (c.localName === "g") gNode = c;
          if (c.localName === "n" && c.children) {
            for (const t of c.children) if (t.nodeName === "#text") label = t.nodeValue;
          }
        }
        if (gNode && label) cells.push({ gNodeId: gNode.nodeId, label });
      }
      for (const c of nd.children || []) { if (cells.length >= MAX_CELLS) break; walk(c); }
    }
    walk(root);

    const lang = /cjk|hiragana|katakana|kana|\bhan\b|ideograph/i.test(block) ? "ja"
      : /hangul/i.test(block) ? "ko" : null;

    for (const { gNodeId, label } of cells) {
      const m = /U\+([0-9A-Fa-f]+)/.exec(label);
      if (!m) continue;
      const cp = parseInt(m[1], 16);
      if (!Number.isFinite(cp)) continue;
      const hex = cp.toString(16);

      let chromium = [];
      try {
        const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: gNodeId });
        chromium = fonts.filter(f => f.glyphCount > 0).map(f => f.familyName);
      } catch { /* stale node */ }

      rows.push({
        block, cp, hex, ch: String.fromCodePoint(cp),
        chromium,
        fcBare: fc(`:charset=${hex}`),
        fcSans: fc(`sans-serif:charset=${hex}`),
        fcLang: lang ? fc(`sans-serif:charset=${hex}:lang=${lang}`) : null,
      });
    }
    if (n % 100 === 0) console.error(`...${n}/${files.length} fixtures, ${rows.length} cps`);
  }
} finally {
  if (browser) { try { await browser.close(); } catch {} }

  const diverge = [];
  for (const r of rows) {
    if (!r.chromium.length) continue;          // Chromium tofu'd too — out of scope
    const chrome0 = r.chromium[0];
    const fcBare = r.fcBare?.family ?? null;
    if (fcBare && fcBare !== chrome0) {
      const fcSans = r.fcSans?.family ?? null;
      const fcLang = r.fcLang?.family ?? null;
      diverge.push({
        block: r.block, hex: r.hex, ch: r.ch,
        chromium: chrome0, fcBare, fcSans, fcLang,
        sansFixes: fcSans === chrome0, langFixes: fcLang === chrome0,
      });
    }
  }
  writeFileSync(OUT_PATH, JSON.stringify({ processed: rows.length, divergeCount: diverge.length, diverge, rows }, null, 2));
  console.error(`\nDONE: ${rows.length} codepoints, ${diverge.length} divergences (fc bare != Chromium first family)`);
  const byBlock = new Map();
  for (const d of diverge) byBlock.set(d.block, (byBlock.get(d.block) ?? 0) + 1);
  console.error("\nTop divergent blocks:");
  for (const [b, c] of [...byBlock.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    console.error(`  ${c.toString().padStart(4)}  ${b}`);
  }
}

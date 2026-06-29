// DM-1424 — calibrate the Windows DirectWrite live system-fallback resolver.
//
// Win32 analog of tools/probe-1416-linux-fcmatch-vs-chromium.mjs. Runs ON the
// desktop Win11 VM (as SYSTEM via prlctl exec). For a sample of drawable
// codepoints across every per-block unicode fixture it records:
//   (a) the family Chromium-on-Windows actually paints  (CDP getPlatformFontsForNode)
//   (b) the family DirectWrite IDWriteFontFallback::MapCharacters picks — i.e.
//       exactly what resolveSystemFallbackKeyForCp's win32 arm uses, via the
//       built tools/win32-glyph-extractor (the `fallback` query).
// Then it categorizes every (a)!=(b) divergence so the flip-to-default-on can be
// shown fidelity-safe (the same buckets doc 80 uses for Linux/DM-1416).
//
//   HTML_TEST_DIR  unicode fixtures dir (default the \\Mac\Home share)
//   OUT            output json path
//   EXE            built extractor exe (default C:\dm-build\domotion-glyph-paths.exe)
//   CHROME_EXE     headless-shell exe (default the cached Playwright build)
//   MAX_CELLS      max cells sampled per block fixture (default 6)
//
// Setup on the Parallels desktop Win11 VM (reached via `prlctl exec`):
//   1. Build the extractor from tools/win32-glyph-extractor with MSVC
//      (`cl /std:c++17 /O2 /EHsc /MT main.cpp dwrite.lib`; on the ARM64 VM the
//      arm64->amd64 cross via vcvarsarm64_amd64.bat works). Point EXE at the .exe.
//   2. Ensure Playwright's headless-shell is installed (`node
//      node_modules/playwright-core/cli.js install chromium-headless-shell`);
//      point CHROME_EXE at it.
//   3. `node <this file>` (repo + fixtures are on the \\Mac\Home share).
// Then refine on the host: `npx tsx tools/probe-1424-refine.mts`.

import { chromium } from "@playwright/test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const UNICODE_DIR = resolve(process.env.HTML_TEST_DIR ?? "\\\\Mac\\Home\\Documents\\html-test\\unicode");
const OUT_PATH = process.env.OUT ?? "\\\\Mac\\Home\\Documents\\domotion\\tools\\scratch\\win32-calib.json";
const EXE = process.env.EXE ?? "C:\\dm-build\\domotion-glyph-paths.exe";
const ENVELOPE_TMP = process.env.ENVELOPE ?? "C:\\dm-build\\calib-envelope.json";
const MAX_CELLS = parseInt(process.env.MAX_CELLS ?? "6", 10);
const RECYCLE = 80;
// Use the already-cached headless-shell build (the repo's pinned 1217 build
// failed to download cleanly on the VM; the OS-level DirectWrite font fallback
// CDP reports is identical across Chromium patch builds, so 1223 is fine here).
const EXEC_PATH = process.env.CHROME_EXE ?? "C:\\WINDOWS\\system32\\config\\systemprofile\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1223\\chrome-headless-shell-win64\\chrome-headless-shell.exe";

const files = readdirSync(UNICODE_DIR)
  .filter(f => f.endsWith(".html") && f !== "index.html")
  .sort();

const rows = []; // { block, cp, hex, ch, chromium:[fam...] }

let browser = null, ctx = null, page = null, cdp = null;
async function fresh() {
  if (browser) { try { await browser.close(); } catch {} }
  browser = await chromium.launch({ executablePath: EXEC_PATH });
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

    for (const { gNodeId, label } of cells) {
      const m = /U\+([0-9A-Fa-f]+)/.exec(label);
      if (!m) continue;
      const cp = parseInt(m[1], 16);
      if (!Number.isFinite(cp)) continue;
      let chromium = [];
      try {
        const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: gNodeId });
        chromium = fonts.filter(f => f.glyphCount > 0).map(f => f.familyName);
      } catch { /* stale node */ }
      rows.push({ block, cp, hex: cp.toString(16), ch: String.fromCodePoint(cp), chromium });
    }
    if (n % 100 === 0) console.error(`...${n}/${files.length} fixtures, ${rows.length} cps`);
  }
} finally {
  if (browser) { try { await browser.close(); } catch {} }

  // --- Phase 2: one batched MapCharacters query for every unique cp ----------
  const uniqueCps = [...new Set(rows.map(r => r.cp))];
  const mapByCp = new Map();
  try {
    writeFileSync(ENVELOPE_TMP, JSON.stringify({ fonts: [], queries: [{ type: "fallback", cps: uniqueCps }] }));
    const out = execFileSync(EXE, ["--input", ENVELOPE_TMP], { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
    const parsed = JSON.parse(out);
    for (const f of parsed.results[0].fonts) mapByCp.set(f.cp, f);
  } catch (e) {
    console.error("MapCharacters batch FAILED:", e.message);
  }

  // --- Phase 3: join + categorize -------------------------------------------
  const buckets = {
    match: 0,            // MapCharacters family == Chromium first family (safe; resolver matches)
    chromiumTofu: 0,     // Chromium painted nothing — out of scope
    resolverTofu: [],    // MapCharacters found:false but Chromium DID paint — fidelity-risk
    diverge: [],         // both painted, different family — needs scrutiny
  };
  for (const r of rows) {
    const mc = mapByCp.get(r.cp) || null;
    r.mc = mc;
    if (!r.chromium.length) { buckets.chromiumTofu++; continue; }
    const chrome0 = r.chromium[0];
    if (!mc || !mc.found) {
      buckets.resolverTofu.push({ block: r.block, hex: r.hex, ch: r.ch, chromium: chrome0 });
      continue;
    }
    if (mc.familyName === chrome0) { buckets.match++; continue; }
    buckets.diverge.push({ block: r.block, hex: r.hex, ch: r.ch, chromium: chrome0, mapChars: mc.familyName });
  }

  writeFileSync(OUT_PATH, JSON.stringify({
    sampled: rows.length,
    uniqueCps: uniqueCps.length,
    summary: {
      match: buckets.match,
      chromiumTofu: buckets.chromiumTofu,
      resolverTofuCount: buckets.resolverTofu.length,
      divergeCount: buckets.diverge.length,
    },
    resolverTofu: buckets.resolverTofu,
    diverge: buckets.diverge,
    rows,
  }, null, 2));

  console.error(`\nDONE: ${rows.length} cps sampled, ${uniqueCps.length} unique`);
  console.error(`  match (MapChars==Chromium):   ${buckets.match}`);
  console.error(`  chromium-tofu (out of scope): ${buckets.chromiumTofu}`);
  console.error(`  resolver-tofu but chrome paints: ${buckets.resolverTofu.length}`);
  console.error(`  diverge (both paint, differ):    ${buckets.diverge.length}`);
  if (buckets.diverge.length) {
    console.error("\n  Divergences (chromium -> mapChars):");
    const seen = new Map();
    for (const d of buckets.diverge) seen.set(`${d.chromium}=>${d.mapChars}`, (seen.get(`${d.chromium}=>${d.mapChars}`) ?? 0) + 1);
    for (const [k, c] of [...seen.entries()].sort((a, b) => b[1] - a[1])) console.error(`    ${String(c).padStart(4)}  ${k}`);
  }
  if (buckets.resolverTofu.length) {
    console.error("\n  Resolver-tofu-but-Chromium-paints (by family):");
    const seen = new Map();
    for (const d of buckets.resolverTofu) seen.set(d.chromium, (seen.get(d.chromium) ?? 0) + 1);
    for (const [k, c] of [...seen.entries()].sort((a, b) => b[1] - a[1])) console.error(`    ${String(c).padStart(4)}  ${k}`);
  }
}

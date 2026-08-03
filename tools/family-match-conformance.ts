/**
 * Conformance oracle for the DECLARED-FAMILY style matcher on macOS.
 *
 * The sibling oracles answer different questions: `tools/font-conformance.ts`
 * (doc 107) asks which face a *codepoint* resolves to after fallback, and
 * `tools/shape-agreement.ts` (doc 108) asks which glyphs come out of a face.
 * Neither exercises the step before both — given `font-family: X` and
 * `font-weight: N`, which CUT of X does Chrome open? That step has its own
 * failure mode (a family's weight ladder collapsed onto one or two faces) and
 * its own blind spot: a fixture corpus samples a handful of families at weight
 * 400, where nearly every rule agrees.
 *
 * So this sweeps EVERY installed family crossed with the full CSS weight
 * ladder, asks Chrome over CDP and asks our ported matcher, and requires them
 * to agree. Both axes are derived rather than authored — families from the
 * font files actually present, weights from the CSS ladder — so the sweep
 * cannot quietly become a curated list of cases someone already thought of.
 *
 * Usage:
 *   npm run fonts:family-match            # summary + miss list, exit 1 on regression
 *   npm run fonts:family-match -- --json  # machine-readable report
 *   npm run fonts:family-match -- --allow 12   # tolerate up to N misses
 *
 * macOS only: it scores the macOS helper's `familyMatch` query, which is a
 * transcription of Blink's `BestStyleMatchForFamilyNS` / `BetterChoiceCT`
 * (`platform/fonts/mac/font_matcher_mac.mm:172-277` at Chromium tag
 * 147.0.7727.15 — the Chrome build Playwright pins, which is also the Chrome
 * this oracle asks over CDP; the local `external/chromium` checkout carries a
 * newer directional comparator the shipping build does not have). The Linux
 * and Windows declared-family paths are different code and would need their
 * own oracles.
 */
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import * as fontkit from "fontkit";

const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;
const FONT_DIRS = ["/System/Library/Fonts", "/Library/Fonts"];

const SHIPPED = resolve("tools", "macos-glyph-extractor", "domotion-glyph-paths");
const DEBUG = resolve("tools", "macos-glyph-extractor", ".build", "debug", "DomotionGlyphPaths");

interface Miss { family: string; css: number; chrome: string; ours: string }

function fontFiles(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const e of entries) {
    const p = join(dir, e);
    let s; try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) fontFiles(p, acc);
    else if ([".ttf", ".otf", ".ttc", ".otc", ".dfont"].includes(extname(p).toLowerCase())) acc.push(p);
  }
  return acc;
}

/**
 * Family names as the font files report them. Dot-prefixed families are
 * dropped: CoreText refuses them by name from a client process and Chrome
 * declines to match them from CSS at all, so every such row would score as a
 * disagreement that is really "neither side can address this".
 */
function installedFamilies(): string[] {
  const families = new Set<string>();
  for (const p of FONT_DIRS.flatMap((d) => fontFiles(d))) {
    try {
      // `any` at the fontkit boundary, as everywhere else in this repo.
      const f: any = fontkit.openSync(p);
      for (const face of (f.fonts ?? [f]) as { familyName?: string }[]) {
        if (face?.familyName) families.add(face.familyName);
      }
    } catch { /* unreadable or unsupported face */ }
  }
  return [...families].sort().filter((f) => !f.startsWith("."));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const allowIdx = argv.indexOf("--allow");
  const allow = allowIdx >= 0 ? Number(argv[allowIdx + 1]) : 0;

  if (process.platform !== "darwin") {
    console.error("family-match conformance is macOS-only (it scores the CoreText/AppKit matcher).");
    process.exit(2);
  }
  const bin = existsSync(SHIPPED) ? SHIPPED : DEBUG;
  if (!existsSync(bin)) {
    console.error(`glyph helper not built — run tools/macos-glyph-extractor/build.sh (looked for ${SHIPPED}).`);
    process.exit(2);
  }

  // Our side: one helper invocation per family carrying all nine weights.
  const cases: { family: string; css: number; ours: string; names: Set<string> }[] = [];
  for (const family of installedFamilies()) {
    let results: { found: boolean; postscriptName?: string; candidates?: { name: string }[] }[];
    try {
      const out = execFileSync(bin, {
        input: JSON.stringify({ fonts: [], queries: WEIGHTS.map((w) => ({ type: "familyMatch", family, cssWeight: w })) }),
        encoding: "utf-8", maxBuffer: 64 * 1024 * 1024,
      });
      results = JSON.parse(out).results;
    } catch { continue; }
    if (!results?.[0]?.found) continue;
    const names = new Set((results[0].candidates ?? []).map((c) => c.name));
    // A single-face family cannot discriminate between any two rules.
    if (names.size < 2) continue;
    WEIGHTS.forEach((css, i) => {
      const r = results[i];
      if (r?.found && r.postscriptName) cases.push({ family, css, ours: r.postscriptName, names });
    });
  }

  // Chrome's side: one node per case, read back over CDP.
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const session = await page.context().newCDPSession(page);
  await session.send("DOM.enable");
  await session.send("CSS.enable");
  await page.setContent(
    `<body style="margin:0">${cases
      .map((d, i) => `<div id="p${i}" style="font-family:'${d.family.replace(/'/g, "\\'")}';font-weight:${d.css};font-size:32px">Regate</div>`)
      .join("")}</body>`,
  );
  await page.waitForLoadState("networkidle");
  const { root } = await session.send("DOM.getDocument", { depth: -1 });

  let scored = 0, agree = 0, skipped = 0;
  const misses: Miss[] = [];
  for (const [i, d] of cases.entries()) {
    const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#p${i}` });
    const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
    // Sort by glyphCount: the array is NOT ordered by coverage, and reading
    // fonts[0] has already produced a wrong answer in this area.
    const chrome = fonts.slice().sort((a, b) => b.glyphCount - a.glyphCount)[0]?.postScriptName;
    // A family with no coverage for the probe text (Arial Hebrew, Al Bayan and
    // friends carry no Latin) sends Chrome out of the family entirely. That is
    // a coverage artifact, not a style-matcher decision, so it is not scored.
    if (!chrome || !d.names.has(chrome)) { skipped++; continue; }
    scored++;
    if (chrome === d.ours) agree++;
    else misses.push({ family: d.family, css: d.css, chrome, ours: d.ours });
  }
  await browser.close();

  const familyCount = new Set(cases.map((c) => c.family)).size;
  const missFamilies = new Set(misses.map((m) => m.family));
  if (asJson) {
    console.log(JSON.stringify({ scored, agree, skipped, familyCount, misses }, null, 2));
  } else {
    console.log(`families ${familyCount}  cases ${cases.length}  scored ${scored}  skipped ${skipped} (no coverage)`);
    console.log(`agreement ${agree}/${scored} (${((agree / scored) * 100).toFixed(2)}%)`);
    console.log(`families with a miss: ${missFamilies.size}\n`);
    for (const m of misses) console.log(`  ${m.family}@${m.css}: chrome=${m.chrome} ours=${m.ours}`);
  }
  writeFileSync("tests/output/family-match-conformance.json", JSON.stringify({ scored, agree, skipped, misses }, null, 2));

  if (misses.length > allow) {
    console.error(`\n${misses.length} mismatches exceeds the allowed ${allow}.`);
    process.exit(1);
  }
}

await main();

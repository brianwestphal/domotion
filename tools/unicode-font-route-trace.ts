#!/usr/bin/env node
/**
 * Windows Unicode-cell font-route oracle (DM-2168).
 *
 * Records the two independently-observable routes for every <x><g> cell:
 * Chromium's painted face (CDP, then reopened through DirectWrite for gid) and
 * Domotion's declared-family → hardcoded candidate → MapCharacters → final
 * renderer key/gid path. Run only on native Windows after building the helper.
 */
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getFontInstance, getFontSourceInfo, glyphIdForCp, resolveFontForCodepoint,
  resolveFontKey, resolveFontKeyChain,
} from "../src/render/font-resolution.js";
import { createGlyphHelperFont, resolveInstalledFont, resolveSystemFallbackFonts } from "../src/render/glyph-helper.js";
import {
  blinkWinFallbackLocale, blinkWinHardcodedFamilies, winFallbackPriorityForTextRun,
} from "../src/render/win-font-fallback.js";

if (process.platform !== "win32") {
  process.stderr.write("unicode-font-route-trace requires a native Windows host\n");
  process.exit(2);
}

const args = process.argv.slice(2);
const fixtureArg = args.find((a) => !a.startsWith("--"));
if (fixtureArg == null) throw new Error("usage: npx tsx tools/unicode-font-route-trace.ts <fixture.html> [--out file.json]");
const outAt = args.indexOf("--out");
const outPath = resolve(outAt >= 0 && args[outAt + 1] != null ? args[outAt + 1]! : "unicode-font-route-trace.json");
const fixturePath = resolve(fixtureArg);

interface CellStyle { selector: string; cp: number; text: string; fontFamily: string; weight: number; size: number; italic: boolean; stretch: number; lang?: string }

function splitFamilies(css: string): string[] {
  const out: string[] = [];
  let cur = "", quote = "";
  for (const ch of css) {
    if (quote !== "") { if (ch === quote) quote = ""; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ",") { if (cur.trim() !== "") out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

const genericFamilies = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui",
  "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "fangsong",
]);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
await page.goto(`file://${fixturePath}`);
await page.evaluate(() => document.fonts.ready);
const cells = await page.evaluate<CellStyle[]>(() => [...document.querySelectorAll("x > g")].map((el, i) => {
  const cs = getComputedStyle(el);
  const text = el.textContent ?? "";
  return {
    selector: `x:nth-of-type(${i + 1}) > g`, text, cp: text.codePointAt(0) ?? 0,
    fontFamily: cs.fontFamily, weight: Number(cs.fontWeight) || 400,
    size: Number.parseFloat(cs.fontSize) || 16, italic: cs.fontStyle !== "normal",
    stretch: Number.parseFloat(cs.fontStretch) || 100,
    lang: el.closest("[lang]")?.getAttribute("lang") ?? (document.documentElement.lang || undefined),
  };
}));
const cdp = await page.context().newCDPSession(page);
await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
const { root } = await cdp.send("DOM.getDocument", { depth: 1 });
let probeSerial = 0;

async function probeChromeFamily(cell: CellStyle, family: string) {
  const probeId = `dm2168-probe-${probeSerial++}`;
  await page.evaluate(({ id, text, family, weight, size, italic, stretch, lang }) => {
    const probe = document.createElement("span");
    probe.id = id;
    probe.textContent = text;
    probe.lang = lang ?? "";
    Object.assign(probe.style, {
      position: "fixed", left: "0", top: "0", zIndex: "-1", opacity: "0.01", pointerEvents: "none", fontFamily: family,
      fontWeight: String(weight), fontSize: `${size}px`, fontStyle: italic ? "italic" : "normal",
      fontStretch: `${stretch}%`,
    });
    document.body.append(probe);
  }, { id: probeId, text: cell.text, family, weight: cell.weight, size: cell.size, italic: cell.italic, stretch: cell.stretch, lang: cell.lang });
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${probeId}` });
  const fonts = nodeId === 0 ? [] : (await cdp.send("CSS.getPlatformFontsForNode", { nodeId })).fonts;
  const painted = fonts.find((f) => f.glyphCount > 0) ?? null;
  await page.evaluate((id) => document.getElementById(id)?.remove(), probeId);
  return painted == null ? null : {
    familyName: painted.familyName,
    postscriptName: painted.postScriptName,
    glyphCount: painted.glyphCount,
  };
}

const results = [];
for (const cell of cells) {
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: cell.selector });
  const chromeFonts = nodeId === 0 ? [] : (await cdp.send("CSS.getPlatformFontsForNode", { nodeId })).fonts;
  const chrome = chromeFonts.find((f) => f.glyphCount > 0) ?? null;
  const chromeInstalled = chrome == null ? null : resolveInstalledFont(chrome.familyName);
  const chromeInstance = chromeInstalled == null ? null : createGlyphHelperFont({ fontPath: chromeInstalled.path, postscriptName: chromeInstalled.postscriptName });

  const declared = splitFamilies(cell.fontFamily).map((family, index) => {
    const installed = resolveInstalledFont(family);
    const generic = genericFamilies.has(family.toLowerCase());
    return { index, family, generic, usable: generic || installed != null, installed: installed != null, postscriptName: installed?.postscriptName ?? null, path: installed?.path ?? null };
  });
  const declaredChrome = [];
  for (const entry of declared) {
    declaredChrome.push({
      ...entry,
      chrome: await probeChromeFamily(cell, entry.family),
    });
  }
  const primaryKey = resolveFontKey(cell.fontFamily, cell.lang);
  const chain = resolveFontKeyChain(cell.fontFamily, cell.lang);
  const primary = getFontInstance(primaryKey, cell.weight, cell.size, cell.italic ? 1 : 0, undefined, cell.stretch, false, cell.fontFamily);
  if (primary == null) continue;
  const priority = winFallbackPriorityForTextRun(cell.cp);
  const hardcodedFamilies = blinkWinHardcodedFamilies(cell.cp, { lang: cell.lang, priority }, (family) => resolveInstalledFont(family) != null);
  const hardcoded = [];
  for (const family of hardcodedFamilies) {
    const installed = resolveInstalledFont(family);
    const inst = installed == null ? null : createGlyphHelperFont({ fontPath: installed.path, postscriptName: installed.postscriptName });
    hardcoded.push({ family, installed: installed != null, postscriptName: installed?.postscriptName ?? null, glyphId: inst == null ? 0 : glyphIdForCp(inst, cell.cp), chrome: await probeChromeFamily(cell, family) });
  }
  const baseFamilyName = declared[0]?.family;
  const locale = blinkWinFallbackLocale(cell.cp, cell.lang, priority);
  const directWrite = resolveSystemFallbackFonts([cell.cp], "Helvetica", {
    weight: cell.weight, italic: cell.italic, fontSize: cell.size,
    ...(baseFamilyName != null ? { baseFamilyName } : {}), ...(locale !== "" ? { locale } : {}),
  }).get(cell.cp) ?? null;
  const ours = resolveFontForCodepoint(cell.cp, primary, primaryKey, cell.weight, cell.size,
    cell.italic ? 1 : 0, undefined, cell.lang, chain, false, cell.stretch, undefined, cell.fontFamily);
  const finalInst = ours.fontOverride ?? (ours.key === primaryKey ? primary : getFontInstance(ours.key, cell.weight, cell.size, cell.italic ? 1 : 0));
  const source = getFontSourceInfo(finalInst);
  results.push({
    ...cell,
    declaredFamilies: declaredChrome,
    exhaustedDeclaredFamilyIndex: declared.findIndex((d) => d.usable),
    chrome: chrome == null ? null : { familyName: chrome.familyName, postscriptName: chrome.postScriptName, glyphCount: chrome.glyphCount, reopenedPath: chromeInstalled?.path ?? null, glyphId: chromeInstance == null ? null : glyphIdForCp(chromeInstance, cell.cp) },
    hardcoded: { priority, candidates: hardcoded, accepted: hardcoded.find((h) => h.glyphId !== 0) ?? null },
    directWrite: { baseFamilyName: baseFamilyName ?? null, locale, weight: cell.weight, italic: cell.italic, stretch: cell.stretch, answer: directWrite },
    domotion: { primaryKey, chain, routeKey: ours.key, covered: ours.covered, glyphId: finalInst == null ? 0 : glyphIdForCp(finalInst, cell.cp), postscriptName: finalInst?.postscriptName ?? source?.postscriptName ?? null, path: source?.path ?? null },
  });
}
await cdp.detach(); await browser.close();
const artifact = { schemaVersion: 1, generatedAt: new Date().toISOString(), platform: process.platform, fixture: fixturePath, cells: results };
writeFileSync(outPath, JSON.stringify(artifact, null, 2));
process.stdout.write(`FONTROUTE wrote ${results.length} cells to ${outPath}\n`);

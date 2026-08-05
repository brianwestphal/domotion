// Measure `font-variant-emoji` against a real Chrome AND against our resolver,
// in ONE process so both answers come from the same host's font inventory.
//
//   npx tsx tools/probe-font-variant-emoji.mjs                          # this host
//   CMD="npx tsx tools/probe-font-variant-emoji.mjs" npm run test:linux-docker
//
// Windows, via the Parallels VM (the mounted share's node_modules are
// macOS-built, so the tree is copied to a scratch dir with a junction to a
// Windows node_modules; `tools/scratch/dm1966-win-setup.ps1` does that). The
// helper path is NOT optional — see note 3:
//   prlctl exec "Windows 11" powershell -ExecutionPolicy Bypass -Command \
//     "Set-Location C:\dm1966; $env:DOMOTION_HELPER_PATH='...\domotion-glyph-paths.exe'; \
//      node node_modules\tsx\dist\cli.mjs tools\probe-font-variant-emoji.mjs"
//
// Two instrument notes, both learned by getting them wrong here first:
//
//  1. Ask the FULL per-codepoint resolver, not the system-fallback sub-step.
//     The `font-variant-emoji: emoji` forcing lives one layer above that
//     (`forcesEmojiPresentation`), so the sub-step answers a different question
//     and reported 8 false disagreements on a macOS run that is in fact 39/39.
//  2. Compare the resolved FILE, not our font key. A key is our own name for a
//     face and diverges from Chrome's family name per platform — `helvetica`
//     resolves to LiberationSans-Regular.ttf on Linux, which Chrome reports as
//     "Liberation Sans". Comparing key-to-family reported 15 disagreements on a
//     Linux run where the two had picked the same file.
//  3. On Windows, run it with the native glyph helper reachable. Without it the
//     resolver silently falls back to the static chain and the probe grades a
//     DIFFERENT mechanism: measured 21/39 agreeing without the helper against
//     31/39 with it. That the number MOVES is also the check that the helper is
//     in the loop at all — the failure it guards against is a resolver that was
//     shipped "default-on" and answered nothing for weeks.
import { chromium } from "@playwright/test";
import {
  resolveFont, resolveFontKey, resolveFontKeyChain, resolveFontForCodepoint, resolveFontSpec,
} from "../src/render/font-resolution.ts";

// Emoji-presentation-by-default (Blink's `IsEmojiPresentationEmoji` true), then
// text-presentation-by-default ones — the half where `font-variant-emoji: emoji`
// is supposed to CHANGE the answer, and where a transcription that only handled
// the first half would still look right.
const CPS = [
  [0x1f600, "grinning face"],
  [0x1f46a, "family (Blink's own substitution char)"],
  [0x1f680, "rocket"],
  [0x1f1fa, "regional indicator U"],
  [0x2764, "heavy black heart"],
  [0x2600, "black sun with rays"],
  [0x263a, "white smiling face"],
  [0x2708, "airplane"],
  [0x21a9, "leftwards arrow with hook"],
  [0x2b50, "white medium star"],
  [0x203c, "double exclamation mark"],
  [0x2122, "trade mark sign"],
  [0x00a9, "copyright sign"],
];
const MODES = ["normal", "text", "emoji"];
const STACK = "sans-serif";
const SIZE = 32;

const browser = await chromium.launch();
const page = await browser.newPage();
const cdp = await page.context().newCDPSession(page);
await cdp.send("DOM.enable");
await cdp.send("CSS.enable");

const rows = CPS.map(([cp, name]) => ({ cp, name }))
  .flatMap((r) => MODES.map((m) => ({ ...r, mode: m })));

const html = `<!doctype html><meta charset="utf-8"><style>
  span { font-family: ${STACK}; font-size: ${SIZE}px; }
</style>` + rows.map((r, i) =>
  `<div><span id="c${i}"${r.mode === "normal" ? "" : ` style="font-variant-emoji:${r.mode}"`}>`
  + `${String.fromCodePoint(r.cp)}</span></div>`).join("");
await page.setContent(html, { waitUntil: "load" });

const { root } = await cdp.send("DOM.getDocument");
async function chromeFont(id) {
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${id}` });
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  return fonts.length > 0 ? fonts[0].familyName : "(none)";
}

const primaryKey = resolveFontKey(STACK);
const primary = resolveFont(STACK, 400, SIZE, 0);
const chain = resolveFontKeyChain(STACK);

let agree = 0, disagree = 0;
const out = [];
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const chrome = await chromeFont(`c${i}`);
  const fve = r.mode === "normal" ? undefined : r.mode;
  // The FULL per-codepoint resolver, not the system-fallback sub-step: the
  // `font-variant-emoji: emoji` forcing lives one layer above that
  // (`forcesEmojiPresentation`), so asking the sub-step measures a different
  // question and reports a disagreement the renderer does not have.
  const res = resolveFontForCodepoint(r.cp, primary, primaryKey, 400, SIZE, 0, undefined, undefined, chain, false, 100, fve);
  const key = res.key;
  const spec = key != null ? resolveFontSpec(key) : null;
  // Compare on the resolved FILE, not on our key. A key is our own name for a
  // face and diverges from Chrome's family name per platform — `helvetica`
  // resolves to LiberationSans-Regular.ttf on Linux, which Chrome reports as
  // "Liberation Sans". Comparing key-to-family there reports a disagreement
  // where the two picked the same file, and 15 of this probe's first Linux run
  // were exactly that.
  const file = spec?.path != null ? spec.path.split("/").pop() : null;
  const ours = key == null ? "(none)"
    : `${key}${file != null ? ` <${file}>` : spec?.postscriptName != null ? ` [${spec.postscriptName}]` : ""}`;
  const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, "");
  const hay = norm(`${key ?? ""} ${file ?? ""} ${spec?.postscriptName ?? ""}`);
  const ok = key != null && (hay.includes(norm(chrome)) || norm(chrome).includes(norm(key)));
  ok ? agree++ : disagree++;
  out.push(`U+${r.cp.toString(16).toUpperCase().padStart(4, "0")} ${r.mode.padEnd(6)} `
    + `chrome=${chrome.padEnd(24)} ours=${ours.padEnd(46)} ${ok ? "" : "  <-- DISAGREE"}  (${r.name})`);
}
console.log(`platform=${process.platform}  stack=${STACK}  primary=${primaryKey}  primaryResolved=${primary != null}`);
console.log(out.join("\n"));
console.log(`\n${agree} agree, ${disagree} disagree of ${rows.length}`);
await browser.close();

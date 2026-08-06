// DM-1990's "cheap first measurement": does `font-variant-emoji` behave like the
// explicit variation selector it maps to?
//
// Blink sets TWO things from the property (`harfbuzz_shaper.cc:1002-1005` and
// `:983-984`, rev 7d859f27): a fallback PRIORITY and a VariationSelectorMode.
// We model only the first. If the property and the explicit selector always
// agree, the unmodelled half is unobservable on this host; where they diverge,
// the divergence IS the observable surface of the gap.
//
// Chrome only — both columns come from the same browser via CDP
// `CSS.getPlatformFontsForNode`, so this measures Chrome against itself and is
// meaningful on every platform without a per-platform expectation table.
//
//   node tools/probe-variation-selector-vs-property.mjs
//   CMD="node tools/probe-variation-selector-vs-property.mjs" npm run test:linux-docker
//   (Windows: copy it into the VM's scratch tree and `node` it there.)
//
// Measured 2026-08-06, `sans-serif` @32px, 13 codepoints:
//
//   macOS    0 of 13 diverge
//   Linux    0 of 13 diverge
//   Windows  4 of 13 diverge — U+00A9 U+2122 U+203C U+263A, where an explicit
//            VS16 reaches Segoe UI Emoji and `font-variant-emoji: emoji` leaves
//            the run on Arial
//
// The four Windows rows share one property the eight agreeing ones do not: the
// run's PRIMARY font covers the base codepoint (`plain` answers Arial). Where it
// does not (`plain` answers Segoe UI Symbol), the property and the selector
// agree. On macOS Helvetica likewise covers U+00A9 and the property still moves
// it, so the rule is "primary covers it AND Windows", not coverage alone.
import { chromium } from "@playwright/test";

// Both halves of the emoji set, because the property's two directions are
// answered by different codepoints: text-presentation-default ones are where
// `emoji` has something to do, emoji-presentation-default ones are where `text`
// does. A list from one half only would report agreement for the trivial reason.
const CPS = [
  [0x00a9, "copyright", "text-default"],
  [0x2122, "trade mark", "text-default"],
  [0x203c, "double exclamation", "text-default"],
  [0x263a, "white smiling face", "text-default"],
  [0x2764, "heavy black heart", "text-default"],
  [0x2708, "airplane", "text-default"],
  [0x21a9, "leftwards arrow with hook", "text-default"],
  [0x2600, "black sun with rays", "text-default"],
  [0x2b50, "white medium star", "emoji-default"],
  [0x2614, "umbrella with rain", "emoji-default"],
  [0x1f600, "grinning face", "emoji-default"],
  [0x1f680, "rocket", "emoji-default"],
  [0x1f46a, "family", "emoji-default"],
];

const STACK = "sans-serif";
const SIZE = 32;

/** The pairs the ticket says should agree if the property is exactly its
 *  selector. `unicode` has no single-selector twin — it picks per codepoint —
 *  so it is reported beside them rather than paired. */
const COLUMNS = [
  { label: "plain", suffix: "", css: "" },
  { label: "+VS15", suffix: "︎", css: "" },
  { label: "fve:text", suffix: "", css: "font-variant-emoji:text" },
  { label: "+VS16", suffix: "️", css: "" },
  { label: "fve:emoji", suffix: "", css: "font-variant-emoji:emoji" },
  { label: "fve:unicode", suffix: "", css: "font-variant-emoji:unicode" },
];

// `CHROMIUM_EXECUTABLE` pins the build. Two hosts can resolve the same
// Playwright revision folder and still launch browsers reporting different
// Chromium versions, which turns a version difference into what reads as a
// platform difference. Measured: this Mac's default launch reported 147 while
// the Windows VM's reported 148, both from `chromium-1217`.
const browser = await chromium.launch(
  process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {},
);
const page = await browser.newPage();
const cdp = await page.context().newCDPSession(page);
await cdp.send("DOM.enable");
await cdp.send("CSS.enable");

const cells = [];
for (const [cp] of CPS) {
  for (const col of COLUMNS) cells.push({ cp, col });
}
await page.setContent(
  `<!doctype html><meta charset="utf-8"><style>span{font-family:${STACK};font-size:${SIZE}px}</style>`
  + cells.map((c, i) =>
    `<div><span id="c${i}" style="${c.col.css}">${String.fromCodePoint(c.cp)}${c.col.suffix}</span></div>`).join(""),
  { waitUntil: "load" },
);

const { root } = await cdp.send("DOM.getDocument");
const faces = [];
for (let i = 0; i < cells.length; i++) {
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#c${i}` });
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  // Highest glyph count, same rule the conformance oracle uses — the protocol
  // array's order is not a documented ranking.
  let best = null;
  for (const f of fonts) if (best == null || f.glyphCount > best.glyphCount) best = f;
  faces.push(best == null ? "(none)" : best.familyName);
}

const at = (cpIdx, colLabel) =>
  faces[cpIdx * COLUMNS.length + COLUMNS.findIndex((c) => c.label === colLabel)];

// The browser version is part of the answer, not decoration. Chrome's VS-aware
// fallback (`SystemFallbackEmojiVSSupport`) shipped at a particular milestone,
// so two hosts running different Chromium builds are two different oracles —
// and a per-platform divergence measured across a version gap would look
// exactly like a platform difference.
console.log(`platform=${process.platform}  chromium=${browser.version()}  stack=${STACK}  ${SIZE}px`);
console.log(["codepoint".padEnd(9), ...COLUMNS.map((c) => c.label.padEnd(16))].join("") + "verdict");
let divergent = 0;
for (const [i, [cp, name, kind]] of CPS.entries()) {
  const row = COLUMNS.map((c) => at(i, c.label));
  const textDiv = at(i, "+VS15") !== at(i, "fve:text");
  const emojiDiv = at(i, "+VS16") !== at(i, "fve:emoji");
  if (textDiv || emojiDiv) divergent++;
  const verdict = [textDiv ? "TEXT-DIVERGES" : "", emojiDiv ? "EMOJI-DIVERGES" : ""].filter(Boolean).join(" ") || "agree";
  console.log(
    `U+${cp.toString(16).toUpperCase().padStart(4, "0")}   `
    + row.map((f) => f.slice(0, 15).padEnd(16)).join("")
    + `${verdict}   (${name}, ${kind})`,
  );
}
console.log(`\n${divergent} of ${CPS.length} codepoints diverge between the CSS property and its explicit selector.`);
await browser.close();

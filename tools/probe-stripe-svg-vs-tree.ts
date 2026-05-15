/* eslint-disable */
/**
 * Compare what's in the captured tree vs the generated SVG at REGION [1]
 * for DM-587 (stripe-mobile-entire-page).
 *
 * Both inputs already exist on disk:
 *   - `tests/output/probe-stripe-checkout.json` (from probe-stripe-checkout.ts)
 *   - `tests/output/real-world/stripe-mobile-entire-page.svg`
 *
 * The tree dump tells us which captured elements intersect REGION [1] (260,
 * 1077, 126, 225). We want to know whether the SVG actually emits paint
 * commands for those elements, and at what coordinates.
 *
 * Strategy: parse the SVG with a permissive regex, find every absolute-y
 * candidate (`<text y="..."`, `<rect y="..."`, `<image y="..."`, plus
 * containing `<g transform="...translate...">` ancestors), and print the
 * count of elements whose effective y falls inside REGION [1]. Cross-
 * reference against the captured tree's text fragments.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tests");
const OUT_DIR = resolve(TESTS_DIR, "output");

const REGION = { x: 260, y: 1077, w: 126, h: 225 };

const treeJson = JSON.parse(readFileSync(resolve(OUT_DIR, "probe-stripe-checkout.json"), "utf8"));
const svg = readFileSync(resolve(OUT_DIR, "real-world/stripe-mobile-entire-page.svg"), "utf8");

// --- Captured tree summary ---
console.log("=== CAPTURED TREE TEXT FRAGMENTS AT REGION [1] ===");
const treeTexts = new Set<string>();
for (const h of treeJson.captured) {
  const t = (h.text ?? "").trim();
  if (t.length > 0) treeTexts.add(t);
  if (Array.isArray(h.textSegmentsPreview)) {
    for (const s of h.textSegmentsPreview) {
      if (typeof s.text === "string" && s.text.trim().length > 0) treeTexts.add(s.text.trim());
    }
  }
}
console.log([...treeTexts].slice(0, 20));

// --- SVG: find all <text> elements with their absolute coordinates ---
// kerf renders text as <text x="..." y="..."> or wrapped in transformed <g>.
// Find every <text ...>...</text> tag and capture y attribute.
console.log("\n=== SVG TEXT ELEMENTS IN STRIPE PAYMENT REGION (y in [1000,1320]) ===");
const textRe = /<text\b([^>]*)>([^<]{0,400})<\/text>/g;
let m: RegExpExecArray | null;
let inRegion = 0;
let textHits: Array<{ y: number; x: number; text: string }> = [];
while ((m = textRe.exec(svg)) !== null) {
  const attrs = m[1];
  const body = m[2];
  const ym = attrs.match(/\by="([-\d.]+)"/);
  const xm = attrs.match(/\bx="([-\d.]+)"/);
  if (!ym) continue;
  const y = parseFloat(ym[1]);
  const x = xm ? parseFloat(xm[1]) : 0;
  if (y < 1000 || y > 1320) continue;
  inRegion++;
  textHits.push({ y, x, text: body.trim().slice(0, 60) });
}
console.log(`Found ${inRegion} <text> elements with y in [1000,1320]`);
textHits.sort((a, b) => a.y - b.y || a.x - b.x);
for (const h of textHits.slice(0, 60)) {
  console.log(`  y=${h.y.toFixed(1)} x=${h.x.toFixed(1)} "${h.text}"`);
}

// Also look for <use> + <text> via def references (kerf often emits text as <use href="#textN">).
// Counts will reveal whether the text is emitted at all.
console.log(`\nSVG total <text> tags: ${(svg.match(/<text\b/g) ?? []).length}`);
console.log(`SVG total <use> tags:  ${(svg.match(/<use\b/g) ?? []).length}`);
console.log(`SVG file size:         ${svg.length} chars`);

// --- Look for payment-method label strings anywhere in SVG ---
console.log("\n=== STRIPE PAYMENT LABEL LOOKUPS ===");
const labels = ["Card", "Affirm", "Cash App", "Crypto", "US bank", "Continue", "Pay now"];
for (const l of labels) {
  const re = new RegExp(`>${l.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}[^<]{0,30}<`, "g");
  const matches = svg.match(re) ?? [];
  console.log(`  "${l}": ${matches.length} matches`);
}

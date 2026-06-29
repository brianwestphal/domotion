// DM-1436 item 3 (composer stop-list dedup): prove the scroll composite SVG is
// byte-identical. `composeScrollSvg(segments, opts)` is pure, so this builds a
// battery of segment sets — multi-segment y/x scroll, per-segment easing
// (named / steps / cubic-bezier, which drive the per-stop timing-function the
// dedup must preserve), and varied chunk sizes — and writes a {name: sha256}
// manifest. Diff before/after the refactor.
//
//   npx tsx tools/probe-1436-byte-validate-scroll.mjs <out-manifest.json>

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { composeScrollSvg } from "../src/scroll/composer.ts";

function el(opts) {
  return {
    text: "", width: 100, height: 20, children: [], ...opts,
    styles: {
      backgroundColor: "rgb(240,240,240)", borderColor: "rgb(0,0,0)", borderWidth: "0", borderRadius: "0",
      borderTopLeftRadius: "0", borderTopRightRadius: "0", borderBottomRightRadius: "0", borderBottomLeftRadius: "0",
      borderTopWidth: "0", borderRightWidth: "0", borderBottomWidth: "0", borderLeftWidth: "0",
      borderTopColor: "rgb(0,0,0)", borderRightColor: "rgb(0,0,0)", borderBottomColor: "rgb(0,0,0)", borderLeftColor: "rgb(0,0,0)",
      borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none",
      color: "rgb(0,0,0)", fontSize: "16px", fontFamily: "sans-serif", fontWeight: "400", fontStyle: "normal",
      lineHeight: "20px", letterSpacing: "normal", textAlign: "left", textTransform: "none", textDecoration: "none",
      textDecorationLine: "none", textDecorationStyle: "solid", textDecorationColor: "rgb(0,0,0)", textDecorationThickness: "auto", textUnderlineOffset: "auto",
      whiteSpace: "normal", wordSpacing: "0", verticalAlign: "baseline", direction: "ltr", writingMode: "horizontal-tb", textOverflow: "clip",
      cursor: "auto", caretColor: "auto", outlineColor: "rgb(0,0,0)", outlineWidth: "0", outlineStyle: "none", outlineOffset: "0", boxShadow: "none",
      opacity: "1", transform: "none", transformOrigin: "50% 50%", visibility: "visible", borderCollapse: "separate",
      overflowX: "visible", overflowY: "visible", scrollbarGutter: "auto",
      scrollWidth: 100, scrollHeight: 100, clientWidth: 100, clientHeight: 100, scrollTop: 0, scrollLeft: 0,
      objectFit: "fill", objectPosition: "50% 50%", filter: "none", backdropFilter: "none", mixBlendMode: "normal",
      clipPath: "none", mask: "none", maskImage: "none", maskMode: "match-source", maskSize: "auto", maskPosition: "0% 0%", maskRepeat: "repeat", maskComposite: "add",
      listStyleType: "disc", listStyleImage: "none", display: "block", listStylePosition: "outside",
      backgroundImage: "none", backgroundSize: "auto", backgroundPosition: "0% 0%", backgroundRepeat: "repeat", backgroundClip: "border-box", backgroundOrigin: "padding-box", backgroundAttachment: "scroll",
      paddingTop: "0", paddingRight: "0", paddingBottom: "0", paddingLeft: "0",
      borderImageSource: "none", borderImageSlice: "100%", borderImageWidth: "1", borderImageOutset: "0", borderImageRepeat: "stretch",
      zIndex: "auto", position: "static", float: "none", order: "0", flexDirection: "row",
      ...(opts.styles ?? {}),
    },
  };
}
const seg = (scrollY, segStartMs, segEndMs, easing) => ({
  scrollX: 0, scrollY, segmentStartMs: segStartMs, segmentEndMs: segEndMs,
  tree: [el({ tag: "div", x: 0, y: scrollY, height: 600 })], diffFromPrev: null,
  ...(easing ? { easing } : {}),
});
const segX = (scrollX, s, e, easing) => ({
  scrollX, scrollY: 0, segmentStartMs: s, segmentEndMs: e,
  tree: [el({ tag: "div", x: scrollX, y: 0, width: 600 })], diffFromPrev: null,
  ...(easing ? { easing } : {}),
});
const OPT = { viewportW: 800, viewportH: 600 };

const configs = {
  "y-3seg": [seg(0, 0, 1000), seg(400, 1000, 2000), seg(900, 2000, 3000)],
  "y-easing-named": [seg(0, 0, 1000, { kind: "named", name: "ease-in" }), seg(400, 1000, 2000, { kind: "named", name: "ease-out" }), seg(900, 2000, 3000, { kind: "named", name: "ease-in-out" })],
  "y-easing-steps": [seg(0, 0, 1000, { kind: "steps", count: 4, position: "end" }), seg(500, 1000, 2500, { kind: "steps", count: 3 })],
  "y-easing-bezier": [seg(0, 0, 1000, { kind: "cubic-bezier", values: [0.4, 0, 0.2, 1] }), seg(600, 1000, 2000, { kind: "cubic-bezier", values: [0.25, 0.1, 0.25, 1] })],
  "y-single": [seg(0, 0, 1000)],
  "y-back": [seg(0, 0, 1000), seg(800, 1000, 2000), seg(200, 2000, 3000)],
};
const manifest = {};
for (const [name, segs] of Object.entries(configs)) {
  try { manifest[name] = createHash("sha256").update(composeScrollSvg(segs, OPT)).digest("hex").slice(0, 16); }
  catch (e) { manifest[name] = `ERROR:${e.message}`; }
}
for (const cs of [1, 2, 3]) {
  const segs = [seg(0, 0, 1000), seg(300, 1000, 2000), seg(700, 2000, 3000), seg(1200, 3000, 4000)];
  try { manifest[`y-chunk${cs}`] = createHash("sha256").update(composeScrollSvg(segs, { ...OPT, chunkSize: cs })).digest("hex").slice(0, 16); }
  catch (e) { manifest[`y-chunk${cs}`] = `ERROR:${e.message}`; }
}
const xsegs = [segX(0, 0, 1000, { kind: "named", name: "ease-in" }), segX(500, 1000, 2000), segX(1100, 2000, 3000)];
try { manifest["x-easing"] = createHash("sha256").update(composeScrollSvg(xsegs, { ...OPT, axis: "x" })).digest("hex").slice(0, 16); }
catch (e) { manifest["x-easing"] = `ERROR:${e.message}`; }

const OUT = process.argv[2] ?? "tools/scratch/scroll-manifest.json";
writeFileSync(OUT, JSON.stringify(manifest, null, 0));
const errs = Object.entries(manifest).filter(([, v]) => String(v).startsWith("ERROR"));
console.error(`${Object.keys(manifest).length} scroll configs hashed (${errs.length} errors) → ${OUT}`);
for (const [k, v] of errs) console.error(`  ${k}: ${v}`);

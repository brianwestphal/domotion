// DM-1436: prove an animator/composer refactor leaves the generated animation
// CSS byte-identical. `generateAnimatedSvg(config)` is a pure (config -> string)
// function, so this constructs a battery of configs exercising every emitter the
// item-3 dedup touches (each transition type, intra-frame animations with
// repeat/alternate, typing/blink/svg overlays incl. enter/exit slides in all 4
// directions) and writes a {name: sha256(svg)} manifest. Diff before/after.
//
//   npx tsx tools/probe-1436-byte-validate-animate.mjs <out-manifest.json>

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { generateAnimatedSvg } from "../src/animation/animator.ts";

const RA = `<rect id="a" width="100" height="100" fill="red"/>`;
const RB = `<rect id="b" width="100" height="100" fill="blue"/>`;
const base = { width: 200, height: 120 };

const configs = {};
for (const t of ["crossfade", "push-left", "scroll", "cut", "magic-move"]) {
  configs[`trans-${t}`] = {
    ...base,
    frames: [
      { svgContent: RA, duration: 500, transition: { type: t, duration: 300 } },
      { svgContent: RB, duration: 500, transition: { type: t, duration: 300 } },
      { svgContent: RA, duration: 500, transition: { type: t, duration: 300 } },
    ],
  };
}
configs["trans-scroll-loopfade"] = {
  ...base,
  frames: [
    { svgContent: RA, duration: 500, transition: { type: "scroll", duration: 300, loopFade: true } },
    { svgContent: RB, duration: 500, transition: { type: "scroll", duration: 300, loopFade: true } },
  ],
};
configs["intra-anim"] = {
  ...base,
  frames: [{
    svgContent: `<rect class="anim-t" width="10" height="10"/>`,
    duration: 1000,
    animations: [
      { animId: "t", property: "translateX", from: "0px", to: "10px", duration: 200 },
      { animId: "o", property: "opacity", from: "1", to: "0.3", duration: 400, repeat: 3 },
      { animId: "c", property: "opacity", from: "1", to: "0", duration: 530, repeat: "infinite", alternate: true },
      { animId: "s", property: "scale", from: "0.6", to: "1", duration: 360, easing: "ease-out", transformOrigin: "bottom left" },
    ],
  }],
};
configs["overlay-typing"] = {
  ...base,
  frames: [{ svgContent: `<rect/>`, duration: 6000, overlays: [
    { kind: "typing", text: "hello world this is a long first line second", x: 10, y: 30, fontSize: 14, caret: true, wrapWidth: 220 },
  ] }],
};
configs["overlay-blink"] = {
  ...base,
  frames: [{ svgContent: `<rect/>`, duration: 2000, overlays: [
    { kind: "blink", x: 10, y: 10, width: 12, height: 12, periodMs: 800, color: "#ef4444", radius: 6 },
  ] }],
};
for (const from of ["top", "bottom", "left", "right"]) {
  configs[`overlay-svg-${from}`] = {
    ...base,
    frames: [{ svgContent: `<rect/>`, duration: 3000, overlays: [{
      kind: "svg", innerSvg: `<rect width="40" height="20" fill="green"/>`, x: 20, y: 20, width: 40, height: 20,
      enter: { from, duration: 300 }, exit: { from, duration: 300 },
    }] }],
  };
}
configs["bg-and-mixed"] = {
  ...base,
  background: "rgb(255,255,255)",
  frames: [
    { svgContent: RA, duration: 500, transition: { type: "crossfade", duration: 200 } },
    { svgContent: RB, duration: 500, transition: { type: "push-left", duration: 200 } },
  ],
};

const manifest = {};
for (const [name, cfg] of Object.entries(configs)) {
  try {
    const svg = generateAnimatedSvg(cfg);
    manifest[name] = createHash("sha256").update(svg).digest("hex").slice(0, 16);
  } catch (e) {
    manifest[name] = `ERROR:${e.message}`;
  }
}
const OUT = process.argv[2] ?? "tools/scratch/animate-manifest.json";
writeFileSync(OUT, JSON.stringify(manifest, null, 0));
const errs = Object.entries(manifest).filter(([, v]) => String(v).startsWith("ERROR"));
console.error(`${Object.keys(manifest).length} configs hashed (${errs.length} errors) → ${OUT}`);
for (const [k, v] of errs) console.error(`  ${k}: ${v}`);

/**
 * Showcase: Transition Types — separate, self-contained mini-demos, one per
 * transition, each a clean two-scene loop, plus a spring + shine effects scene.
 *
 * Why one demo per transition instead of one chained tour: the animator drives a
 * frame's ENTRANCE from the PREVIOUS frame's transition type but routes the frame
 * by its OWN type, so chaining *different* transition types (crossfade → push →
 * scroll) leaves each incoming frame in the wrong branch and it never slides/fades
 * IN — the crossfade dips to black and slides reveal empty canvas. Keeping each
 * demo to a single, consistent transition type sidesteps that (the mixed-type
 * composition limitation is tracked separately). `loopFade: true` makes the last
 * frame transition back to the first for a seamless loop.
 *
 * Produces under examples/output/: transition-crossfade.svg, transition-pushleft.svg,
 * transition-scroll.svg, transition-magicmove.svg, and (DM-1524/DM-1542) the
 * cross-engine-safe expansion — transition-wipe.svg, transition-iris.svg,
 * transition-zoom.svg, transition-shine.svg, and transition-effects.svg (a spring
 * intra-frame animation + a shine overlay). All motion is transform / clip-path /
 * opacity / gradient only — never an animated CSS filter (docs/84, docs/88).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { captureElementTree, elementTreeToSvgInner, embedRemoteImages } from "../src/render/element-tree-to-svg.js";
import { generateAnimatedSvg, type AnimationFrame } from "../src/animation/animator.js";
import { EASING_PRESETS } from "../src/animation/motion-presets.js";
import { buildMagicMove } from "../src/animation/magic-move.js";
import { clearEmbeddedFonts, getEmbeddedFontFaceCss } from "../src/render/index.js";
import { optimizeSvg } from "./shared.js";

const W = 560;
const H = 340;
const OUT_DIR = resolve("examples/output");

/** A full-bleed scene: gradient background, a transition-name chip, and content. */
function scene(opts: { bg: string; chip: string; accent: string; body: string }): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { width: ${W}px; height: ${H}px; background: #0a0f1e; color: #eef1fb; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; overflow: hidden; }
.page { width: ${W}px; height: ${H}px; padding: 26px 30px; position: relative; background: ${opts.bg}; }
.chip { position: absolute; top: 20px; right: 22px; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #0a0f1e; background: ${opts.accent}; padding: 4px 11px; border-radius: 20px; }
.h { font-size: 26px; font-weight: 800; letter-spacing: -0.02em; }
.sub { font-size: 13px; color: #aab2d5; margin-top: 4px; }
.big { font-size: 52px; font-weight: 800; letter-spacing: -0.03em; margin-top: 18px; }
.delta { display: inline-block; font-size: 14px; font-weight: 700; padding: 4px 12px; border-radius: 20px; margin-top: 12px; }
.card { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.10); border-radius: 12px; padding: 14px 16px; }
.list { display: flex; flex-direction: column; gap: 10px; margin-top: 18px; }
.row { display: flex; align-items: center; gap: 12px; font-size: 14px; }
.dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.col { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
.mm-stage { position: relative; height: 220px; margin-top: 14px; }
.mm { position: absolute; width: 200px; height: 70px; border-radius: 12px; padding: 12px 14px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); }
.mm .k { font-weight: 800; font-size: 15px; }
.mm .v { font-size: 12px; color: #aab2d5; margin-top: 5px; }
</style></head><body><div class="page"><span class="chip">${opts.chip}</span>${opts.body}</div></body></html>`;
}

async function capture(pg: Page, html: string, prefix: string): Promise<{ tree: Awaited<ReturnType<typeof captureElementTree>>; svg: string }> {
  const tmp = resolve(OUT_DIR, `tr-tmp-${prefix}.html`);
  writeFileSync(tmp, html);
  await pg.goto(`file://${tmp}`);
  await pg.waitForTimeout(180);
  const tree = await captureElementTree(pg, "body", { x: 0, y: 0, width: W, height: H });
  await embedRemoteImages(tree);
  return { tree, svg: elementTreeToSvgInner(tree, W, H, prefix, true, 2, false) };
}

// ─── Scene content ────────────────────────────────────────────────────────────

const INDIGO = "radial-gradient(130% 130% at 0% 0%, #1b2350 0%, #0a0f1e 60%)";
const PURPLE = "radial-gradient(130% 130% at 100% 0%, #2a1450 0%, #0a0f1e 60%)";
const TEAL = "radial-gradient(130% 130% at 100% 100%, #0c3a3a 0%, #0a0f1e 60%)";
const GREEN = "radial-gradient(130% 130% at 0% 100%, #0c3a2a 0%, #0a0f1e 60%)";
const AMBER = "radial-gradient(130% 130% at 100% 0%, #3a2c0c 0%, #0a0f1e 60%)";

// Crossfade — two clearly different stat cards dissolve into each other.
const CF_A = scene({ bg: INDIGO, chip: "Crossfade", accent: "#7c9cff", body:
  `<div class="h">Revenue</div><div class="sub">This month</div>
   <div class="big">$48.2k</div><span class="delta" style="color:#34d399;background:rgba(52,211,153,0.14)">▲ 12.4% vs last month</span>` });
const CF_B = scene({ bg: PURPLE, chip: "Crossfade", accent: "#c4a3ff", body:
  `<div class="h">Signups</div><div class="sub">This month</div>
   <div class="big">1,204</div><span class="delta" style="color:#c4a3ff;background:rgba(196,163,255,0.16)">▲ 8.1% vs last month</span>` });

// Push-left — a list page slides off as a detail page slides in.
const PL_A = scene({ bg: GREEN, chip: "Push left", accent: "#4ade80", body:
  `<div class="h">Inbox</div>
   <div class="list">
     <div class="card row"><span class="dot" style="background:#4ade80"></span>Ada Lovelace — Deploy is green</div>
     <div class="card row"><span class="dot" style="background:#fbbf24"></span>Billing — Invoice #1042 paid</div>
     <div class="card row"><span class="dot" style="background:#60a5fa"></span>CI — 214 tests passed</div>
   </div>` });
const PL_B = scene({ bg: AMBER, chip: "Push left", accent: "#fbbf24", body:
  `<div class="h">Deploy is green</div><div class="sub">Ada Lovelace · 2m ago</div>
   <div class="card" style="margin-top:18px">Production rollout finished — all 12 regions healthy, error rate 0.00%. Nice and boring. 🎉</div>
   <div class="card" style="margin-top:12px">build #4821 · 38s · main@2b86906</div>` });

// Scroll — top of a page and its continuation; scrolling reveals real content.
const SC_A = scene({ bg: INDIGO, chip: "Scroll", accent: "#7c9cff", body:
  `<div class="h">Acme Cloud</div><div class="sub">Ship faster, scale calmly.</div>
   <div class="card" style="margin-top:18px"><b>Overview</b><div class="sub">One platform for build, deploy, and observe.</div></div>
   <div class="card" style="margin-top:12px"><b>Get started in minutes</b><div class="sub">No card required.</div></div>` });
const SC_B = scene({ bg: INDIGO, chip: "Scroll", accent: "#7c9cff", body:
  `<div class="col">
     <div class="card"><b>Features</b><div class="sub">Edge functions, queues, cron, KV — batteries included.</div></div>
     <div class="card"><b>Metrics</b><div class="sub">p50 32&nbsp;ms · 99.99% uptime · 8.1k req/s</div></div>
     <div class="card"><b>Pricing</b><div class="sub">Free to start, usage-based after.</div></div>
   </div>` });

// Magic-move — three keyed cards glide from a row to a staggered column.
function mm(key: string, k: string, v: string, left: number, top: number, accent: string): string {
  return `<div class="mm" data-magic-key="${key}" style="left:${left}px;top:${top}px"><div class="k" style="color:${accent}">${k}</div><div class="v">${v}</div></div>`;
}
const MM_A = scene({ bg: TEAL, chip: "Magic move", accent: "#5eead4", body:
  `<div class="h">Reorder</div>
   <div class="mm-stage">
     ${mm("a", "capture", "URL → SVG", 0, 0, "#7c9cff")}
     ${mm("b", "animate", "frames → motion", 0, 80, "#4ade80")}
     ${mm("c", "composite", "layered SVGs", 0, 160, "#fbbf24")}
   </div>` });
const MM_B = scene({ bg: TEAL, chip: "Magic move", accent: "#5eead4", body:
  `<div class="h">Reorder</div>
   <div class="mm-stage">
     ${mm("c", "composite", "layered SVGs", 300, 0, "#fbbf24")}
     ${mm("a", "capture", "URL → SVG", 300, 80, "#7c9cff")}
     ${mm("b", "animate", "frames → motion", 300, 160, "#4ade80")}
   </div>` });

// DM-1524 additions — each a clean two-scene loop of a new cross-engine-safe
// transition (transform / clip-path / opacity / gradients only; no filter).

// Wipe — a linear left→right clip reveal of the incoming page.
const WP_A = scene({ bg: INDIGO, chip: "Wipe", accent: "#7c9cff", body:
  `<div class="h">Before</div><div class="sub">Draft copy</div>
   <div class="card" style="margin-top:18px">The old hero section — plain, functional, forgettable.</div>` });
const WP_B = scene({ bg: PURPLE, chip: "Wipe", accent: "#c4a3ff", body:
  `<div class="h">After</div><div class="sub">Shipped copy</div>
   <div class="card" style="margin-top:18px">The redesigned hero — bold, specific, on-brand. Wiped in over the old.</div>` });

// Iris — an expanding circle unveils the incoming page from the center.
const IR_A = scene({ bg: TEAL, chip: "Iris", accent: "#5eead4", body:
  `<div class="h">Focus</div><div class="big">1</div><div class="sub">One thing at a time.</div>` });
const IR_B = scene({ bg: GREEN, chip: "Iris", accent: "#4ade80", body:
  `<div class="h">Reveal</div><div class="big">2</div><div class="sub">Then the next.</div>` });

// Zoom — a scale dolly under a crossfade (the incoming grows into place).
const ZM_A = scene({ bg: AMBER, chip: "Zoom in", accent: "#fbbf24", body:
  `<div class="h">Overview</div><div class="sub">The whole board</div>
   <div class="card" style="margin-top:18px">Zoomed out — every project at a glance.</div>` });
const ZM_B = scene({ bg: INDIGO, chip: "Zoom in", accent: "#7c9cff", body:
  `<div class="h">Detail</div><div class="sub">One project</div>
   <div class="card" style="margin-top:18px">Dollied in — the payoff card, front and center.</div>` });

// Shine — a crossfade accented by a swept gradient highlight over the handoff.
const SH_A = scene({ bg: PURPLE, chip: "Shine", accent: "#c4a3ff", body:
  `<div class="h">Unlock</div><div class="sub">Pro plan</div>
   <div class="card" style="margin-top:18px">Everything in Starter, plus…</div>` });
const SH_B = scene({ bg: TEAL, chip: "Shine", accent: "#5eead4", body:
  `<div class="h">Unlocked</div><div class="sub">Pro plan</div>
   <div class="card" style="margin-top:18px">…unlimited seats, SSO, and priority support. ✨</div>` });

// ─── Build ─────────────────────────────────────────────────────────────────────

type TransitionType =
  | "crossfade" | "push-left" | "scroll" | "magic-move"
  | "wipe" | "iris" | "zoom-in" | "shine";

async function buildDemo(
  pg: Page,
  name: string,
  a: { html: string; p: string },
  b: { html: string; p: string },
  type: TransitionType,
  durMs: number,
): Promise<void> {
  clearEmbeddedFonts();
  const sa = await capture(pg, a.html, a.p);
  const sb = await capture(pg, b.html, b.p);
  const frames: AnimationFrame[] = [
    { svgContent: sa.svg, duration: 2000, transition: { type, duration: durMs } },
    { svgContent: sb.svg, duration: 2000, transition: { type, duration: durMs } },
  ];
  if (type === "magic-move") {
    const render = (roots: Parameters<Parameters<typeof buildMagicMove>[2]>[0], prefix: string): string =>
      elementTreeToSvgInner(roots, W, H, prefix, true, 2, false);
    frames[0].magicMove = buildMagicMove(sa.tree, sb.tree, render, "mmA-");
    frames[1].magicMove = buildMagicMove(sb.tree, sa.tree, render, "mmB-");
  }
  let svg = generateAnimatedSvg({ width: W, height: H, frames, fontFaceCss: getEmbeddedFontFaceCss(), background: "#0a0f1e", loopFade: true });
  svg = optimizeSvg(svg);
  const out = resolve(OUT_DIR, `transition-${name}.svg`);
  writeFileSync(out, svg);
  console.log(`Generated: ${out} (${(svg.length / 1024).toFixed(1)} KB)`);
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: W, height: H } });
    const pg = await ctx.newPage();
    await buildDemo(pg, "crossfade", { html: CF_A, p: "cfa-" }, { html: CF_B, p: "cfb-" }, "crossfade", 700);
    await buildDemo(pg, "pushleft", { html: PL_A, p: "pla-" }, { html: PL_B, p: "plb-" }, "push-left", 600);
    await buildDemo(pg, "scroll", { html: SC_A, p: "sca-" }, { html: SC_B, p: "scb-" }, "scroll", 800);
    await buildDemo(pg, "magicmove", { html: MM_A, p: "mma-" }, { html: MM_B, p: "mmb-" }, "magic-move", 800);
    // DM-1524 transition/effect expansion.
    await buildDemo(pg, "wipe", { html: WP_A, p: "wpa-" }, { html: WP_B, p: "wpb-" }, "wipe", 700);
    await buildDemo(pg, "iris", { html: IR_A, p: "ira-" }, { html: IR_B, p: "irb-" }, "iris", 800);
    await buildDemo(pg, "zoom", { html: ZM_A, p: "zma-" }, { html: ZM_B, p: "zmb-" }, "zoom-in", 700);
    await buildDemo(pg, "shine", { html: SH_A, p: "sha-" }, { html: SH_B, p: "shb-" }, "shine", 800);
    // DM-1542 motion effects: a spring intra-frame animation + a shine overlay.
    await buildEffects(pg);
  } finally {
    await browser.close();
  }
}

/**
 * DM-1542 effects showcase (single scene, one loop): a stat card springs in from
 * the left with the `spring-bouncy` sampled easing (multiple overshoots settling
 * to rest), while a `shine` overlay sweeps a shimmer across a "PRO" badge.
 * Produces `transition-effects.svg`.
 */
async function buildEffects(pg: Page): Promise<void> {
  clearEmbeddedFonts();
  // A fixed-position badge so the (manually built) shine overlay can sit over it
  // at known coordinates — the CLI's selector-`anchor` resolution isn't in play
  // for hand-built frames.
  const badge = { x: 30, y: H - 30 - 34, w: 132, h: 34 };
  const html = scene({ bg: INDIGO, chip: "Effects", accent: "#7c9cff", body:
    `<div class="h">Spring + Shine</div><div class="sub">DM-1542</div>
     <div class="card" data-domotion-anim="springcard" style="margin-top:18px">
       <b>Damped spring</b><div class="sub">Overshoots, then settles to rest.</div>
     </div>
     <div style="position:absolute;left:${badge.x}px;top:${badge.y}px;width:${badge.w}px;height:${badge.h}px;display:flex;align-items:center;justify-content:center;color:#0a0f1e;background:#fbbf24;border-radius:8px;font-weight:800;letter-spacing:0.08em">PRO · SHINE</div>` });
  const cap = await capture(pg, html, "fx-");
  const frame: AnimationFrame = {
    svgContent: cap.svg,
    duration: 2600,
    animations: [{
      animId: "springcard", property: "translateX", from: "-260px", to: "0px",
      duration: 1400, delay: 200,
      // The sampled multi-oscillation spring, baked to a CSS linear(...) curve.
      easing: EASING_PRESETS["spring-bouncy"],
      fuse: [{ property: "opacity", from: "0", to: "1" }],
    }],
    overlays: [
      // The shine shimmer sweeps the badge box repeatedly. DM-1551: `radius: 8`
      // matches the badge's `border-radius:8px` so the glint follows its rounded
      // corners instead of showing square edges.
      { kind: "shine", x: badge.x, y: badge.y, width: badge.w, height: badge.h, radius: 8, delay: 900, duration: 850, repeat: "infinite", repeatPeriodMs: 2000 },
    ],
  };
  let svg = generateAnimatedSvg({ width: W, height: H, frames: [frame], fontFaceCss: getEmbeddedFontFaceCss(), background: "#0a0f1e" });
  svg = optimizeSvg(svg);
  const out = resolve(OUT_DIR, "transition-effects.svg");
  writeFileSync(out, svg);
  console.log(`Generated: ${out} (${(svg.length / 1024).toFixed(1)} KB)`);
}

void main();

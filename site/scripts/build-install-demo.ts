/**
 * Build the redesigned install-demo animation (DM-207, refined in DM-212).
 *
 * Storyboard:
 *  1. Terminal with "$ npm install domotion" — typed-text element is wrapped
 *     in a `data-domotion-anim="cmd1"` span and revealed left-to-right via
 *     a `clipPath` intra-frame animation. Because the same captured glyph
 *     paths are reused in subsequent frames, there's no font-rendering
 *     mismatch when the "typing" finishes (DM-212 fix).
 *  2. Cut to "resolving dependencies…" + empty progress bar; intra-frame
 *     `transform: scaleX(0)→scaleX(1)` fills the bar over 2 s.
 *  3. Cut to install-complete state; hold 2 s.
 *  4. Same state + a second prompt "$ domotion capture …"; revealed via
 *     the same clipPath-reveal pattern (cmd2).
 *  5. Cut to terminal showing capture output. The new lines start below
 *     the viewport (pushed down by margin-top); a translateY animation on
 *     the wrapper slides everything UP so the new lines smoothly scroll
 *     into view (DM-212 fix — replaces the abrupt "all-content-appears"
 *     jump in the previous storyboard).
 *  6. A phone-framed nytimes.svg preview slides in from the bottom.
 *
 * The phone-framed preview is captured up front from `install-demo/example.html`
 * (a NYT-styled fragment) with `--chrome phone` and inlined as an SvgOverlay
 * on the final frame.
 *
 * Run via `npx tsx site/scripts/build-install-demo.ts`.
 */

import { writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureElementTree,
  elementTreeToSvg,
  generateAnimatedSvg,
  getGlyphDefs,
  clearGlyphDefs,
  optimizeSvg,
  launchChromium,
  type AnimationFrame,
} from "../../src/index.js";

const SITE_DIR = dirname(fileURLToPath(import.meta.url)) + "/..";
const ASSETS = resolve(SITE_DIR, "assets/img");
const FRAMES_DIR = resolve(SITE_DIR, "scripts/install-demo");

const W = 720, H = 320;

// Authoring helpers — every frame shares the same outer terminal styling so
// the captured glyph paths line up identically across frames (which is what
// lets the clipPath-reveal "typing" trick avoid any visual shift).
function shellHeader(): string {
  return `
    <div style="margin-bottom:6px;">
      <span style="color:#9d7cd8;font-weight:700;">~/my-app</span>
      <span style="color:#666;">&nbsp;on&nbsp;</span>
      <span style="color:#56d364;">main</span>
      <span style="color:#666;">&nbsp;via&nbsp;</span>
      <span style="color:#79c0ff;">⬢ v22.4.0</span>
    </div>`;
}
function terminalDoc(body: string): string {
  return `<!doctype html><html><body style="margin:0;background:#1e1e2e;font-family:'SF Mono',Menlo,Monaco,monospace;color:#e6edf3;">
    <div style="padding:24px 28px;font-size:13px;line-height:1.7;">
${body}
    </div>
  </body></html>`;
}
function dollar(): string {
  return `<span style="color:#28c840;font-weight:700;">$</span>&nbsp;`;
}

// The two typed commands. Wrapping each in a span tagged with
// data-domotion-anim lets the animator apply a clip-path keyframe to that
// specific captured `<g>`. The element exists in every subsequent frame too
// (so the merge / per-frame paths render identical paths there), and the
// keyframe lands `clip-path: inset(0 0 0 0)` after typing finishes — i.e.
// fully visible — so later frames are visually unaffected.
const CMD1 = `<span data-domotion-anim="cmd1">npm install domotion</span>`;
const CMD2 = `<span data-domotion-anim="cmd2">domotion capture https://www.nytimes.com -o nytimes.svg</span>`;

// Frame 0: prompt with "npm install domotion" present but clipped to width 0
// at the start of the scene; the cmd1 clipPath animation reveals it.
const FRAME_0 = terminalDoc(`${shellHeader()}<div>${dollar()}${CMD1}</div>`);

// Frame 1: cmd1 fully revealed + "resolving dependencies…" line + empty
// progress bar. The fill div carries data-domotion-anim so the animator
// keyframes can target it.
const FRAME_1 = terminalDoc(`${shellHeader()}
    <div>${dollar()}${CMD1}</div>
    <div style="color:#7dd3fc;margin-top:6px;">⠼ resolving dependencies…</div>
    <div style="margin-top:8px;height:6px;width:100%;border-radius:3px;background:#2a2a3a;overflow:hidden;">
      <div data-domotion-anim="bar" style="height:100%;width:100%;background:linear-gradient(90deg,#7dd3fc,#a78bfa);transform-origin:left;"></div>
    </div>`);

// Frame 2: install complete.
const FRAME_2 = terminalDoc(`${shellHeader()}
    <div>${dollar()}${CMD1}</div>
    <div style="color:#56d364;margin-top:6px;font-weight:700;">✓ added 12 packages in 1.4s</div>
    <div style="color:#8b949e;margin-top:4px;">  <span style="color:#79c0ff;">domotion</span>@<span style="color:#d2a8ff;">0.1.0</span></div>
    <div style="color:#8b949e;">  └─ <span style="color:#79c0ff;">@playwright/test</span>@<span style="color:#d2a8ff;">1.59.1</span></div>`);

// Frame 3: install complete + second prompt (cmd2 hidden via clipPath until
// the cmd2 reveal animation runs during this frame's hold).
const FRAME_3 = terminalDoc(`${shellHeader()}
    <div>${dollar()}${CMD1}</div>
    <div style="color:#56d364;margin-top:6px;font-weight:700;">✓ added 12 packages in 1.4s</div>
    <div style="color:#8b949e;margin-top:4px;">  <span style="color:#79c0ff;">domotion</span>@<span style="color:#d2a8ff;">0.1.0</span></div>
    <div style="color:#8b949e;">  └─ <span style="color:#79c0ff;">@playwright/test</span>@<span style="color:#d2a8ff;">1.59.1</span></div>
    <div style="margin-top:10px;">${dollar()}${CMD2}</div>`);

// Frame 4: capture run — full transcript. The new lines (the [domotion]…
// download chatter and the "Wrote" confirmation) sit inside an inner div
// pushed down by margin-top so they START below the viewport bottom edge.
// A translateY animation on the OUTER scroll wrapper slides everything up
// over ~1.5s, smoothly revealing the new lines AND scrolling the older
// install-complete chatter off the top — this replaces the previous
// abrupt cut where all 13 lines appeared at once.
//
// Layout math (font-size 13 × line-height 1.7 ≈ 22 px/line):
//   block 1 (shellHeader → "$ domotion capture") ends ~y=182.
//   margin-top:130 pushes block 2 to start at y=312 (just past viewport
//   bottom edge of 320, so it's hidden at translateY=0).
//   At translateY=-240, block 1's last line is at y=-58 (off the top) and
//   block 2 spans y≈72 to y≈204 — sitting in the upper-middle of the
//   viewport like a real terminal that's just scrolled.
//
// Capture height is intentionally bumped (see captureFrame call below) so
// the lines past y=320 aren't culled by the in-page viewport bounds check.
const FRAME_4 = terminalDoc(`<div data-domotion-anim="scroll" style="transform:translateY(0);">
${shellHeader()}
    <div>${dollar()}${CMD1}</div>
    <div style="color:#56d364;margin-top:6px;font-weight:700;">✓ added 12 packages in 1.4s</div>
    <div style="color:#8b949e;margin-top:4px;">  <span style="color:#79c0ff;">domotion</span>@<span style="color:#d2a8ff;">0.1.0</span></div>
    <div style="color:#8b949e;">  └─ <span style="color:#79c0ff;">@playwright/test</span>@<span style="color:#d2a8ff;">1.59.1</span></div>
    <div style="margin-top:10px;">${dollar()}${CMD2}</div>
    <div style="margin-top:130px;">
      <div style="color:#7dd3fc;">[domotion] Chromium binary not found — installing…</div>
      <div style="color:#8b949e;">  Downloading Chromium 1217 (143 MB)…</div>
      <div style="color:#56d364;">  ✓ Chromium installed in 8.2s</div>
      <div style="color:#8b949e;margin-top:4px;">  Capturing https://www.nytimes.com (1280×720)…</div>
      <div style="color:#56d364;margin-top:4px;">Wrote nytimes.svg (38.2 KB)</div>
      <div style="margin-top:10px;">${dollar()}<span style="display:inline-block;width:8px;height:14px;background:#e6edf3;vertical-align:middle;margin-left:2px;"></span></div>
    </div>
</div>`);

async function main(): Promise<void> {
  const browser = await launchChromium();
  try {
    const ctx = await browser.newContext({ viewport: { width: W, height: H } });
    const page = await ctx.newPage();

    // Hoist glyph defs to the top-level <defs> so multiple frames can share
    // them without ID collisions in the per-frame-atomic render path.
    clearGlyphDefs();
    // captureH defaults to the visible viewport (H), but Frame 4 needs a
    // taller capture region: its scroll content extends past y=320 so the
    // bottom transcript lines would otherwise be culled by the in-page
    // viewport bounds check (see dom-to-svg.ts capture-side culling).
    // The rendered SVG viewBox stays at W×H — off-screen elements still
    // exist in the markup and become visible after the translateY scroll.
    async function captureFrame(html: string, idPrefix: string, captureH: number = H): Promise<string> {
      await page.setViewportSize({ width: W, height: captureH });
      await page.setContent(html);
      await page.evaluate(() => document.fonts.ready);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: captureH });
      return elementTreeToSvg(tree, W, H, idPrefix, /* includeGlyphDefs */ false);
    }

    // Frame captures.
    const f0 = await captureFrame(FRAME_0, "f0-");
    const f1 = await captureFrame(FRAME_1, "f1-");
    const f2 = await captureFrame(FRAME_2, "f2-");
    const f3 = await captureFrame(FRAME_3, "f3-");
    const f4 = await captureFrame(FRAME_4, "f4-", 500);

    // Pre-capture the phone preview separately and inline it inside a
    // hand-rolled phone bezel. (DM-224 dropped the `wrapWithChrome` helper —
    // device chrome is now the consumer's job, so the bezel lives here.)
    const CONTENT_W = 240, CONTENT_H = 180;
    const exampleHtml = readFileSync(resolve(FRAMES_DIR, "example.html"), "utf8");
    const ctx2 = await browser.newContext({ viewport: { width: CONTENT_W, height: CONTENT_H } });
    const page2 = await ctx2.newPage();
    await page2.setContent(exampleHtml);
    await page2.evaluate(() => document.fonts.ready);
    const exampleTree = await captureElementTree(page2, "body", { x: 0, y: 0, width: CONTENT_W, height: CONTENT_H });
    const exampleInner = elementTreeToSvg(exampleTree, CONTENT_W, CONTENT_H, "ex-", /* includeGlyphDefs */ false);
    const PHONE_PAD = 12, PHONE_STATUS = 44, PHONE_HOME = 34;
    const PHONE_OUTER_W = CONTENT_W + PHONE_PAD * 2;
    const PHONE_OUTER_H = CONTENT_H + PHONE_PAD * 2 + PHONE_STATUS + PHONE_HOME;
    const phoneOverlaySvg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PHONE_OUTER_W} ${PHONE_OUTER_H}" width="${PHONE_OUTER_W}" height="${PHONE_OUTER_H}">`
      // Outer body, inner screen, notch, status-bar time, home indicator.
      + `<rect width="${PHONE_OUTER_W}" height="${PHONE_OUTER_H}" rx="40" fill="#1a1a1a" />`
      + `<rect x="${PHONE_PAD}" y="${PHONE_PAD}" width="${CONTENT_W}" height="${PHONE_OUTER_H - PHONE_PAD * 2}" rx="4" fill="#0d1117" />`
      + `<rect x="${PHONE_OUTER_W / 2 - 60}" y="${PHONE_PAD}" width="120" height="28" rx="12" fill="#1a1a1a" />`
      + `<text x="${PHONE_PAD + 16}" y="${PHONE_PAD + 28}" font-family="-apple-system, sans-serif" font-size="12" font-weight="600" fill="#e6edf3">9:41</text>`
      + `<rect x="${PHONE_OUTER_W / 2 - 67}" y="${PHONE_OUTER_H - PHONE_PAD - 20}" width="134" height="5" rx="2.5" fill="#e6edf3" opacity="0.3" />`
      + `<g transform="translate(${PHONE_PAD}, ${PHONE_PAD + PHONE_STATUS})">${exampleInner}</g>`
      + `</svg>`;
    await ctx2.close();

    // Compose frames. Cut transitions everywhere — the merge fast-path is
    // skipped because of the SVG overlay on the last frame, but cut keeps the
    // visual boundaries crisp regardless of which path runs.
    //
    // Both clipPath reveal animations use steps(N) easing so the reveal is
    // discrete (one character at a time) rather than a smooth slide — that
    // matches what real keyboard typing feels like. N is chosen as the
    // character count so each step exposes one glyph.
    const frames: AnimationFrame[] = [
      // 0. type "npm install domotion" via clipPath reveal on cmd1.
      // Hold = reveal duration + a beat of trailing pause.
      {
        svgContent: f0,
        duration: 1500,
        transition: { type: "cut", duration: 0 },
        animations: [{
          animId: "cmd1",
          property: "clipPath",
          from: "inset(0 100% 0 0)",
          to: "inset(0 0 0 0)",
          duration: 1200,
          easing: "steps(20)",
          delay: 100,
        }],
      },
      // 1. progress bar fills.
      {
        svgContent: f1,
        duration: 2200,
        transition: { type: "cut", duration: 0 },
        animations: [{
          animId: "bar",
          property: "transform",
          from: "scaleX(0)",
          to: "scaleX(1)",
          duration: 2000,
          easing: "ease-out",
          delay: 150,
        }],
      },
      // 2. install complete — hold.
      {
        svgContent: f2,
        duration: 1800,
        transition: { type: "cut", duration: 0 },
      },
      // 3. type "domotion capture …" via clipPath reveal on cmd2.
      {
        svgContent: f3,
        duration: 2500,
        transition: { type: "cut", duration: 0 },
        animations: [{
          animId: "cmd2",
          property: "clipPath",
          from: "inset(0 100% 0 0)",
          to: "inset(0 0 0 0)",
          duration: 2200,
          easing: "steps(50)",
          delay: 100,
        }],
      },
      // 4. capture output streams in via the smooth-scroll animation; then
      // mid-frame, the mobile preview slides in from the bottom over the
      // scrolled-up terminal. Combined into one frame so the scroll
      // translateY animation isn't trampled by a same-animId rule from a
      // later frame (the animator emits one `.anim-scroll { animation: … }`
      // declaration per (frame, animId) pair, and the cascade keeps only the
      // last — splitting these states across two frames silently broke the
      // first frame's scroll motion).
      {
        svgContent: f4,
        duration: 5500,
        transition: { type: "cut", duration: 0 },
        animations: [{
          animId: "scroll",
          property: "translateY",
          from: "0px",
          to: "-240px",
          duration: 1500,
          easing: "ease-out",
          delay: 600,
        }],
        overlays: [{
          kind: "svg",
          innerSvg: phoneOverlaySvg,
          x: (W - PHONE_OUTER_W) / 2,
          y: H - PHONE_OUTER_H - 8,
          width: PHONE_OUTER_W,
          height: PHONE_OUTER_H,
          animId: "preview",
          enter: { from: "bottom", duration: 700, easing: "ease-out", delay: 2700 },
        }],
      },
    ];

    // Collect ALL glyph defs accumulated across the frame captures and the
    // phone-overlay capture so they're available at the top of the final SVG.
    const sharedDefs = getGlyphDefs();
    const svg = optimizeSvg(generateAnimatedSvg({ width: W, height: H, frames, sharedDefs }));
    writeFileSync(resolve(ASSETS, "install-demo.svg"), svg);
    console.log(`Wrote install-demo.svg (${(svg.length / 1024).toFixed(1)} KB, ${frames.length} frames)`);
  } finally {
    await browser.close();
  }
}

void main();

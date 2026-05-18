/**
 * Build the install-demo animation shown on the consumer site landing page.
 *
 * Storyboard:
 *  1. Terminal with "$ npm install domotion-svg" — typed-text element is wrapped
 *     in a `data-domotion-anim="cmd1"` span and revealed left-to-right via
 *     a `clipPath` intra-frame animation. Because the same captured glyph
 *     paths are reused in subsequent frames, there's no font-rendering
 *     mismatch when the "typing" finishes.
 *  2. Cut to "resolving dependencies…" + empty progress bar; intra-frame
 *     `transform: scaleX(0)→scaleX(1)` fills the bar over 2 s.
 *  3. Cut to install-complete state; hold.
 *  4. Same state + a second prompt "$ domotion capture …"; revealed via
 *     the same clipPath-reveal pattern (cmd2).
 *  5. Cut to terminal showing capture output. A phone-framed nytimes
 *     preview slides in from the bottom.
 *
 * The phone-framed preview is a pre-captured snapshot of nytimes.com mobile
 * (see `tools/capture-nytimes-snapshot.ts`). The snapshot SVG is embedded
 * directly inside the phone bezel as a nested `<svg>`. Re-run the capture
 * tool periodically to refresh the snapshot.
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
const CMD1 = `<span data-domotion-anim="cmd1">npm install domotion-svg</span>`;
const CMD2 = `<span data-domotion-anim="cmd2">domotion capture https://www.nytimes.com -o nytimes.svg</span>`;

// Frame 0: prompt with "npm install domotion-svg" present but clipped to width 0
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

// Frame 4: capture run — the new lines ("Capturing…", "Wrote…", next prompt)
// appear directly under the typed `domotion capture` command, like normal
// terminal output. The viewport (720×320) comfortably fits all of it, so
// there's no scroll-into-view animation — the cut just shows the completed
// transcript and the phone preview slides in over it.
const FRAME_4 = terminalDoc(`${shellHeader()}
    <div>${dollar()}${CMD1}</div>
    <div style="color:#56d364;margin-top:6px;font-weight:700;">✓ added 12 packages in 1.4s</div>
    <div style="color:#8b949e;margin-top:4px;">  <span style="color:#79c0ff;">domotion</span>@<span style="color:#d2a8ff;">0.1.0</span></div>
    <div style="color:#8b949e;">  └─ <span style="color:#79c0ff;">@playwright/test</span>@<span style="color:#d2a8ff;">1.59.1</span></div>
    <div style="margin-top:10px;">${dollar()}${CMD2}</div>
    <div style="color:#8b949e;margin-top:4px;">  Capturing https://www.nytimes.com (390×844)…</div>
    <div style="color:#56d364;margin-top:4px;">Wrote nytimes.svg (38.2 KB)</div>
    <div style="margin-top:10px;">${dollar()}<span style="display:inline-block;width:8px;height:14px;background:#e6edf3;vertical-align:middle;margin-left:2px;"></span></div>`);

async function main(): Promise<void> {
  const browser = await launchChromium();
  try {
    const ctx = await browser.newContext({ viewport: { width: W, height: H } });
    const page = await ctx.newPage();

    // Hoist glyph defs to the top-level <defs> so multiple frames can share
    // them without ID collisions in the per-frame-atomic render path.
    clearGlyphDefs();
    async function captureFrame(html: string, idPrefix: string): Promise<string> {
      await page.setViewportSize({ width: W, height: H });
      await page.setContent(html);
      await page.evaluate(() => document.fonts.ready);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
      return elementTreeToSvg(tree, W, H, idPrefix, /* includeGlyphDefs */ false);
    }

    // Frame captures.
    const f0 = await captureFrame(FRAME_0, "f0-");
    const f1 = await captureFrame(FRAME_1, "f1-");
    const f2 = await captureFrame(FRAME_2, "f2-");
    const f3 = await captureFrame(FRAME_3, "f3-");
    const f4 = await captureFrame(FRAME_4, "f4-");

    // Embed the pre-captured nytimes.com snapshot inside a portrait phone
    // bezel. The snapshot SVG (viewBox 390×600) is read from disk and nested
    // inside the bezel; its width/height attributes are dropped so the
    // `preserveAspectRatio` on the inner `<svg>` scales it to fit the phone
    // screen. Refresh by re-running `tools/capture-nytimes-snapshot.ts`.
    const SNAP_W = 390, SNAP_H = 600;
    const snapshotRaw = readFileSync(resolve(FRAMES_DIR, "nytimes-snapshot.svg"), "utf8");
    const snapshotInner = snapshotRaw.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
    // Phone proportions tuned to fit the 720×320 install-demo canvas while
    // preserving the snapshot's 390:600 (≈0.65:1) portrait aspect ratio.
    const CONTENT_W = 162, CONTENT_H = 250;
    const PHONE_PAD = 8, PHONE_STATUS = 18, PHONE_HOME = 14;
    const PHONE_OUTER_W = CONTENT_W + PHONE_PAD * 2;
    const PHONE_OUTER_H = CONTENT_H + PHONE_PAD * 2 + PHONE_STATUS + PHONE_HOME;
    const phoneOverlaySvg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PHONE_OUTER_W} ${PHONE_OUTER_H}" width="${PHONE_OUTER_W}" height="${PHONE_OUTER_H}">`
      // Outer body, inner screen, dynamic-island notch, home indicator.
      + `<rect width="${PHONE_OUTER_W}" height="${PHONE_OUTER_H}" rx="22" fill="#1a1a1a" />`
      + `<rect x="${PHONE_PAD}" y="${PHONE_PAD}" width="${CONTENT_W}" height="${PHONE_OUTER_H - PHONE_PAD * 2}" rx="3" fill="#fff" />`
      + `<rect x="${PHONE_OUTER_W / 2 - 30}" y="${PHONE_PAD + 4}" width="60" height="12" rx="6" fill="#1a1a1a" />`
      + `<rect x="${PHONE_OUTER_W / 2 - 28}" y="${PHONE_OUTER_H - PHONE_PAD - 6}" width="56" height="3" rx="1.5" fill="#1a1a1a" opacity="0.5" />`
      // Nested snapshot — `xMidYMin slice` anchors to the top of the page and
      // crops the bottom if the bezel aspect doesn't exactly match the snapshot.
      + `<svg x="${PHONE_PAD}" y="${PHONE_PAD + PHONE_STATUS}" width="${CONTENT_W}" height="${CONTENT_H}" viewBox="0 0 ${SNAP_W} ${SNAP_H}" preserveAspectRatio="xMidYMin slice">${snapshotInner}</svg>`
      + `</svg>`;

    // Compose frames. Cut transitions everywhere — the merge fast-path is
    // skipped because of the SVG overlay on the last frame, but cut keeps the
    // visual boundaries crisp regardless of which path runs.
    //
    // Both clipPath reveal animations use steps(N) easing so the reveal is
    // discrete (one character at a time) rather than a smooth slide — that
    // matches what real keyboard typing feels like. N is chosen as the
    // character count so each step exposes one glyph.
    const frames: AnimationFrame[] = [
      // 0. type "npm install domotion-svg" via clipPath reveal on cmd1.
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
      // 4. capture output is on-screen at frame entry; after a short pause the
      // mobile preview slides in from the bottom over the static terminal.
      {
        svgContent: f4,
        duration: 4500,
        transition: { type: "cut", duration: 0 },
        overlays: [{
          kind: "svg",
          innerSvg: phoneOverlaySvg,
          x: (W - PHONE_OUTER_W) / 2,
          y: H - PHONE_OUTER_H - 8,
          width: PHONE_OUTER_W,
          height: PHONE_OUTER_H,
          animId: "preview",
          enter: { from: "bottom", duration: 700, easing: "ease-out", delay: 1500 },
        }],
      },
    ];

    // Collect ALL glyph defs accumulated across the frame captures and the
    // phone-overlay capture so they're available at the top of the final SVG.
    const sharedDefs = getGlyphDefs();
    // Frame-visibility keyframes emitted by the animator toggle BOTH
    // `opacity` and `display` (intended as a paint-skip optimisation). When
    // the base `.f { display: none }` lands together with infinite animations
    // whose first keyframe is `display: inline`, Chromium leaves the element
    // out of the render tree from t=0 and never ticks the animation — every
    // frame stays hidden. Strip the `display` toggles so visibility runs on
    // opacity only, matching the install-demo as shipped in v0.2.2.
    const rawSvg = optimizeSvg(generateAnimatedSvg({ width: W, height: H, frames, sharedDefs }));
    const svg = rawSvg
      .replace(/;display:(?:none|inline)/g, "")
      .replace(/\.f\{opacity:0;display:none\}/g, ".f{opacity:0}");
    writeFileSync(resolve(ASSETS, "install-demo.svg"), svg);
    console.log(`Wrote install-demo.svg (${(svg.length / 1024).toFixed(1)} KB, ${frames.length} frames)`);
  } finally {
    await browser.close();
  }
}

void main();

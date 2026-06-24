/**
 * Showcase: Transition Types
 *
 * Demonstrates all supported transitions:
 * 1. crossfade — scene change (home → different context)
 * 2. push-left — page navigation (page A → page B)
 * 3. scroll — same-page scroll (tall content panning down)
 *
 * Also demonstrates overlays: typing and tap ripple.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { captureElementTree, elementTreeToSvgInner, embedRemoteImages } from "../src/render/element-tree-to-svg.js";
import { generateAnimatedSvg, type AnimationFrame } from "../src/animation/animator.js";
import { clearEmbeddedFonts, getEmbeddedFontFaceCss } from "../src/render/index.js";
import { optimizeSvg } from "./shared.js";

const WIDTH = 800;
const HEIGHT = 500;
const OUT_DIR = resolve("examples/output");
const OUTPUT = resolve(OUT_DIR, "showcase-transitions.svg");

function page(body: string, extraHeight?: number): string {
  const h = extraHeight ?? HEIGHT;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; overflow: hidden; }
.page { padding: 32px; width: ${WIDTH}px; min-height: ${h}px; }
h1 { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
h2 { font-size: 16px; font-weight: 600; margin-bottom: 8px; color: #e6edf3; }
p { font-size: 14px; color: #8b949e; line-height: 1.6; margin-bottom: 12px; }
.search-bar { background: #161b22; border: 1px solid #30363d; border-radius: 20px; padding: 10px 20px; color: #8b949e; font-size: 14px; width: 400px; margin-bottom: 24px; }
.card { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 16px; margin-bottom: 12px; }
.card-title { font-weight: 600; color: #58a6ff; font-size: 14px; margin-bottom: 4px; }
.card-desc { font-size: 13px; color: #8b949e; margin-bottom: 4px; }
.card-meta { font-size: 12px; color: #6e7681; }
.nav { display: flex; gap: 16px; align-items: center; padding: 12px 0; border-bottom: 1px solid #30363d; margin-bottom: 24px; }
.nav-logo { font-weight: 700; font-size: 18px; color: #e6edf3; }
.nav-link { color: #8b949e; font-size: 14px; }
.breadcrumb { font-size: 12px; color: #8b949e; margin-bottom: 16px; }
.breadcrumb a { color: #58a6ff; }
pre { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px 16px; font-family: 'SF Mono', Menlo, monospace; font-size: 13px; margin-bottom: 16px; }
.install-cmd { display: flex; align-items: center; background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 10px 16px; margin-bottom: 20px; }
.install-cmd code { font-family: 'SF Mono', Menlo, monospace; font-size: 13px; color: #e6edf3; }
.tag { display: inline-block; padding: 3px 10px; background: #161b22; border: 1px solid #30363d; border-radius: 12px; font-size: 12px; color: #8b949e; margin-right: 4px; }
.section { margin-top: 20px; }
.label { font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
.version-list { list-style: none; }
.version-list li { padding: 8px 0; border-bottom: 1px solid #30363d; font-size: 14px; }
.version-list a { color: #58a6ff; }
.hero { text-align: center; padding: 48px 0 32px; }
.hero h1 { font-size: 36px; font-weight: 800; }
.hero p { font-size: 16px; }
.cta { display: flex; gap: 12px; justify-content: center; margin-top: 16px; }
.btn { display: inline-block; padding: 10px 24px; border-radius: 6px; font-size: 14px; font-weight: 600; }
.btn-primary { background: #238636; color: white; }
.btn-secondary { background: #161b22; border: 1px solid #30363d; color: #e6edf3; }
</style></head><body><div class="page">${body}</div></body></html>`;
}

// Frame 1: Home page (scene start)
const HOME_HTML = page(`
  <div class="hero">
    <h1>Domotion</h1>
    <p>HTML/CSS → self-contained, animated SVG</p>
    <div style="max-width: 400px; margin: 24px auto 0;">
      <div class="search-bar">Search the docs...</div>
    </div>
    <div class="cta">
      <span class="btn btn-primary">Get started</span>
      <span class="btn btn-secondary">Browse demos</span>
    </div>
  </div>
  <h2 style="margin-top: 24px;">Tools</h2>
  <div class="card">
    <div class="card-title">domotion capture</div>
    <div class="card-desc">Capture a URL / HTML file as a self-contained SVG</div>
    <div class="card-meta">one frame · text as glyph paths</div>
  </div>
  <div class="card">
    <div class="card-title">domotion term</div>
    <div class="card-desc">Terminal recording → animated SVG</div>
    <div class="card-meta">real color · native SVG</div>
  </div>
`);

// Frame 2: Search results (push-left from home)
const SEARCH_HTML = page(`
  <div class="nav">
    <span class="nav-logo">Domotion</span>
    <span class="nav-link">Docs</span>
    <span class="nav-link">Demos</span>
  </div>
  <h1>Search: "terminal"</h1>
  <p>3 results</p>
  <div class="card">
    <div class="card-title">domotion term --cast</div>
    <div class="card-desc">Convert an asciinema recording into an animated terminal SVG</div>
    <div class="card-meta">incremental / full mode · theming · doc 67</div>
  </div>
  <div class="card">
    <div class="card-title">domotion composite</div>
    <div class="card-desc">Layer animated SVGs — a terminal window on a desktop</div>
    <div class="card-meta">independent timelines · animation preserved · doc 77</div>
  </div>
  <div class="card">
    <div class="card-title">animated-svg-scrubber</div>
    <div class="card-desc">Play / scrub / trim / export-frame an animated SVG locally</div>
    <div class="card-meta">video-style bench · doc 56</div>
  </div>
`);

// Frame 3: Feature detail (push-left from search, then scrolls)
const DETAIL_HTML = page(`
  <div class="nav">
    <span class="nav-logo">Domotion</span>
    <span class="nav-link">Docs</span>
    <span class="nav-link">Demos</span>
  </div>
  <div class="breadcrumb"><a href="#">Docs</a> / CLI / domotion term</div>
  <h1>domotion term</h1>
  <p>Turn a recorded terminal session into a self-contained animated SVG</p>
  <div class="install-cmd"><code>npm install domotion-svg</code></div>
  <div style="display: flex; gap: 24px; margin-bottom: 20px;">
    <div><span class="label">FORMAT</span><p>asciinema v2</p></div>
    <div><span class="label">OUTPUT</span><p>animated SVG</p></div>
    <div><span class="label">TEXT</span><p>glyph paths</p></div>
    <div><span class="label">TAGS</span><div><span class="tag">terminal</span><span class="tag">animated</span></div></div>
  </div>
  <h2>Output characteristics</h2>
  <pre>## Self-contained animated SVG

- No external fonts, images, or scripts
- Embeds with &lt;img src="out.svg"&gt; — animations play
- Text is real glyph paths — identical across browsers
- Scales crisply at any size
- Optional SVGO optimize pass (--optimize)
- Pixel-faithful to Chromium on the capturing OS</pre>
  <div class="section">
    <h2>Recent</h2>
    <ul class="version-list">
      <li><a href="#">composite</a> — nested animated compositing</li>
      <li><a href="#">chart / chat</a> — data + social templates</li>
      <li><a href="#">term</a> — terminal capture → animated SVG</li>
    </ul>
  </div>
`, 900); // extra tall for scroll

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  const pg = await context.newPage();

  const frames: AnimationFrame[] = [];
  clearEmbeddedFonts(); // DM-1225: emit the embedded font once, not per frame

  // Frame 1: Home (crossfade in, typing overlay on search bar)
  const tmpHome = resolve(OUT_DIR, "trans-tmp-0.html");
  writeFileSync(tmpHome, HOME_HTML);
  await pg.goto(`file://${tmpHome}`);
  await pg.waitForTimeout(200);
  // DM-512: demos emit self-contained SVGs.
  let tree = await captureElementTree(pg, "body", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
  await embedRemoteImages(tree);
  frames.push({
    svgContent: elementTreeToSvgInner(tree, WIDTH, HEIGHT, "f0-", true, 2, false),
    duration: 3500,
    transition: { type: "push-left", duration: 400 },
    overlays: [{
      kind: "typing",
      text: "terminal",
      x: 232, y: 230,
      fontSize: 14,
      color: "#e6edf3",
      delay: 800,
      speed: 60,
      bgColor: "#161b22",
      bgWidth: 200,
      bgHeight: 20,
    }],
  });

  // Frame 2: Search results (push-left in, tap on first result, push-left out)
  const tmpSearch = resolve(OUT_DIR, "trans-tmp-1.html");
  writeFileSync(tmpSearch, SEARCH_HTML);
  await pg.goto(`file://${tmpSearch}`);
  await pg.waitForTimeout(200);
  tree = await captureElementTree(pg, "body", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
  await embedRemoteImages(tree);
  frames.push({
    svgContent: elementTreeToSvgInner(tree, WIDTH, HEIGHT, "f1-", true, 2, false),
    duration: 3000,
    transition: { type: "push-left", duration: 400 },
    overlays: [{
      kind: "tap",
      x: 300, y: 210,
      delay: 1500,
    }],
  });

  // Frame 3: Snippet detail — tall page for scroll
  // NOTE (DM-609): the `scroll` transition now means real geometric vertical
  // push between two frames (outgoing slides up off the top while incoming
  // slides up from the bottom), not opacity-only as it used to be. This
  // frame's tall (900 px) content visually pushes off when the cycle wraps;
  // if you want the page CONTENT to scroll within a fixed viewport, capture
  // via `domotion capture --scroll "<pattern>"` (the new scroll-demo CLI
  // flow) or use an intra-frame `translateY` animation on the body subtree.
  const tmpDetail = resolve(OUT_DIR, "trans-tmp-2.html");
  writeFileSync(tmpDetail, DETAIL_HTML);
  await pg.goto(`file://${tmpDetail}`);
  await pg.waitForTimeout(200);
  // Capture the full tall page
  const fullTree = await captureElementTree(pg, "body", { x: 0, y: 0, width: WIDTH, height: 900 });
  const fullSvg = elementTreeToSvgInner(fullTree, WIDTH, 900, "f2-", true, 2, false);
  // Wrap in a group with scroll animation
  frames.push({
    svgContent: fullSvg,
    duration: 5000,
    transition: { type: "scroll", duration: 2000 },
  });

  await browser.close();

  let svg = generateAnimatedSvg({ width: WIDTH, height: HEIGHT, frames, fontFaceCss: getEmbeddedFontFaceCss() });
  svg = optimizeSvg(svg);
  writeFileSync(OUTPUT, svg);
  console.log(`Generated: ${OUTPUT} (${(svg.length / 1024).toFixed(1)} KB)`);
}

void main();

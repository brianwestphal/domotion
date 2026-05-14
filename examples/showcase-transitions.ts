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
import { captureElementTree, elementTreeToSvg, embedRemoteImages } from "../src/render/element-tree-to-svg.js";
import { generateAnimatedSvg, type AnimationFrame } from "../src/animation/animator.js";
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
    <h1>SliceKit</h1>
    <p>Snippet Library for Instruction Context Exchange</p>
    <div style="max-width: 400px; margin: 24px auto 0;">
      <div class="search-bar">Search snippets and stacks...</div>
    </div>
    <div class="cta">
      <span class="btn btn-primary">Get started</span>
      <span class="btn btn-secondary">Browse snippets</span>
    </div>
  </div>
  <h2 style="margin-top: 24px;">Popular</h2>
  <div class="card">
    <div class="card-title">@community/error-handling-patterns</div>
    <div class="card-desc">Structured error handling with typed errors</div>
    <div class="card-meta">42/100 · 1,234 downloads</div>
  </div>
  <div class="card">
    <div class="card-title">@community/typescript-strict</div>
    <div class="card-desc">TypeScript strict mode conventions</div>
    <div class="card-meta">38/100 · 987 downloads</div>
  </div>
`);

// Frame 2: Search results (push-left from home)
const SEARCH_HTML = page(`
  <div class="nav">
    <span class="nav-logo">SliceKit</span>
    <span class="nav-link">Browse</span>
    <span class="nav-link">Help</span>
  </div>
  <h1>Search: "error handling"</h1>
  <p>3 results</p>
  <div class="card">
    <div class="card-title">@community/error-handling-patterns</div>
    <div class="card-desc">Structured error handling with typed errors and Result patterns</div>
    <div class="card-meta">Score: 42/100 · 1,234 downloads · universal</div>
  </div>
  <div class="card">
    <div class="card-title">@community/typescript-strict-conventions</div>
    <div class="card-desc">TypeScript strict mode conventions and type safety</div>
    <div class="card-meta">Score: 38/100 · 987 downloads · universal</div>
  </div>
  <div class="card">
    <div class="card-title">@community/api-design-rest</div>
    <div class="card-desc">RESTful API design conventions and response formatting</div>
    <div class="card-meta">Score: 35/100 · 756 downloads · universal</div>
  </div>
`);

// Frame 3: Snippet detail (push-left from search, then scrolls)
const DETAIL_HTML = page(`
  <div class="nav">
    <span class="nav-logo">SliceKit</span>
    <span class="nav-link">Browse</span>
    <span class="nav-link">Help</span>
  </div>
  <div class="breadcrumb"><a href="#">Snippets</a> / @community / error-handling-patterns</div>
  <h1>@community/error-handling-patterns</h1>
  <p>Structured error handling with typed errors and Result patterns</p>
  <div class="install-cmd"><code>sk install @community/error-handling-patterns</code></div>
  <div style="display: flex; gap: 24px; margin-bottom: 20px;">
    <div><span class="label">AUTHOR</span><p><a href="#">@community</a></p></div>
    <div><span class="label">DOWNLOADS</span><p>1,234</p></div>
    <div><span class="label">RATING</span><p>92% positive</p></div>
    <div><span class="label">TAGS</span><div><span class="tag">error-handling</span><span class="tag">typescript</span></div></div>
  </div>
  <h2>Content</h2>
  <pre>## Error Handling

- Always use typed errors extending a base AppError class
- Never catch and swallow errors silently
- Use Result&lt;T, E&gt; pattern for expected failures
- Reserve try/catch for truly unexpected exceptions
- Include context in error messages
- Log errors with structured data</pre>
  <div class="section">
    <h2>Versions</h2>
    <ul class="version-list">
      <li><a href="#">v1.2.0</a> — April 20, 2026</li>
      <li><a href="#">v1.1.0</a> — April 15, 2026</li>
      <li><a href="#">v1.0.0</a> — April 10, 2026</li>
    </ul>
  </div>
`, 900); // extra tall for scroll

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  const pg = await context.newPage();

  const frames: AnimationFrame[] = [];

  // Frame 1: Home (crossfade in, typing overlay on search bar)
  const tmpHome = resolve(OUT_DIR, "trans-tmp-0.html");
  writeFileSync(tmpHome, HOME_HTML);
  await pg.goto(`file://${tmpHome}`);
  await pg.waitForTimeout(200);
  // DM-512: demos emit self-contained SVGs.
  let tree = await captureElementTree(pg, "body", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
  await embedRemoteImages(tree);
  frames.push({
    svgContent: elementTreeToSvg(tree, WIDTH, HEIGHT, "f0-"),
    duration: 3500,
    transition: { type: "push-left", duration: 400 },
    overlays: [{
      kind: "typing",
      text: "error handling",
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
    svgContent: elementTreeToSvg(tree, WIDTH, HEIGHT, "f1-"),
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
  const fullSvg = elementTreeToSvg(fullTree, WIDTH, 900, "f2-");
  // Wrap in a group with scroll animation
  frames.push({
    svgContent: fullSvg,
    duration: 5000,
    transition: { type: "scroll", duration: 2000 },
  });

  await browser.close();

  let svg = generateAnimatedSvg({ width: WIDTH, height: HEIGHT, frames });
  svg = optimizeSvg(svg);
  writeFileSync(OUTPUT, svg);
  console.log(`Generated: ${OUTPUT} (${(svg.length / 1024).toFixed(1)} KB)`);
}

void main();

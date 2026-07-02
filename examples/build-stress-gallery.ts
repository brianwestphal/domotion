/**
 * Build a single-document stress-test gallery of every generated demo SVG
 * (DM-1514). Scans `examples/output/*.svg` + `examples/output/templates/*.svg`
 * and writes `examples/output/stress-gallery.html` — a self-contained page that
 * embeds every SVG (as `<img>`, the canonical lazy-loadable embed) in one
 * document, with a load multiplier so the number of concurrently animating SVGs
 * can be cranked far past a normal page.
 *
 * Purpose: exercise browser animation compositing under load. Firefox's
 * off-main-thread animation (OMTA) demotes some animations to the main thread
 * once it exceeds its compositor budget, which can desync a unit's paired
 * opacity/transform tracks (see docs/08-animation-model.md and the viewer
 * support matrix, docs/82). Blink (Chrome/Edge/…) and WebKit (Safari) stay
 * consistent. This page is the reproduction/validation harness for that.
 *
 * Usage: npx tsx examples/build-stress-gallery.ts
 * Then open examples/output/stress-gallery.html (double-click, or serve).
 */
import { readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT_DIR = resolve("examples/output");
const SELF = "stress-gallery.html";

/** SVG files in a dir, sorted, as srcs relative to OUT_DIR. */
function svgsIn(subdir: string): string[] {
  const dir = subdir === "" ? OUT_DIR : resolve(OUT_DIR, subdir);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".svg"))
    .sort()
    .map((f) => (subdir === "" ? f : `${subdir}/${f}`));
}

const items = [...svgsIn(""), ...svgsIn("templates")];

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Domotion — stress gallery (${items.length} SVGs)</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b1020; color: #e5e9f0; font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  header { position: sticky; top: 0; z-index: 10; display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: center;
           padding: 12px 18px; background: rgba(11,16,32,0.92); backdrop-filter: blur(8px); border-bottom: 1px solid #22283a; }
  header h1 { font-size: 15px; font-weight: 700; margin: 0; letter-spacing: .01em; }
  header .muted { color: #8b93a7; }
  header .spacer { flex: 1; }
  .ctrl { display: inline-flex; gap: 6px; align-items: center; }
  .ctrl button { font: inherit; color: #e5e9f0; background: #1b2236; border: 1px solid #2d3752; border-radius: 6px;
                 padding: 5px 10px; cursor: pointer; }
  .ctrl button.active { background: #2f6df6; border-color: #2f6df6; }
  .ctrl button:hover { border-color: #3f4c70; }
  #fps { font-variant-numeric: tabular-nums; min-width: 92px; }
  #grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; padding: 16px; }
  figure { margin: 0; background: #10162a; border: 1px solid #1e2740; border-radius: 10px; overflow: hidden; }
  figure img { display: block; width: 100%; height: auto; background: #070a12; }
  figcaption { padding: 6px 10px; font-size: 12px; color: #aeb6c9; word-break: break-all; border-top: 1px solid #1e2740; }
  .note { padding: 0 18px 18px; color: #8b93a7; max-width: 70ch; }
  .note code { background: #1b2236; padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>
<header>
  <h1>Domotion stress gallery</h1>
  <span class="muted"><span id="count">0</span> animated SVGs in one document</span>
  <div class="ctrl" title="Duplicate every SVG N times to increase concurrent-animation load">
    <span class="muted">load&nbsp;×</span>
    <button data-mult="1">1</button>
    <button data-mult="3">3</button>
    <button data-mult="5">5</button>
    <button data-mult="10">10</button>
  </div>
  <div class="spacer"></div>
  <span class="muted" id="fps">fps: —</span>
</header>
<div id="grid"></div>
<p class="note">
  Each tile embeds a generated demo SVG via <code>&lt;img&gt;</code> — the canonical self-contained embed
  (CSS + SMIL animate inside <code>&lt;img&gt;</code>; scripts do not run there). All load eagerly and animate
  at once. Crank <b>load ×</b> to multiply the number of concurrently-animating SVGs and stress the browser's
  animation compositor. Watch the reveal/loop animations for a unit's fade and slide/scale drifting out of
  sync — the Firefox-under-load OMTA symptom documented in the viewer support matrix.
</p>
<script>
  // File list is baked in at generation time.
  var ITEMS = ${JSON.stringify(items)};
  var grid = document.getElementById('grid');
  var countEl = document.getElementById('count');

  function render(mult) {
    grid.textContent = '';
    var frag = document.createDocumentFragment();
    for (var n = 0; n < mult; n++) {
      for (var i = 0; i < ITEMS.length; i++) {
        var src = ITEMS[i];
        var fig = document.createElement('figure');
        var img = document.createElement('img');
        img.loading = 'eager';
        img.decoding = 'async';
        // Cache-bust duplicates so each is an independent animated instance.
        img.src = mult > 1 ? src + '?dup=' + n : src;
        img.alt = src;
        var cap = document.createElement('figcaption');
        cap.textContent = src + (mult > 1 ? '  ·  #' + (n + 1) : '');
        fig.appendChild(img);
        fig.appendChild(cap);
        frag.appendChild(fig);
      }
    }
    grid.appendChild(frag);
    countEl.textContent = String(ITEMS.length * mult);
  }

  // Load-multiplier buttons.
  var buttons = document.querySelectorAll('.ctrl button');
  function setMult(m, btn) {
    buttons.forEach(function (b) { b.classList.toggle('active', b === btn); });
    render(m);
  }
  buttons.forEach(function (b) {
    b.addEventListener('click', function () { setMult(parseInt(b.dataset.mult, 10), b); });
  });

  // Rolling FPS meter — a coarse read on how hard the compositor is working.
  var fpsEl = document.getElementById('fps');
  var frames = 0, last = performance.now();
  function tick(now) {
    frames++;
    if (now - last >= 500) {
      var fps = Math.round((frames * 1000) / (now - last));
      fpsEl.textContent = 'fps: ' + fps;
      frames = 0; last = now;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  setMult(1, document.querySelector('.ctrl button[data-mult="1"]'));
</script>
</body>
</html>
`;

const outPath = resolve(OUT_DIR, SELF);
writeFileSync(outPath, html);
process.stdout.write(`Wrote ${outPath} — ${items.length} SVGs (load ×1..×10)\n`);

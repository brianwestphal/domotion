/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

/**
 * DM-1040 / DM-1047: `animated-svg-scrubber` page-side client (bundled to
 * /client.js). Built with kerfjs — reactive signals drive the transport bar
 * (play / scrub / range / export menu / zoom presets); the loaded SVG itself
 * lives in a `data-morph-skip` host that the morph never touches, so we can
 * inject it, seek its animations, and zoom/pan it imperatively.
 *
 * Playback is DRIVEN MANUALLY rather than via `Animation.play()`: a rAF loop
 * advances a `playhead` signal and, every frame, `pause()` + sets
 * `currentTime = playhead` on each WAAPI animation AND drives the SVG document
 * timeline (`pauseAnimations` + `setCurrentTime`) so SMIL tracks too. That is
 * the exact seek the server-side exporter uses, so what you scrub to is what a
 * grabbed frame / trimmed SVG / MP4 looks like.
 */

import { signal, effect, mount, delegate } from "kerfjs";

interface Bootstrap { svg: string | null; name: string | null }
declare global { interface Window { __SCRUBBER_BOOTSTRAP__?: Bootstrap } }

const CSS = `
*{box-sizing:border-box}
body{margin:0;font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0e0f13;color:#e7e9ee}
.wrap{display:flex;flex-direction:column;height:100vh}
.stage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;
  background:repeating-conic-gradient(#1a1c22 0% 25%,#15171c 0% 50%) 50%/24px 24px;overflow:hidden;position:relative;touch-action:none}
.svg-host{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  transform-origin:center center;will-change:transform;pointer-events:none}
.svg-host svg{display:block;filter:drop-shadow(0 4px 24px rgba(0,0,0,.5))}
.drop{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;
  gap:10px;color:#9aa0ad;border:2px dashed #2a2e38;margin:18px;border-radius:12px;text-align:center;padding:24px;
  background:rgba(14,15,19,.7);cursor:pointer}
.drop.over{border-color:#5b8cff;color:#cdd5ff;background:#161b2b}
.bar{background:#15171c;border-top:1px solid #23262f;padding:10px 14px;display:flex;flex-direction:column;gap:8px}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.row2{justify-content:space-between}
.grp{display:flex;align-items:center;gap:8px}
button{background:#262a35;color:#e7e9ee;border:1px solid #333845;border-radius:7px;padding:6px 11px;cursor:pointer;font:inherit}
button:hover{background:#2f3543}button:disabled{opacity:.45;cursor:default}
button.primary{background:#3a63d8;border-color:#3a63d8}button.primary:hover{background:#4a73e8}
.play{display:inline-flex;align-items:center;justify-content:center;padding:6px 9px}
.play svg{display:block}
.iconbtn{padding:6px 8px;min-width:32px}
select,input[type=number]{background:#1c1f27;color:#e7e9ee;border:1px solid #333845;border-radius:6px;padding:5px 7px;font:inherit}
input[type=number]{width:84px}
.scrub-wrap{position:relative;flex:1;min-width:200px;display:flex;align-items:center;height:24px}
.scrub{width:100%;position:relative;z-index:2;margin:0;background:transparent}
input[type=range]{accent-color:#5b8cff}
.range-band{position:absolute;top:50%;transform:translateY(-50%);height:9px;
  background:rgba(91,140,255,.22);border:1px solid rgba(120,160,255,.5);border-radius:3px;pointer-events:none;z-index:1}
.range-tick{position:absolute;top:50%;transform:translate(-50%,-50%);width:14px;height:22px;z-index:3;
  cursor:ew-resize;display:flex;align-items:center;justify-content:center;touch-action:none}
.range-tick::before{content:"";width:3px;height:18px;background:#9bb4ff;border-radius:2px;box-shadow:0 0 0 1px rgba(0,0,0,.35)}
.range-tick span{position:absolute;top:-14px;font-size:9px;color:#9bb4ff;font-weight:600;pointer-events:none}
.time{font-variant-numeric:tabular-nums;color:#aab0bd;min-width:120px;text-align:right}
.muted{color:#8a90a0;font-size:12px}
.rng{display:flex;align-items:center;gap:8px}
label{display:inline-flex;align-items:center;gap:5px;cursor:pointer}
.tag{background:#23262f;border-radius:5px;padding:2px 7px;font-size:12px;color:#aab0bd}
.export-wrap{position:relative}
.export-menu{position:absolute;bottom:calc(100% + 6px);right:0;background:#1c1f27;border:1px solid #333845;
  border-radius:8px;padding:4px;display:flex;flex-direction:column;gap:2px;min-width:150px;box-shadow:0 8px 24px rgba(0,0,0,.5);z-index:10}
.export-menu button{text-align:left;background:transparent;border:0}
.export-menu button:hover{background:#2f3543}
a.dl{display:none}
`;

const ZOOM_PRESETS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 4];

// Lucide play / pause icons (MIT) inlined so no icon dependency is pulled in.
const ICON_PLAY = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3" /></svg>
);
const ICON_PAUSE = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="14" y="4" width="4" height="16" rx="1" /><rect x="6" y="4" width="4" height="16" rx="1" /></svg>
);
// Lucide "dot" — used for the reset-pan-to-center button.
const ICON_DOT = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12.1" cy="12.1" r="1" /></svg>
);

function fmt(ms: number): string {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
}

// ── reactive state ──────────────────────────────────────────────────────────
const svgLoaded = signal(false);
const dragging = signal(false);
const durationMs = signal(0);      // single-loop period
const playhead = signal(0);        // ms
const playing = signal(false);
const speed = signal(1);
const rangeStart = signal(0);
const rangeEnd = signal(0);
const loop = signal(true);
const zoom = signal(1);            // 1 = 100% (natural SVG px)
const panX = signal(0);
const panY = signal(0);
const exportMenuOpen = signal(false);
const busy = signal(false);
const trackW = signal(0);          // scrub track px width (for marker positioning)

// non-reactive imperative state
let svgText = "";
let svgName = "animation";
let lastTs = 0;
let svgEl: SVGSVGElement | null = null;

const head = document.createElement("style"); head.textContent = CSS; document.head.append(head);

// ── render ──────────────────────────────────────────────────────────────────
const THUMB_R = 8; // half the range thumb width — markers inset to match the thumb travel

function markerLeft(ms: number): string {
  const dur = durationMs.value || 1;
  const w = trackW.value;
  const usable = Math.max(1, w - THUMB_R * 2);
  return `${THUMB_R + (Math.min(Math.max(ms, 0), dur) / dur) * usable}px`;
}

function render() {
  const dur = durationMs.value;
  const hi = rangeEnd.value > rangeStart.value ? rangeEnd.value : dur;
  const zoomPct = Math.round(zoom.value * 100);
  return (
    <div class="wrap">
      <div class="stage" data-stage>
        <div class="svg-host" data-svg-host data-morph-skip></div>
        {(!svgLoaded.value || dragging.value) && (
          <div class={dragging.value ? "drop over" : "drop"} data-drop>
            Drop an animated SVG here
            <span class="muted">or click to choose a file</span>
          </div>
        )}
      </div>
      <div class="bar">
        <div class="row">
          <button class="play primary" data-action="play" aria-label={playing.value ? "Pause" : "Play"} disabled={!svgLoaded.value}>{playing.value ? ICON_PAUSE : ICON_PLAY}</button>
          <select data-action="speed" disabled={!svgLoaded.value}>
            {["0.1", "0.25", "0.5", "1", "1.5", "2", "4"].map((v) => (
              <option value={v} selected={parseFloat(v) === speed.value}>{v}x</option>
            ))}
          </select>
          <div class="scrub-wrap">
            {svgLoaded.value && dur > 0 && trackW.value > 0 && (
              <>
                <div class="range-band" style={`left:${markerLeft(rangeStart.value)};width:${Math.max(0, parseFloat(markerLeft(hi)) - parseFloat(markerLeft(rangeStart.value)))}px`}></div>
                <div class="range-tick" data-tick="in" title="drag to set range start" style={`left:${markerLeft(rangeStart.value)}`}><span>in</span></div>
                <div class="range-tick" data-tick="out" title="drag to set range end" style={`left:${markerLeft(hi)}`}><span>out</span></div>
              </>
            )}
            <input type="range" class="scrub" data-action="scrub" min="0" max="1000" step="0.1" disabled={!svgLoaded.value} />
          </div>
          <div class="time">{fmt(playhead.value)} / {fmt(dur)}</div>
        </div>
        <div class="row row2">
          <div class="grp">
            <button data-action="setin" disabled={!svgLoaded.value}>In</button>
            <input type="number" data-action="inn" min="0" step="0.01" title="range start (s)" value={(rangeStart.value / 1000).toFixed(2)} disabled={!svgLoaded.value} />
            <span class="muted">-&gt;</span>
            <input type="number" data-action="outn" min="0" step="0.01" title="range end (s)" value={(rangeEnd.value / 1000).toFixed(2)} disabled={!svgLoaded.value} />
            <button data-action="setout" disabled={!svgLoaded.value}>Out</button>
            <label><input type="checkbox" data-action="loop" checked={loop.value} disabled={!svgLoaded.value} />loop</label>
            <button data-action="resetrange" disabled={!svgLoaded.value}>Reset</button>
          </div>
          <div class="grp">
            <button class="iconbtn" data-action="zoomout" title="zoom out" disabled={!svgLoaded.value}>-</button>
            <select data-action="zoompreset" title="zoom" disabled={!svgLoaded.value}>
              {ZOOM_PRESETS.map((z) => (
                <option value={String(z)} selected={Math.round(z * 100) === zoomPct}>{Math.round(z * 100)}%</option>
              ))}
              {!ZOOM_PRESETS.some((z) => Math.round(z * 100) === zoomPct) && <option value="custom" selected={true}>{zoomPct}%</option>}
              <option value="fit">Fit</option>
              <option value="fill">Fill</option>
            </select>
            <button class="iconbtn" data-action="zoomin" title="zoom in" disabled={!svgLoaded.value}>+</button>
            <button class="iconbtn" data-action="center" title="reset pan to center" aria-label="center" disabled={!svgLoaded.value}>{ICON_DOT}</button>
          </div>
          <div class="grp export-wrap">
            <button class="primary" data-action="exporttoggle" disabled={!svgLoaded.value || busy.value}>Export</button>
            {exportMenuOpen.value && (
              <div class="export-menu" data-export-menu>
                <button data-action="export-frame">Frame (PNG)</button>
                <button data-action="export-trim">Trim (SVG)</button>
                <button data-action="export-video">Range (MP4)</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const app = document.getElementById("app")!;
mount(app, render);

// Grab the imperative SVG host (data-morph-skip → stable across re-renders).
const svgHost = app.querySelector<HTMLElement>("[data-svg-host]")!;
const dlAnchor = document.createElement("a"); dlAnchor.className = "dl"; app.append(dlAnchor);

// Apply zoom/pan to the SVG host whenever those signals change.
effect(() => {
  svgHost.style.transform = `translate(${panX.value}px, ${panY.value}px) scale(${zoom.value})`;
});

// Drive the scrubber thumb IMPERATIVELY from the playhead. kerf's morph
// preserves an input's value as user state once it's been touched, so a
// template `value=` would freeze the thumb after the first scrub — set the
// `.value` property here instead (skipping while the user is actively dragging
// the scrubber). This is what makes the playhead move during playback.
effect(() => {
  const p = playhead.value, dur = durationMs.value;
  const sc = app.querySelector<HTMLInputElement>(".scrub");
  if (sc != null && document.activeElement !== sc) sc.value = String((p / (dur || 1)) * 1000);
});

// Keep the marker track width in sync with layout.
function measureTrack(): void {
  const el = app.querySelector<HTMLElement>(".scrub");
  if (el) trackW.value = el.clientWidth;
}
// Recompute Fit/Fill and the marker track whenever the STAGE box changes — this
// catches the initial layout settling (the footer's height is only known after
// the bar lays out), window resizes, and the bar reflowing. Using the stage's
// own size (which already excludes the footer, since `.stage` is `flex:1`) means
// Fit/Fill always account for the footer area.
const stageEl = app.querySelector<HTMLElement>(".stage")!;
new ResizeObserver(() => { measureTrack(); fitZoomKeep(); }).observe(stageEl);
window.addEventListener("resize", () => { measureTrack(); fitZoomKeep(); });

// ── animation seeking ───────────────────────────────────────────────────────
function stageAnims(): Animation[] {
  if (typeof document.getAnimations !== "function" || svgEl == null) return [];
  return document.getAnimations().filter((a) => {
    const t = (a.effect as KeyframeEffect | null)?.target as Element | null;
    return t != null && svgEl!.contains(t);
  });
}
function seekAll(ms: number): void {
  for (const a of stageAnims()) { try { a.pause(); a.currentTime = ms; } catch { /* refuses seek */ } }
  if (svgEl != null && typeof svgEl.pauseAnimations === "function") {
    try { svgEl.pauseAnimations(); svgEl.setCurrentTime(ms / 1000); } catch { /* no SMIL timeline */ }
  }
}
function localDuration(): number {
  let finite = 0, period = 0;
  for (const a of stageAnims()) {
    const ct = (a.effect as KeyframeEffect).getComputedTiming();
    const d = Number(ct.duration);
    if (Number.isFinite(ct.endTime)) finite = Math.max(finite, Number(ct.endTime));
    if (!Number.isFinite(ct.iterations) && d > 0) period = Math.max(period, d);
  }
  return finite || period;
}

function tick(ts: number): void {
  if (playing.value) {
    if (lastTs === 0) lastTs = ts;
    const dt = (ts - lastTs) * speed.value;
    lastTs = ts;
    let p = playhead.value + dt;
    const lo = rangeStart.value, hi = rangeEnd.value > rangeStart.value ? rangeEnd.value : durationMs.value;
    if (p >= hi) {
      if (loop.value) p = lo + ((p - lo) % Math.max(1, hi - lo));
      else { p = hi; playing.value = false; }
    }
    playhead.value = p;
    seekAll(p);
  } else { lastTs = 0; }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ── zoom helpers ────────────────────────────────────────────────────────────
function svgNaturalSize(): { w: number; h: number } {
  if (svgEl == null) return { w: 1, h: 1 };
  const vb = svgEl.viewBox?.baseVal;
  if (vb && vb.width > 0 && vb.height > 0) return { w: vb.width, h: vb.height };
  const r = svgEl.getBoundingClientRect();
  return { w: r.width / (zoom.value || 1) || 1, h: r.height / (zoom.value || 1) || 1 };
}
function stageSize(): { w: number; h: number } {
  const r = app.querySelector(".stage")!.getBoundingClientRect();
  return { w: r.width, h: r.height };
}
function fitZoom(mode: "fit" | "fill"): number {
  const s = stageSize(), n = svgNaturalSize();
  const sx = s.w / n.w, sy = s.h / n.h;
  return mode === "fit" ? Math.min(sx, sy) : Math.max(sx, sy);
}
let zoomMode: "fit" | "fill" | "manual" = "fit";
function fitZoomKeep(): void { if (zoomMode !== "manual" && svgEl != null) zoom.value = fitZoom(zoomMode); }
function setZoom(z: number): void { zoom.value = Math.min(16, Math.max(0.02, z)); zoomMode = "manual"; }

// ── load ────────────────────────────────────────────────────────────────────
async function loadSvg(text: string, name: string): Promise<void> {
  svgText = text;
  svgName = name.replace(/\.svg$/i, "") || "animation";
  const tmp = document.createElement("div"); tmp.innerHTML = text;
  const svg = tmp.querySelector("svg");
  if (svg == null) { alert("No <svg> element found in the file."); return; }
  svgHost.replaceChildren(svg);
  svgEl = svg;
  // Render the SVG at its natural size; zoom transforms the host.
  const n = (() => { const vb = svg.viewBox?.baseVal; return vb && vb.width > 0 ? { w: vb.width, h: vb.height } : { w: 800, h: 600 }; })();
  svg.style.width = `${n.w}px`; svg.style.height = `${n.h}px`; svg.removeAttribute("width"); svg.removeAttribute("height");
  svgLoaded.value = true;
  let dur = 0;
  try {
    const r = await fetch("/timing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ svg: text }) });
    dur = (await r.json() as { durationMs: number | null }).durationMs ?? localDuration();
  } catch { dur = localDuration(); }
  if (!(dur > 0)) dur = 1000;
  durationMs.value = dur; playhead.value = 0; rangeStart.value = 0; rangeEnd.value = dur; playing.value = false;
  seekAll(0);
  zoomMode = "fit"; panX.value = 0; panY.value = 0; fitZoomKeep();
  measureTrack();
}

// ── exports ─────────────────────────────────────────────────────────────────
function svgPxSize(): { w: number; h: number } {
  if (svgEl == null) return { w: 800, h: 600 };
  const vb = svgEl.viewBox?.baseVal;
  return vb && vb.width > 0 ? { w: vb.width, h: vb.height } : { w: 800, h: 600 };
}
function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  dlAnchor.href = url; dlAnchor.download = filename; dlAnchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function rangeSE(): { s: number; e: number } {
  return { s: rangeStart.value, e: rangeEnd.value > rangeStart.value ? rangeEnd.value : durationMs.value };
}
async function exportFrame(): Promise<void> {
  busy.value = true;
  try {
    const { w, h } = svgPxSize();
    const r = await fetch("/export-frame", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ svg: svgText, timeMs: playhead.value, width: w, height: h }) });
    if (!r.ok) throw new Error(`export failed (${r.status})`);
    download(await r.blob(), `${svgName}-${Math.round(playhead.value)}ms.png`);
  } catch (err) { alert(err instanceof Error ? err.message : "export failed"); }
  finally { busy.value = false; }
}
async function exportTrim(): Promise<void> {
  const { s, e } = rangeSE(); busy.value = true;
  try {
    const r = await fetch("/trim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ svg: svgText, startMs: s, endMs: e, periodMs: durationMs.value }) });
    if (!r.ok) throw new Error(`trim failed (${r.status})`);
    download(new Blob([(await r.json() as { svg: string }).svg], { type: "image/svg+xml" }), `${svgName}-trim-${Math.round(s)}-${Math.round(e)}ms.svg`);
  } catch (err) { alert(err instanceof Error ? err.message : "trim failed"); }
  finally { busy.value = false; }
}
async function exportVideo(): Promise<void> {
  const { s, e } = rangeSE(); const { w, h } = svgPxSize(); busy.value = true;
  try {
    const r = await fetch("/export-range-video", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ svg: svgText, startMs: s, endMs: e, width: w, height: h }) });
    if (!r.ok) {
      let msg = `export failed (${r.status})`;
      try { msg = (await r.json() as { error?: string }).error ?? msg; } catch { /* non-JSON */ }
      throw new Error(msg);
    }
    download(await r.blob(), `${svgName}-${Math.round(s)}-${Math.round(e)}ms.mp4`);
  } catch (err) { alert(err instanceof Error ? err.message : "video export failed"); }
  finally { busy.value = false; }
}

// ── events (delegated from the page-lifetime root) ──────────────────────────
const togglePlay = (): void => {
  if (durationMs.value <= 0) return;
  const hi = rangeEnd.value > rangeStart.value ? rangeEnd.value : durationMs.value;
  if (!playing.value && playhead.value >= hi) playhead.value = rangeStart.value;
  playing.value = !playing.value; lastTs = 0;
};
const stepFrame = (deltaMs: number): void => {
  playing.value = false;
  playhead.value = Math.min(durationMs.value, Math.max(0, playhead.value + deltaMs));
  seekAll(playhead.value);
};

const CLICK: Record<string, () => void> = {
  play: togglePlay,
  setin: () => { rangeStart.value = Math.min(playhead.value, rangeEnd.value); },
  setout: () => { rangeEnd.value = Math.max(playhead.value, rangeStart.value); },
  resetrange: () => { rangeStart.value = 0; rangeEnd.value = durationMs.value; },
  zoomin: () => setZoom(zoom.value * 1.25),
  zoomout: () => setZoom(zoom.value / 1.25),
  center: () => { panX.value = 0; panY.value = 0; },
  exporttoggle: () => { exportMenuOpen.value = !exportMenuOpen.value; },
  "export-frame": () => { exportMenuOpen.value = false; void exportFrame(); },
  "export-trim": () => { exportMenuOpen.value = false; void exportTrim(); },
  "export-video": () => { exportMenuOpen.value = false; void exportVideo(); },
};

void delegate(app, "click", "[data-action]", (e, target) => {
  const a = (target as HTMLElement).getAttribute("data-action");
  if (a && CLICK[a]) CLICK[a]();
});
// Click the drop overlay → file picker. Click outside the export menu → close it.
void delegate(app, "click", "[data-drop]", () => fileInput.click());
void delegate(app, "click", "[data-stage]", () => { if (exportMenuOpen.value) exportMenuOpen.value = false; });

void delegate(app, "input", "[data-action=scrub]", (e, target) => {
  playing.value = false;
  playhead.value = (parseFloat((target as HTMLInputElement).value) / 1000) * (durationMs.value || 1);
  seekAll(playhead.value);
});
void delegate(app, "change", "[data-action=speed]", (e, target) => { speed.value = parseFloat((target as HTMLInputElement).value) || 1; });
void delegate(app, "change", "[data-action=inn]", (e, target) => { rangeStart.value = Math.max(0, Math.min((parseFloat((target as HTMLInputElement).value) || 0) * 1000, durationMs.value)); });
void delegate(app, "change", "[data-action=outn]", (e, target) => { rangeEnd.value = Math.max(rangeStart.value, Math.min((parseFloat((target as HTMLInputElement).value) || 0) * 1000, durationMs.value)); });
void delegate(app, "change", "[data-action=loop]", (e, target) => { loop.value = (target as HTMLInputElement).checked; });
void delegate(app, "change", "[data-action=zoompreset]", (e, target) => {
  const v = (target as HTMLSelectElement).value;
  panX.value = 0; panY.value = 0; // re-center on an explicit preset pick
  if (v === "fit" || v === "fill") { zoomMode = v; fitZoomKeep(); }
  else if (v !== "custom") setZoom(parseFloat(v));
});

// Drag the in/out range markers along the timeline. Pointer-capture the tick at
// pointerdown so the move/up stay routed to it (and to this delegate) even as
// the cursor leaves the 3 px line; map clientX back to a time via the track.
let dragTick: "in" | "out" | null = null;
function timeAtClientX(clientX: number): number {
  const sc = app.querySelector<HTMLInputElement>(".scrub");
  if (sc == null) return 0;
  const r = sc.getBoundingClientRect();
  const usable = Math.max(1, r.width - THUMB_R * 2);
  const frac = Math.min(1, Math.max(0, (clientX - r.left - THUMB_R) / usable));
  return frac * (durationMs.value || 1);
}
void delegate(app, "pointerdown", "[data-tick]", (e, target) => {
  const t = (target as HTMLElement).getAttribute("data-tick");
  if (t !== "in" && t !== "out") return;
  dragTick = t;
  (target as HTMLElement).setPointerCapture((e as PointerEvent).pointerId);
  e.preventDefault();
});
void delegate(app, "pointermove", "[data-tick]", (e) => {
  if (dragTick == null) return;
  const ms = timeAtClientX((e as PointerEvent).clientX);
  if (dragTick === "in") rangeStart.value = Math.min(ms, rangeEnd.value);
  else rangeEnd.value = Math.max(ms, rangeStart.value);
});
void delegate(app, "pointerup", "[data-tick]", () => { dragTick = null; });

// Wheel on the stage: ctrl/⌘ + wheel (trackpad pinch) zooms about the cursor;
// plain wheel pans.
void delegate(app, "wheel", "[data-stage]", (e) => {
  const w = e as WheelEvent;
  w.preventDefault();
  if (w.ctrlKey || w.metaKey) {
    const factor = Math.exp(-w.deltaY * 0.01);
    setZoom(zoom.value * factor);
  } else {
    panX.value -= w.deltaX; panY.value -= w.deltaY;
  }
});

// Drag & drop.
function readFile(f: File | undefined): void { if (f) void f.text().then((t) => loadSvg(t, f.name)); }
void delegate(app, "dragover", "[data-stage]", (e) => { e.preventDefault(); dragging.value = true; });
void delegate(app, "dragleave", "[data-stage]", (e) => { e.preventDefault(); dragging.value = false; });
void delegate(app, "drop", "[data-stage]", (e) => { e.preventDefault(); dragging.value = false; readFile((e as DragEvent).dataTransfer?.files?.[0]); });

const fileInput = document.createElement("input");
fileInput.type = "file"; fileInput.accept = ".svg,image/svg+xml"; fileInput.style.display = "none";
fileInput.addEventListener("change", () => readFile(fileInput.files?.[0] ?? undefined));
app.append(fileInput);

// Keyboard (page-lifetime, outside the mount tree).
window.addEventListener("keydown", (e) => {
  if (!svgLoaded.value) return;
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === "INPUT" && (e.target as HTMLInputElement).type !== "range") return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  else if (e.code === "ArrowLeft") { stepFrame(-(e.shiftKey ? 1 : 1000 / 30)); }
  else if (e.code === "ArrowRight") { stepFrame(e.shiftKey ? 1 : 1000 / 30); }
});

// Bootstrap (preloaded SVG from the CLI) + initial track measure.
requestAnimationFrame(measureTrack);
const boot = window.__SCRUBBER_BOOTSTRAP__;
if (boot?.svg) void loadSvg(boot.svg, boot.name ?? "animation");

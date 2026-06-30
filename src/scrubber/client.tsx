/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

/**
 * DM-1040 / DM-1047: `svg-scrubber` page-side client (bundled to
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
import { fitRectToAspect, constrainResizeToAspect } from "./crop.js";

interface Bootstrap { svg: string | null; name: string | null; path?: string | null; review?: boolean }
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
.iconbtn.active{background:#3257d6;color:#fff}
/* DM-1104: crop overlay. The layer covers the stage; the box dims everything
   outside it via a huge spread shadow and carries 8 resize handles. */
.crop-layer{position:absolute;inset:0;z-index:6;pointer-events:none}
.crop-box{position:absolute;outline:1px solid #cfe0ff;box-shadow:0 0 0 100vmax rgba(0,0,0,.55);
  pointer-events:auto;cursor:move;touch-action:none}
.crop-h{position:absolute;width:12px;height:12px;background:#cfe0ff;border:1px solid #2a2f3a;border-radius:2px;
  pointer-events:auto;touch-action:none;transform:translate(-50%,-50%)}
.crop-h[data-handle=nw]{cursor:nwse-resize}.crop-h[data-handle=se]{cursor:nwse-resize}
.crop-h[data-handle=ne]{cursor:nesw-resize}.crop-h[data-handle=sw]{cursor:nesw-resize}
.crop-h[data-handle=n]{cursor:ns-resize}.crop-h[data-handle=s]{cursor:ns-resize}
.crop-h[data-handle=w]{cursor:ew-resize}.crop-h[data-handle=e]{cursor:ew-resize}
.crop-dims{position:absolute;top:-22px;left:0;background:#1c1f27;border:1px solid #333845;border-radius:4px;
  padding:1px 6px;font:12px/1.4 ui-monospace,monospace;color:#cfe0ff;white-space:nowrap;pointer-events:none}
/* DM-1445: review mode — issue-reporting panel + region overlay. */
.review{background:#12141a;border:1px solid #2a2e38;border-radius:8px;padding:8px;flex-direction:column;align-items:stretch;gap:8px}
.rv-title{flex:1;min-width:180px;background:#1c1f27;color:#e7e9ee;border:1px solid #333845;border-radius:6px;padding:6px 8px;font:inherit}
.rv-note{width:100%;min-height:46px;resize:vertical;background:#1c1f27;color:#e7e9ee;border:1px solid #333845;border-radius:6px;padding:6px 8px;font:inherit}
.rv-status{font-size:12px;color:#8a90a0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rv-status.ok{color:#7fd88f}.rv-status.err{color:#ff8a8a}
.region-layer{position:absolute;inset:0;z-index:7;display:none;touch-action:none;cursor:crosshair}
.region-box{position:absolute;outline:2px solid #ff5b8a;background:rgba(255,91,138,.14);pointer-events:none}
.region-box::after{content:"issue region";position:absolute;top:-18px;left:0;font-size:10px;color:#ff8fb0;font-weight:600;white-space:nowrap}
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
// Lucide "crop" — toggles crop mode (DM-1104).
const ICON_CROP = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2v14a2 2 0 0 0 2 2h14" /><path d="M18 22V8a2 2 0 0 0-2-2H2" /></svg>
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
// DM-1104: crop. `cropMode` toggles the overlay; `cropRect` is the rect in the
// SVG's user-space (viewBox) units, or null for "whole frame". `cropTick` is a
// monotonically-bumped repaint nudge so the imperative overlay re-lays-out on
// zoom / pan / resize without making those a data dependency.
const cropMode = signal(false);
const cropRect = signal<{ x: number; y: number; w: number; h: number } | null>(null);
const cropTick = signal(0);
// DM-1107: crop aspect-ratio lock. Holds the select value — "free" (default,
// unconstrained resize), "1" / "1.7778" / "1.3333" (1:1 / 16:9 / 4:3), or
// "orig" (the SVG's intrinsic w:h, resolved live in `cropAspectRatio`). Reset to
// "free" whenever crop mode turns off or a new SVG loads.
const cropAspect = signal<string>("free");

// DM-1445: review mode. `reviewMode` is fixed at load (the server sets it in the
// bootstrap when launched with --review). `regionRect` is the optional issue
// region in SVG user-space units (same space as the crop rect); `regionMode`
// arms the drag-to-draw overlay; `ticketStatus` shows the last save result.
const reviewMode = window.__SCRUBBER_BOOTSTRAP__?.review === true;
const regionMode = signal(false);
const regionRect = signal<{ x: number; y: number; w: number; h: number } | null>(null);
const regionTick = signal(0);
const ticketStatus = signal<{ kind: "" | "ok" | "err"; msg: string }>({ kind: "", msg: "" });
const savingTicket = signal(false);

// non-reactive imperative state
let svgText = "";
let svgName = "animation";
let svgPath: string | null = window.__SCRUBBER_BOOTSTRAP__?.path ?? null;
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
        {/* DM-1104: crop overlay host — data-morph-skip so the box/handles we
            append imperatively survive re-renders (like the svg-host). */}
        <div class="crop-layer" data-crop-layer data-morph-skip style="display:none"></div>
        {/* DM-1445: review region overlay host — drag-to-draw a rectangle. */}
        <div class="region-layer" data-region-layer data-morph-skip style="display:none"></div>
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
          <div class="grp">
            <button class={cropMode.value ? "iconbtn active" : "iconbtn"} data-action="croptoggle" title="crop" aria-label="crop" aria-pressed={cropMode.value ? "true" : "false"} disabled={!svgLoaded.value}>{ICON_CROP}</button>
            {/* DM-1107: aspect-ratio lock for the crop rect. Only meaningful while
                crop mode is on — disabled otherwise. */}
            <select data-action="cropaspect" title="crop aspect ratio" disabled={!svgLoaded.value || !cropMode.value}>
              <option value="free" selected={cropAspect.value === "free"}>Free</option>
              <option value="1" selected={cropAspect.value === "1"}>1:1</option>
              <option value="1.7778" selected={cropAspect.value === "1.7778"}>16:9</option>
              <option value="1.3333" selected={cropAspect.value === "1.3333"}>4:3</option>
              <option value="orig" selected={cropAspect.value === "orig"}>Original</option>
            </select>
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
        {reviewMode && (
          <div class="row review">
            <div class="grp" style="flex-wrap:wrap;width:100%">
              <input class="rv-title" data-action="rv-title" type="text" placeholder="Issue title" disabled={!svgLoaded.value} />
              <select data-action="rv-category" title="ticket category" disabled={!svgLoaded.value}>
                {["bug", "issue", "feature", "task", "investigation"].map((c) => <option value={c}>{c}</option>)}
              </select>
              <button class={regionMode.value ? "iconbtn active" : "iconbtn"} data-action="rv-region" title="drag a rectangle over the problem area" disabled={!svgLoaded.value}>
                {regionMode.value ? "Drawing…" : regionRect.value != null ? "Region ✓" : "Mark region"}
              </button>
              <button data-action="rv-clear-region" disabled={!svgLoaded.value || regionRect.value == null}>Clear</button>
              <span class="muted">frame @ {fmt(playhead.value)} · range {fmt(rangeStart.value)}–{fmt(hi)}</span>
              <button class="primary" data-action="rv-save" disabled={!svgLoaded.value || savingTicket.value}>{savingTicket.value ? "Saving…" : "Save issue"}</button>
            </div>
            <textarea class="rv-note" data-action="rv-note" placeholder="Describe the issue (becomes the ticket body)…" disabled={!svgLoaded.value}></textarea>
            {ticketStatus.value.msg !== "" && <div class={`rv-status ${ticketStatus.value.kind}`}>{ticketStatus.value.msg}</div>}
          </div>
        )}
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
new ResizeObserver(() => { measureTrack(); fitZoomKeep(); cropTick.value++; regionTick.value++; }).observe(stageEl);
window.addEventListener("resize", () => { measureTrack(); fitZoomKeep(); cropTick.value++; regionTick.value++; });

// ── crop overlay (DM-1104) ──────────────────────────────────────────────────
// Built imperatively (outside the kerf render tree) so its px geometry can be
// driven directly from cropRect + zoom/pan without round-tripping through the
// template. The box dims everything outside it (a huge spread box-shadow) and
// carries 8 resize handles + a live dimensions readout.
const CROP_MIN = 8; // minimum crop size in SVG user units
const cropLayer = app.querySelector<HTMLElement>("[data-crop-layer]")!;
const cropBox = document.createElement("div"); cropBox.className = "crop-box";
const cropDimsEl = document.createElement("div"); cropDimsEl.className = "crop-dims"; cropBox.appendChild(cropDimsEl);
const CROP_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type CropHandle = (typeof CROP_HANDLES)[number] | "move";
const cropHandleEls: Record<string, HTMLElement> = {};
for (const hh of CROP_HANDLES) {
  const d = document.createElement("div"); d.className = "crop-h"; d.dataset.handle = hh; cropBox.appendChild(d); cropHandleEls[hh] = d;
}
cropLayer.appendChild(cropBox);

// Lay out the crop box from cropRect (SVG units) → stage-local px. Geometry is
// derived from first principles (stage center + pan − half-size) so it doesn't
// depend on effect-ordering vs the transform effect or on getBoundingClientRect.
effect(() => {
  const cr = cropRect.value;
  const on = cropMode.value && svgLoaded.value && cr != null;
  cropTick.value; // re-run on resize
  cropLayer.style.display = on ? "block" : "none";
  if (!on || cr == null) return;
  const n = svgNaturalSize();
  const z = zoom.value;
  const sw = stageEl.clientWidth, sh = stageEl.clientHeight;
  const originX = sw / 2 + panX.value - (n.w * z) / 2;
  const originY = sh / 2 + panY.value - (n.h * z) / 2;
  const bx = originX + cr.x * z, by = originY + cr.y * z;
  const bw = cr.w * z, bh = cr.h * z;
  cropBox.style.left = `${bx}px`; cropBox.style.top = `${by}px`;
  cropBox.style.width = `${bw}px`; cropBox.style.height = `${bh}px`;
  const pos: Record<string, [number, number]> = {
    nw: [0, 0], n: [bw / 2, 0], ne: [bw, 0], e: [bw, bh / 2], se: [bw, bh], s: [bw / 2, bh], sw: [0, bh], w: [0, bh / 2],
  };
  for (const hh of CROP_HANDLES) { cropHandleEls[hh].style.left = `${pos[hh][0]}px`; cropHandleEls[hh].style.top = `${pos[hh][1]}px`; }
  cropDimsEl.textContent = `${Math.round(cr.w)} × ${Math.round(cr.h)}`;
});

// DM-1107: resolve the current aspect-lock selection to a numeric w:h ratio, or
// null for free-form. "orig" derives from the loaded SVG's intrinsic size so the
// crop tracks the source aspect even for non-16:9 frames.
function cropAspectRatio(): number | null {
  const v = cropAspect.value;
  if (v === "free") return null;
  if (v === "orig") { const n = svgNaturalSize(); return n.h > 0 ? n.w / n.h : null; }
  const r = parseFloat(v);
  return Number.isFinite(r) && r > 0 ? r : null;
}

// Resize / move math: apply a pointer delta (in SVG units) to the crop rect for
// a given handle, clamped to the frame with a CROP_MIN floor. When `aspect`
// (w:h) is non-null the free-form result is constrained to that ratio via
// `constrainResizeToAspect` (DM-1107) — the pure math lives in crop.ts so it's
// unit-tested.
function applyCropDrag(start: { x: number; y: number; w: number; h: number }, handle: CropHandle, dxU: number, dyU: number, n: { w: number; h: number }, aspect?: number | null): { x: number; y: number; w: number; h: number } {
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi));
  if (handle === "move") {
    return { x: clamp(start.x + dxU, 0, n.w - start.w), y: clamp(start.y + dyU, 0, n.h - start.h), w: start.w, h: start.h };
  }
  let L = start.x, R = start.x + start.w, T = start.y, B = start.y + start.h;
  if (handle.includes("w")) L = clamp(start.x + dxU, 0, R - CROP_MIN);
  if (handle.includes("e")) R = clamp(start.x + start.w + dxU, L + CROP_MIN, n.w);
  if (handle.includes("n")) T = clamp(start.y + dyU, 0, B - CROP_MIN);
  if (handle.includes("s")) B = clamp(start.y + start.h + dyU, T + CROP_MIN, n.h);
  const free = { x: L, y: T, w: R - L, h: B - T };
  if (aspect == null || aspect <= 0) return free;
  return constrainResizeToAspect(free, handle, aspect, n.w, n.h, CROP_MIN);
}

let cropDrag: { handle: CropHandle; start: { x: number; y: number; w: number; h: number }; px: number; py: number } | null = null;
void delegate(app, "pointerdown", ".crop-box", (e, _box) => {
  if (cropRect.value == null) return;
  const ev = e as PointerEvent;
  const realTarget = ev.target as HTMLElement;
  const handle = (realTarget.classList.contains("crop-h") ? (realTarget.dataset.handle as CropHandle) : "move");
  cropDrag = { handle, start: { ...cropRect.value }, px: ev.clientX, py: ev.clientY };
  cropBox.setPointerCapture(ev.pointerId);
  ev.preventDefault(); ev.stopPropagation();
});
cropBox.addEventListener("pointermove", (ev) => {
  if (cropDrag == null) return;
  const z = zoom.value || 1;
  const dxU = (ev.clientX - cropDrag.px) / z, dyU = (ev.clientY - cropDrag.py) / z;
  cropRect.value = applyCropDrag(cropDrag.start, cropDrag.handle, dxU, dyU, svgNaturalSize(), cropAspectRatio());
});
const endCropDrag = (): void => { cropDrag = null; };
cropBox.addEventListener("pointerup", endCropDrag);
cropBox.addEventListener("pointercancel", endCropDrag);

// ── review region overlay (DM-1445) ──────────────────────────────────────────
// Drag-to-draw a single rectangle over the problem area (in SVG user-units, the
// same space as the crop rect). Built imperatively like the crop overlay; the
// layer captures pointer events only while `regionMode` is armed.
const REGION_MIN = 3; // discard sub-3px drags (treated as a click → no region)
const regionLayer = app.querySelector<HTMLElement>("[data-region-layer]")!;
const regionBox = document.createElement("div"); regionBox.className = "region-box"; regionBox.style.display = "none";
regionLayer.appendChild(regionBox);

// SVG-host content origin (top-left of the natural-size SVG) in stage-local px.
function svgOriginLocal(): { ox: number; oy: number; z: number } {
  const n = svgNaturalSize();
  const z = zoom.value || 1;
  return { ox: stageEl.clientWidth / 2 + panX.value - (n.w * z) / 2, oy: stageEl.clientHeight / 2 + panY.value - (n.h * z) / 2, z };
}
function clientToSvgUnits(clientX: number, clientY: number): { x: number; y: number } {
  const r = stageEl.getBoundingClientRect();
  const { ox, oy, z } = svgOriginLocal();
  return { x: (clientX - r.left - ox) / z, y: (clientY - r.top - oy) / z };
}

// Position the region box from regionRect (SVG units) → stage-local px.
effect(() => {
  const rr = regionRect.value;
  const on = regionMode.value || rr != null;
  regionTick.value; // re-run on zoom / pan / resize
  regionLayer.style.display = on && svgLoaded.value ? "block" : "none";
  regionLayer.style.pointerEvents = regionMode.value && svgLoaded.value ? "auto" : "none";
  if (rr == null) { regionBox.style.display = "none"; return; }
  const { ox, oy, z } = svgOriginLocal();
  regionBox.style.display = "block";
  regionBox.style.left = `${ox + rr.x * z}px`;
  regionBox.style.top = `${oy + rr.y * z}px`;
  regionBox.style.width = `${rr.w * z}px`;
  regionBox.style.height = `${rr.h * z}px`;
});

let regionDraw: { ox: number; oy: number } | null = null;
regionLayer.addEventListener("pointerdown", (ev) => {
  if (!regionMode.value || !svgLoaded.value) return;
  const p = clientToSvgUnits(ev.clientX, ev.clientY);
  regionDraw = { ox: p.x, oy: p.y };
  regionRect.value = { x: p.x, y: p.y, w: 0, h: 0 };
  regionLayer.setPointerCapture(ev.pointerId);
  ev.preventDefault();
});
regionLayer.addEventListener("pointermove", (ev) => {
  if (regionDraw == null) return;
  const p = clientToSvgUnits(ev.clientX, ev.clientY);
  regionRect.value = {
    x: Math.min(regionDraw.ox, p.x),
    y: Math.min(regionDraw.oy, p.y),
    w: Math.abs(p.x - regionDraw.ox),
    h: Math.abs(p.y - regionDraw.oy),
  };
});
const endRegionDraw = (): void => {
  if (regionDraw == null) return;
  regionDraw = null;
  const rr = regionRect.value;
  if (rr != null && (rr.w < REGION_MIN || rr.h < REGION_MIN)) regionRect.value = null;
  else regionMode.value = false; // a real rect was drawn — disarm so the stage is interactive again
  regionTick.value++;
};
regionLayer.addEventListener("pointerup", endRegionDraw);
regionLayer.addEventListener("pointercancel", endRegionDraw);

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
  cropMode.value = false; cropRect.value = null; cropAspect.value = "free"; cropTick.value++; // DM-1104 / DM-1107: reset crop + ratio lock for the new SVG
  regionMode.value = false; regionRect.value = null; regionTick.value++; ticketStatus.value = { kind: "", msg: "" }; // DM-1445: reset review region/status
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
// DM-1104: the crop rect to send with an export — only when crop mode is on and
// the rect is a real sub-region (a whole-frame crop is omitted as a no-op). The
// server clamps it and applies it to all three export paths.
function activeCrop(): { x: number; y: number; w: number; h: number } | undefined {
  if (!cropMode.value) return undefined;
  const cr = cropRect.value;
  if (cr == null) return undefined;
  const n = svgNaturalSize();
  const full = cr.x <= 0.5 && cr.y <= 0.5 && cr.w >= n.w - 0.5 && cr.h >= n.h - 0.5;
  return full ? undefined : { x: cr.x, y: cr.y, w: cr.w, h: cr.h };
}
async function exportFrame(): Promise<void> {
  busy.value = true;
  try {
    const { w, h } = svgPxSize();
    const r = await fetch("/export-frame", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ svg: svgText, timeMs: playhead.value, width: w, height: h, crop: activeCrop() }) });
    if (!r.ok) throw new Error(`export failed (${r.status})`);
    download(await r.blob(), `${svgName}-${Math.round(playhead.value)}ms.png`);
  } catch (err) { alert(err instanceof Error ? err.message : "export failed"); }
  finally { busy.value = false; }
}
async function exportTrim(): Promise<void> {
  const { s, e } = rangeSE(); busy.value = true;
  try {
    const r = await fetch("/trim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ svg: svgText, startMs: s, endMs: e, periodMs: durationMs.value, crop: activeCrop() }) });
    if (!r.ok) throw new Error(`trim failed (${r.status})`);
    download(new Blob([(await r.json() as { svg: string }).svg], { type: "image/svg+xml" }), `${svgName}-trim-${Math.round(s)}-${Math.round(e)}ms.svg`);
  } catch (err) { alert(err instanceof Error ? err.message : "trim failed"); }
  finally { busy.value = false; }
}
async function exportVideo(): Promise<void> {
  const { s, e } = rangeSE(); const { w, h } = svgPxSize(); busy.value = true;
  try {
    const r = await fetch("/export-range-video", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ svg: svgText, startMs: s, endMs: e, width: w, height: h, crop: activeCrop() }) });
    if (!r.ok) {
      let msg = `export failed (${r.status})`;
      try { msg = (await r.json() as { error?: string }).error ?? msg; } catch { /* non-JSON */ }
      throw new Error(msg);
    }
    download(await r.blob(), `${svgName}-${Math.round(s)}-${Math.round(e)}ms.mp4`);
  } catch (err) { alert(err instanceof Error ? err.message : "video export failed"); }
  finally { busy.value = false; }
}

// DM-1445: write the current issue as a `.ticket` file via POST /ticket.
async function saveTicket(): Promise<void> {
  const titleEl = app.querySelector<HTMLInputElement>(".rv-title");
  const noteEl = app.querySelector<HTMLTextAreaElement>(".rv-note");
  const catEl = app.querySelector<HTMLSelectElement>("[data-action=rv-category]");
  const title = (titleEl?.value ?? "").trim();
  if (title === "") { ticketStatus.value = { kind: "err", msg: "⚠ enter an issue title first" }; return; }
  const { s, e } = rangeSE();
  savingTicket.value = true;
  ticketStatus.value = { kind: "", msg: "saving…" };
  try {
    const r = await fetch("/ticket", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title,
        note: noteEl?.value ?? "",
        category: catEl?.value ?? "bug",
        svgPath,
        svgName,
        frameTimeMs: playhead.value,
        rangeStartMs: s,
        rangeEndMs: e,
        region: regionRect.value,
      }),
    });
    if (!r.ok) {
      let msg = `save failed (${r.status})`;
      try { msg = (await r.json() as { error?: string }).error ?? msg; } catch { /* non-JSON */ }
      throw new Error(msg);
    }
    const { path } = await r.json() as { path: string };
    ticketStatus.value = { kind: "ok", msg: `✓ wrote ${path}` };
    // Reset for the next issue (keep the SVG / range / playhead as-is).
    if (titleEl) titleEl.value = "";
    if (noteEl) noteEl.value = "";
    regionRect.value = null; regionMode.value = false; regionTick.value++;
  } catch (err) {
    ticketStatus.value = { kind: "err", msg: `⚠ ${err instanceof Error ? err.message : "save failed"}` };
  } finally {
    savingTicket.value = false;
  }
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
  // DM-1104: toggle crop mode. Enabling seeds the rect to the whole frame (drag
  // the handles in to crop); disabling resets the rect so the next enable starts
  // fresh from the full frame.
  croptoggle: () => {
    cropMode.value = !cropMode.value;
    if (cropMode.value) {
      const n = svgNaturalSize();
      cropRect.value = { x: 0, y: 0, w: n.w, h: n.h };
    } else {
      cropRect.value = null;
      cropAspect.value = "free"; // DM-1107: reset the ratio lock with the crop
    }
    cropTick.value++;
  },
  exporttoggle: () => { exportMenuOpen.value = !exportMenuOpen.value; },
  "export-frame": () => { exportMenuOpen.value = false; void exportFrame(); },
  "export-trim": () => { exportMenuOpen.value = false; void exportTrim(); },
  "export-video": () => { exportMenuOpen.value = false; void exportVideo(); },
  // DM-1445: review-mode controls.
  "rv-region": () => { regionMode.value = !regionMode.value; regionTick.value++; },
  "rv-clear-region": () => { regionRect.value = null; regionMode.value = false; regionTick.value++; },
  "rv-save": () => { void saveTicket(); },
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
// DM-1107: pick a crop aspect-ratio lock. Snap the existing crop box to the new
// ratio immediately so the constraint is visible before the next drag.
void delegate(app, "change", "[data-action=cropaspect]", (e, target) => {
  cropAspect.value = (target as HTMLSelectElement).value;
  const ar = cropAspectRatio();
  if (ar != null && cropRect.value != null) { const n = svgNaturalSize(); cropRect.value = fitRectToAspect(cropRect.value, ar, n.w, n.h); }
});
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
function readFile(f: File | undefined): void {
  // DM-1445: a drag-dropped / picked file has no server-side path — tickets
  // then record the name only (no `svg` path). The preloaded CLI file keeps
  // its path (set from the bootstrap).
  if (f) { svgPath = null; void f.text().then((t) => loadSvg(t, f.name)); }
}
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
  if (tag === "TEXTAREA" || tag === "SELECT") return; // DM-1445: don't hijack space/arrows while typing a note
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  else if (e.code === "ArrowLeft") { stepFrame(-(e.shiftKey ? 1 : 1000 / 30)); }
  else if (e.code === "ArrowRight") { stepFrame(e.shiftKey ? 1 : 1000 / 30); }
});

// Bootstrap (preloaded SVG from the CLI) + initial track measure.
requestAnimationFrame(measureTrack);
const boot = window.__SCRUBBER_BOOTSTRAP__;
if (boot?.svg) void loadSvg(boot.svg, boot.name ?? "animation");

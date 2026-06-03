/**
 * DM-1040: `animated-svg-scrubber` page-side client (bundled to /client.js).
 *
 * Builds the whole UI under `#app` imperatively (no framework) and gives the
 * loaded animated SVG video-style transport. Playback is DRIVEN MANUALLY rather
 * than via `Animation.play()`: we keep our own `playhead` (ms) and, every frame,
 * `pause()` + set `currentTime = playhead` on each of the SVG's animations. That
 * is the exact seek the server-side exporter uses, so what you scrub to is what
 * a grabbed frame / trimmed SVG looks like — and it gives us precise speed,
 * manual scrubbing, and sub-range looping for free.
 */

interface Bootstrap { svg: string | null; name: string | null }
declare global { interface Window { __SCRUBBER_BOOTSTRAP__?: Bootstrap } }

const CSS = `
*{box-sizing:border-box}
body{margin:0;font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0e0f13;color:#e7e9ee}
.wrap{display:flex;flex-direction:column;height:100vh}
.stage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;
  background:repeating-conic-gradient(#1a1c22 0% 25%,#15171c 0% 50%) 50%/24px 24px;overflow:auto;position:relative}
.stage svg{max-width:100%;max-height:100%;filter:drop-shadow(0 4px 24px rgba(0,0,0,.5))}
.drop{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;
  gap:10px;color:#9aa0ad;border:2px dashed #2a2e38;margin:18px;border-radius:12px;text-align:center;padding:24px}
.drop.hide{display:none}
.drop.over{border-color:#5b8cff;color:#cdd5ff;background:#161b2b}
.bar{background:#15171c;border-top:1px solid #23262f;padding:10px 14px;display:flex;flex-direction:column;gap:8px}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
button{background:#262a35;color:#e7e9ee;border:1px solid #333845;border-radius:7px;padding:6px 11px;cursor:pointer;font:inherit}
button:hover{background:#2f3543}button:disabled{opacity:.45;cursor:default}
button.primary{background:#3a63d8;border-color:#3a63d8}button.primary:hover{background:#4a73e8}
.play{font-size:15px;min-width:42px}
select,input[type=number]{background:#1c1f27;color:#e7e9ee;border:1px solid #333845;border-radius:6px;padding:5px 7px;font:inherit}
input[type=number]{width:84px}
.scrub{flex:1;min-width:200px}
input[type=range]{width:100%;accent-color:#5b8cff}
.time{font-variant-numeric:tabular-nums;color:#aab0bd;min-width:120px;text-align:right}
.muted{color:#8a90a0;font-size:12px}
.range-wrap{position:relative}
.rng{display:flex;align-items:center;gap:8px}
label{display:inline-flex;align-items:center;gap:5px;cursor:pointer}
.tag{background:#23262f;border-radius:5px;padding:2px 7px;font-size:12px;color:#aab0bd}
a.dl{display:none}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, kids: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v; else e.setAttribute(k, v);
  }
  for (const kid of kids) e.append(kid);
  return e;
}

function fmt(ms: number): string {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const sec = (s - m * 60);
  return `${m}:${sec.toFixed(2).padStart(5, "0")}`;
}

const app = document.getElementById("app")!;
const style = document.createElement("style"); style.textContent = CSS; document.head.append(style);

// ── DOM scaffold ────────────────────────────────────────────────────────────
const stage = el("div", { class: "stage" });
const drop = el("div", { class: "drop" }, ["Drop an animated SVG here", el("span", { class: "muted" }, ["or click to choose a file"])]);
const fileInput = el("input", { type: "file", accept: ".svg,image/svg+xml", style: "display:none" });
stage.append(drop);

const playBtn = el("button", { class: "play primary" }, ["▶"]);
const speedSel = el("select", {}, ["0.1", "0.25", "0.5", "1", "1.5", "2", "4"].map((v) =>
  el("option", v === "1" ? { value: v, selected: "" } : { value: v }, [`${v}×`])));
const scrub = el("input", { type: "range", class: "scrub", min: "0", max: "1000", value: "0", step: "0.1" }) as HTMLInputElement;
const timeLbl = el("div", { class: "time" }, ["0:00.00 / 0:00.00"]);

const inN = el("input", { type: "number", min: "0", step: "0.01", value: "0", title: "range start (s)" }) as HTMLInputElement;
const outN = el("input", { type: "number", min: "0", step: "0.01", value: "0", title: "range end (s)" }) as HTMLInputElement;
const setIn = el("button", { title: "set range start to playhead" }, ["[ In"]);
const setOut = el("button", { title: "set range end to playhead" }, ["Out ]"]);
const loopChk = el("input", { type: "checkbox", checked: "" }) as HTMLInputElement;
const clearRange = el("button", {}, ["Reset range"]);

const exportFrameBtn = el("button", {}, ["⤓ Export frame (PNG)"]);
const trimBtn = el("button", {}, ["✂ Trim → SVG"]);
const status = el("span", { class: "muted" }, [""]);
const dlAnchor = el("a", { class: "dl" });

const bar = el("div", { class: "bar" }, [
  el("div", { class: "row" }, [playBtn, speedSel, scrub, timeLbl]),
  el("div", { class: "row rng" }, [
    el("span", { class: "tag" }, ["Range"]), setIn, inN, el("span", { class: "muted" }, ["→"]), outN, setOut,
    el("label", {}, [loopChk, "loop"]), clearRange,
    el("span", { style: "flex:1" }), exportFrameBtn, trimBtn, status,
  ]),
]);
app.append(el("div", { class: "wrap" }, [stage, bar]), fileInput, dlAnchor);

// ── State ─────────────────────────────────────────────────────────────────
let svgText = "";
let svgName = "animation";
let durationMs = 0;          // single-loop period
let playhead = 0;            // ms
let playing = false;
let speed = 1;
let rangeStart = 0;
let rangeEnd = 0;
let lastTs = 0;

function stageAnims(): Animation[] {
  if (typeof document.getAnimations !== "function") return [];
  const svg = stage.querySelector("svg");
  if (svg == null) return [];
  return document.getAnimations().filter((a) => {
    const t = (a.effect as KeyframeEffect | null)?.target as Element | null;
    return t != null && svg.contains(t);
  });
}

function seekAll(ms: number): void {
  for (const a of stageAnims()) {
    try { a.pause(); a.currentTime = ms; } catch { /* some anims refuse seeking */ }
  }
}

function setControlsEnabled(on: boolean): void {
  for (const b of [playBtn, speedSel, scrub, setIn, setOut, inN, outN, loopChk, clearRange, exportFrameBtn, trimBtn]) {
    (b as HTMLButtonElement).disabled = !on;
  }
}

function render(): void {
  const max = durationMs || 1;
  scrub.value = String((playhead / max) * 1000);
  timeLbl.textContent = `${fmt(playhead)} / ${fmt(durationMs)}`;
  playBtn.textContent = playing ? "❚❚" : "▶";
  inN.value = (rangeStart / 1000).toFixed(2);
  outN.value = (rangeEnd / 1000).toFixed(2);
}

function tick(ts: number): void {
  if (playing) {
    if (lastTs === 0) lastTs = ts;
    const dt = (ts - lastTs) * speed;
    lastTs = ts;
    playhead += dt;
    const lo = rangeStart, hi = rangeEnd > rangeStart ? rangeEnd : durationMs;
    if (playhead >= hi) {
      if (loopChk.checked) playhead = lo + ((playhead - lo) % Math.max(1, hi - lo));
      else { playhead = hi; playing = false; }
    }
    seekAll(playhead);
    render();
  } else {
    lastTs = 0;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ── Load ────────────────────────────────────────────────────────────────────
async function loadSvg(text: string, name: string): Promise<void> {
  svgText = text;
  svgName = name.replace(/\.svg$/i, "") || "animation";
  // Inline the SVG markup into the stage.
  stage.querySelector("svg")?.remove();
  const tmp = document.createElement("div");
  tmp.innerHTML = text;
  const svg = tmp.querySelector("svg");
  if (svg == null) { status.textContent = "no <svg> found in file"; return; }
  stage.append(svg);
  drop.classList.add("hide");
  status.textContent = "resolving timing…";
  setControlsEnabled(false);
  // Authoritative duration + size from the server (same path the exporter uses).
  try {
    const r = await fetch("/timing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ svg: text }) });
    const t = await r.json() as { durationMs: number | null; width: number; height: number };
    durationMs = t.durationMs ?? localDuration();
  } catch { durationMs = localDuration(); }
  if (!(durationMs > 0)) durationMs = 1000;
  playhead = 0; rangeStart = 0; rangeEnd = durationMs; playing = false;
  seekAll(0);
  setControlsEnabled(true);
  status.textContent = durationMs > 0 ? `loop ${fmt(durationMs)}` : "no animation detected";
  render();
}

/** Fallback duration from local WAAPI timings (max finite, else max period). */
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

// ── Wiring ────────────────────────────────────────────────────────────────
playBtn.addEventListener("click", () => {
  if (durationMs <= 0) return;
  playing = !playing; lastTs = 0;
  if (playing && playhead >= (rangeEnd > rangeStart ? rangeEnd : durationMs)) playhead = rangeStart;
  render();
});
speedSel.addEventListener("change", () => { speed = parseFloat(speedSel.value) || 1; });
scrub.addEventListener("input", () => {
  playing = false;
  playhead = (parseFloat(scrub.value) / 1000) * (durationMs || 1);
  seekAll(playhead); render();
});
setIn.addEventListener("click", () => { rangeStart = Math.min(playhead, rangeEnd); render(); });
setOut.addEventListener("click", () => { rangeEnd = Math.max(playhead, rangeStart); render(); });
inN.addEventListener("change", () => { rangeStart = Math.max(0, Math.min((parseFloat(inN.value) || 0) * 1000, durationMs)); render(); });
outN.addEventListener("change", () => { rangeEnd = Math.max(rangeStart, Math.min((parseFloat(outN.value) || 0) * 1000, durationMs)); render(); });
clearRange.addEventListener("click", () => { rangeStart = 0; rangeEnd = durationMs; render(); });

document.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement)?.tagName === "INPUT" && (e.target as HTMLInputElement).type !== "range") return;
  if (e.code === "Space") { e.preventDefault(); playBtn.click(); }
  else if (e.code === "ArrowLeft") { playing = false; playhead = Math.max(0, playhead - (e.shiftKey ? 1 : 1000 / 30)); seekAll(playhead); render(); }
  else if (e.code === "ArrowRight") { playing = false; playhead = Math.min(durationMs, playhead + (e.shiftKey ? 1 : 1000 / 30)); seekAll(playhead); render(); }
});

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  dlAnchor.href = url; dlAnchor.download = filename;
  dlAnchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

exportFrameBtn.addEventListener("click", async () => {
  if (svgText === "") return;
  status.textContent = "rendering frame…"; exportFrameBtn.disabled = true;
  try {
    const svg = stage.querySelector("svg")!;
    const w = svg.clientWidth || svg.viewBox?.baseVal?.width || 800;
    const h = svg.clientHeight || svg.viewBox?.baseVal?.height || 600;
    const r = await fetch("/export-frame", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ svg: svgText, timeMs: playhead, width: w, height: h }) });
    if (!r.ok) throw new Error(`export failed (${r.status})`);
    triggerDownload(await r.blob(), `${svgName}-${Math.round(playhead)}ms.png`);
    status.textContent = `exported frame @ ${fmt(playhead)}`;
  } catch (err) { status.textContent = err instanceof Error ? err.message : "export failed"; }
  finally { exportFrameBtn.disabled = false; }
});

trimBtn.addEventListener("click", async () => {
  if (svgText === "") return;
  const s = rangeStart, e = rangeEnd > rangeStart ? rangeEnd : durationMs;
  status.textContent = "trimming…"; trimBtn.disabled = true;
  try {
    const r = await fetch("/trim", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ svg: svgText, startMs: s, endMs: e, periodMs: durationMs }) });
    if (!r.ok) throw new Error(`trim failed (${r.status})`);
    const out = await r.json() as { svg: string };
    triggerDownload(new Blob([out.svg], { type: "image/svg+xml" }), `${svgName}-trim-${Math.round(s)}-${Math.round(e)}ms.svg`);
    status.textContent = `trimmed ${fmt(s)}–${fmt(e)}`;
  } catch (err) { status.textContent = err instanceof Error ? err.message : "trim failed"; }
  finally { trimBtn.disabled = false; }
});

// Drag & drop / file picker.
drop.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0]; if (f) f.text().then((t) => loadSvg(t, f.name));
});
for (const ev of ["dragenter", "dragover"]) stage.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("hide"); drop.classList.add("over"); });
for (const ev of ["dragleave", "drop"]) stage.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); });
stage.addEventListener("drop", (e) => {
  const f = (e as DragEvent).dataTransfer?.files?.[0];
  if (f) f.text().then((t) => loadSvg(t, f.name));
});

setControlsEnabled(false);
const boot = window.__SCRUBBER_BOOTSTRAP__;
if (boot?.svg) void loadSvg(boot.svg, boot.name ?? "animation");

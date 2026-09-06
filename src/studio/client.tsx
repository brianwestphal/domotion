/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

import { computed, delegate, mount, signal } from "kerfjs";
import {
  SCRUBBER_EMBED_CHANNEL,
  isScrubberEmbedEvent,
  type ScrubberEmbedCommand,
  type ScrubberEmbedViewState,
} from "../scrubber/embed.js";
import type { StudioProject, StudioScene } from "./project-schema.js";

interface StudioIssue { path: string; message: string; code: string }
interface Bootstrap {
  workspaceRoot: string;
  path: string;
  project: StudioProject | null;
  issues: readonly StudioIssue[];
  error: string;
}
interface ProjectResponse {
  path: string;
  project: StudioProject;
  generation: {
    artifactCount: number;
    scenes: Array<{ id: string; generated: boolean }>;
  };
}
interface PreviewResponse {
  sourceKey: string;
  artifact: { id: string; path: string; generatedAt: string; sourceRevisionId: string; sha256: string };
  name: string;
  durationMs: number;
  svg: string;
}
declare global { interface Window { __DOMOTION_STUDIO__?: Bootstrap } }

const bootstrap = window.__DOMOTION_STUDIO__ ?? {
  workspaceRoot: "",
  path: "demo.studio.json",
  project: null,
  issues: [],
  error: "",
};
const projectPath = signal(bootstrap.path);
const project = signal<StudioProject | null>(bootstrap.project);
const newTitle = signal(bootstrap.project?.narrative.title ?? "Product demo");
const issues = signal<readonly StudioIssue[]>(bootstrap.issues);
const message = signal(bootstrap.error);
const messageKind = signal<"error" | "success" | "info">(bootstrap.error === "" ? "info" : "error");
const busy = signal(false);
const dirty = signal(false);
const generation = signal<ProjectResponse["generation"] | null>(
  bootstrap.project == null
    ? null
    : {
        artifactCount: bootstrap.project.artifacts.length,
        scenes: bootstrap.project.scenes.map((scene) => ({
          id: scene.id,
          generated: bootstrap.project!.artifacts.some((artifact) => artifact.sceneIds?.includes(scene.id) === true),
        })),
      },
);
const annotationBody = signal("");
const annotationAuthor = signal("Reviewer");
const annotationScene = signal("");
const annotationStartMs = signal("");
const annotationEndMs = signal("");
const annotationRegionX = signal("");
const annotationRegionY = signal("");
const annotationRegionWidth = signal("");
const annotationRegionHeight = signal("");
const previewSelection = signal<{ kind: "story" } | { kind: "scene"; sceneId: string } | null>(null);
const previewInfo = signal<PreviewResponse | null>(null);
const previewBusy = signal(false);
const scrubberReady = signal(false);
const previewStates = new Map<string, ScrubberEmbedViewState>();
let pendingPreview: PreviewResponse | null = null;

const openAnnotations = computed(() => project.value?.review.annotations.filter((annotation) => annotation.status === "open").length ?? 0);

const CSS = `
:root{font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e8edf7;background:#090d16;font-synthesis:none}
*{box-sizing:border-box}
body{margin:0;min-width:320px;min-height:100vh;background:radial-gradient(circle at 30% -20%,#27365f 0,transparent 42%),#090d16;color:#e8edf7}
button,input,textarea,select{font:inherit}
button{border:1px solid #37445d;border-radius:9px;background:#182238;color:#e8edf7;padding:8px 13px;cursor:pointer}
button:hover{background:#22304c}button:disabled{opacity:.5;cursor:default}.primary{background:#4d6df3;border-color:#6e87ff}.primary:hover{background:#5d7cff}
button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid #8fa5ff;outline-offset:2px}
input,textarea,select{width:100%;border:1px solid #34415a;border-radius:9px;background:#0d1423;color:#f6f8fc;padding:9px 11px}
textarea{min-height:74px;resize:vertical}.app{min-height:100vh;display:grid;grid-template-columns:minmax(260px,320px) minmax(0,1fr)}
.rail{border-right:1px solid #263149;background:rgba(9,13,22,.82);backdrop-filter:blur(20px);padding:24px;display:flex;flex-direction:column;gap:22px}
.brand{display:flex;align-items:center;gap:11px}.mark{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,#7690ff,#9f70ff);font-weight:900;color:white;box-shadow:0 10px 30px #5f65ff44}
h1{font-size:17px;margin:0}.eyebrow{font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:#8fa5cf}.workspace{font-size:12px;color:#9eabc2;overflow-wrap:anywhere}
.field{display:flex;flex-direction:column;gap:6px}.field>span{font-size:12px;font-weight:650;color:#b9c5d9}.actions{display:flex;gap:8px;flex-wrap:wrap}.rail-note{margin-top:auto;color:#7f8ba3;font-size:12px;line-height:1.5}
.main{min-width:0;padding:28px 34px 52px}.topbar{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:22px}.topbar h2{font-size:25px;margin:2px 0 4px}.muted{color:#8795ae;font-size:13px}.statusline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.badge{border:1px solid #33415c;border-radius:999px;padding:4px 9px;color:#afbdd5;font-size:12px}.badge.good{color:#a8edc1;border-color:#2f6d4b;background:#15362666}.badge.warn{color:#ffd79a;border-color:#775b31;background:#3a291766}
.panel{background:#101725dd;border:1px solid #27334a;border-radius:14px;padding:18px;box-shadow:0 18px 70px #0005}.empty{max-width:650px;margin:14vh auto;text-align:center;padding:38px}.empty h2{font-size:28px;margin:0 0 10px}.empty p{color:#9aa7bd;line-height:1.6}
.notice{margin:0 0 18px;padding:12px 14px;border-radius:10px;border:1px solid #34415a;background:#111a2b;color:#c4cee0}.notice.error{border-color:#78404c;background:#351a22;color:#ffc5cd}.notice.success{border-color:#347153;background:#173426;color:#bcf6d0}
.issues{margin:9px 0 0;padding-left:20px}.issues code{color:#ffb5c1}.grid{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(250px,.8fr);gap:18px;margin-bottom:18px}.panel h3{margin:0 0 16px;font-size:14px;letter-spacing:.02em}.formgrid{display:grid;grid-template-columns:1fr 1fr;gap:13px}.wide{grid-column:1/-1}
.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.metric{padding:13px;border:1px solid #29364e;border-radius:11px;background:#0c1320}.metric strong{display:block;font-size:22px}.metric span{font-size:11px;color:#8d9ab0;text-transform:uppercase;letter-spacing:.08em}
.scene-list{display:flex;flex-direction:column;gap:11px}.scene{display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:13px;align-items:start;border:1px solid #29364e;border-radius:12px;background:#0c1320;padding:13px}.scene-no{display:grid;place-items:center;width:32px;height:32px;border-radius:9px;background:#1b2942;color:#b9c9e7;font-weight:750}.scene-meta{display:flex;gap:7px;flex-wrap:wrap;margin-top:8px}.scene-id{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:#78869e}.scene-state{white-space:nowrap}
.preview-panel{margin-top:18px}.preview-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}.preview-toolbar .spacer{flex:1}.preview-frame{display:block;width:100%;height:min(70vh,680px);min-height:420px;border:1px solid #29364e;border-radius:12px;background:#0e0f13}.preview-meta{margin:10px 0 0;color:#8795ae;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.preview-empty{display:grid;place-items:center;min-height:240px;border:1px dashed #34415a;border-radius:12px;color:#8795ae;text-align:center;padding:24px}
.review-panel{margin-top:18px}.review-compose{border:1px solid #29364e;border-radius:12px;background:#0c1320;padding:14px;margin-bottom:14px}.review-fields{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:11px}.review-fields .body{grid-column:1/-1}.review-fields .scene-select{grid-column:span 2}.review-help{font-size:12px;color:#8795ae;margin:9px 0 0}.annotation-list{display:flex;flex-direction:column;gap:10px}.annotation{border:1px solid #29364e;border-radius:12px;background:#0c1320;padding:13px}.annotation-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px}.annotation-author{font-size:12px;color:#aebbd0}.annotation-target{font-size:12px;color:#8290a8;margin:8px 0}.annotation-actions{display:flex;gap:8px;margin-top:9px}.empty-notes{color:#8795ae;font-size:13px;margin:0}
@media(max-width:800px){.app{grid-template-columns:1fr}.rail{border-right:0;border-bottom:1px solid #263149}.main{padding:22px 18px 40px}.grid{grid-template-columns:1fr}.topbar{flex-direction:column}.formgrid,.review-fields{grid-template-columns:1fr}.wide,.review-fields .body,.review-fields .scene-select{grid-column:auto}}
`;

function sourceLabel(scene: StudioScene): string {
  if (scene.render.kind === "composition") return `Composition · ${scene.render.composition.layers.length} layer${scene.render.composition.layers.length === 1 ? "" : "s"}`;
  const recipe = scene.render.recipe;
  if (recipe.capture != null) return `Capture · ${recipe.capture.url ?? recipe.capture.file}`;
  if (recipe.template != null) return `Template · ${recipe.template}`;
  if (recipe.cast != null) return `Terminal · ${recipe.cast}`;
  return `SVG · ${recipe.svg}`;
}

function durationLabel(scene: StudioScene): string {
  const duration = scene.render.kind === "composition"
    ? scene.render.duration ?? scene.render.composition.duration
    : scene.render.recipe.duration;
  return duration == null ? "intrinsic timing" : `${(duration / 1000).toFixed(2)}s`;
}

function isGenerated(sceneId: string): boolean {
  return generation.value?.scenes.find((scene) => scene.id === sceneId)?.generated === true;
}

function hasScenePreview(sceneId: string): boolean {
  return project.value?.artifacts.some((artifact) => artifact.kind === "svg" && artifact.sceneIds?.length === 1 && artifact.sceneIds[0] === sceneId) === true;
}

function hasStoryPreview(): boolean {
  return project.value?.artifacts.some((artifact) => artifact.kind === "svg" && (artifact.sceneIds == null || artifact.sceneIds.length === 0)) === true;
}

function previewKey(selection: NonNullable<typeof previewSelection.value>): string {
  return selection.kind === "story" ? "story" : `scene:${selection.sceneId}`;
}

function annotationTargetLabel(target: StudioProject["review"]["annotations"][number]["target"]): string {
  if (target == null) return "Project-wide text note";
  const parts: string[] = [];
  if (target.scope?.kind === "project") parts.push("Project");
  if (target.scope?.kind === "scene") parts.push(`Scene ${target.scope.sceneId}`);
  else if (target.sceneId != null) parts.push(`Scene ${target.sceneId}`);
  if (target.time?.pointMs != null) parts.push(`point ${target.time.pointMs}ms`);
  if (target.time?.range != null) parts.push(`${target.time.range.startMs}–${target.time.range.endMs}ms`);
  else if (target.atMs != null) parts.push(target.endMs == null ? `${target.atMs}ms` : `${target.atMs}–${target.endMs}ms`);
  if (target.regions?.length) parts.push(`${target.regions.length} region${target.regions.length === 1 ? "" : "s"}`);
  if (target.trackId != null) parts.push(`track ${target.trackId}`);
  if (target.eventId != null) parts.push(`action ${target.eventId}`);
  if (target.layerId != null) parts.push(`layer ${target.layerId}`);
  if (target.domIdentity != null) parts.push(`DOM ${target.domIdentity}`);
  return parts.join(" · ") || "Project-wide text note";
}

function render() {
  const current = project.value;
  return (
    <>
      <style>{CSS}</style>
      <div class="app">
        <aside class="rail">
          <div class="brand"><div class="mark">D</div><div><div class="eyebrow">Domotion</div><h1>Studio</h1></div></div>
          <div class="field"><span>Studio workspace</span><div class="workspace">{bootstrap.workspaceRoot}</div></div>
          <label class="field"><span>Project file</span><input data-field="project-path" value={projectPath.value} spellcheck="false" aria-label="Project file" /></label>
          {current == null && <label class="field"><span>New project title</span><input data-field="new-title" value={newTitle.value} aria-label="New project title" /></label>}
          <div class="actions">
            <button class="primary" data-action="create" disabled={busy.value}>Create</button>
            <button data-action="open" disabled={busy.value}>Open</button>
          </div>
          {current != null && <div class="actions">
            <button class="primary" data-action="save" disabled={busy.value || !dirty.value}>Save</button>
            <button data-action="reopen" disabled={busy.value}>Reopen</button>
          </div>}
          <p class="rail-note">Project JSON is the durable source. SVG and review video stay generated artifacts with revision provenance.</p>
        </aside>
        <main class="main">
          {message.value !== "" && <div class={`notice ${messageKind.value}`} role="status" aria-live="polite">
            {message.value}
            {issues.value.length > 0 && <ul class="issues">{issues.value.map((issue) => <li><code>{issue.path}</code>: {issue.message}</li>)}</ul>}
          </div>}
          {current == null ? (
            <section class="panel empty">
              <div class="eyebrow">A separate authoring workspace</div>
              <h2>Create or open a Studio project</h2>
              <p>Shape the narrative and scenes here while SVG Scrubber remains a focused playback and review tool.</p>
            </section>
          ) : (
            <>
              <header class="topbar">
                <div><div class="eyebrow">{current.id}</div><h2>{current.narrative.title}</h2><div class="muted">{projectPath.value}</div></div>
                <div class="statusline">
                  <span class={`badge ${dirty.value ? "warn" : "good"}`}>{dirty.value ? "Unsaved changes" : "Saved"}</span>
                  <span class="badge">Format v{current.version}</span>
                </div>
              </header>
              <div class="grid">
                <section class="panel">
                  <h3>Narrative</h3>
                  <div class="formgrid">
                    <label class="field wide"><span>Title</span><input data-field="narrative-title" value={current.narrative.title} /></label>
                    <label class="field wide"><span>Summary</span><textarea data-field="narrative-summary">{current.narrative.summary ?? ""}</textarea></label>
                    <label class="field"><span>Objective</span><textarea data-field="narrative-objective">{current.narrative.objective ?? ""}</textarea></label>
                    <label class="field"><span>Audience</span><textarea data-field="narrative-audience">{current.narrative.audience ?? ""}</textarea></label>
                    <label class="field wide"><span>Tone</span><input data-field="narrative-tone" value={current.narrative.tone ?? ""} /></label>
                  </div>
                </section>
                <section class="panel">
                  <h3>Generation & review</h3>
                  <div class="metrics">
                    <div class="metric"><strong>{current.scenes.length}</strong><span>Scenes</span></div>
                    <div class="metric"><strong>{generation.value?.artifactCount ?? current.artifacts.length}</strong><span>Artifacts</span></div>
                    <div class="metric"><strong>{openAnnotations.value}</strong><span>Open notes</span></div>
                  </div>
                </section>
              </div>
              <section class="panel">
                <h3>Story scenes</h3>
                <div class="scene-list">
                  {current.scenes.map((scene, index) => (
                    <article class="scene" data-scene-id={scene.id}>
                      <div class="scene-no">{index + 1}</div>
                      <div>
                        <label class="field"><span>Scene title</span><input data-field="scene-title" value={scene.title ?? ""} aria-label={`Scene ${index + 1} title`} /></label>
                        <div class="scene-meta"><span class="badge">{sourceLabel(scene)}</span><span class="badge">{durationLabel(scene)}</span></div>
                        <div class="scene-id">{scene.id}</div>
                      </div>
                      <span class={`badge scene-state ${isGenerated(scene.id) ? "good" : "warn"}`}>{isGenerated(scene.id) ? "Generated" : "Needs generation"}</span>
                    </article>
                  ))}
                </div>
              </section>
              <section class="panel preview-panel">
                <h3>Scrubber preview</h3>
                <div class="preview-toolbar">
                  <button data-action="preview-story" class={previewSelection.value?.kind === "story" ? "primary" : ""} disabled={previewBusy.value || !hasStoryPreview()}>Whole story</button>
                  {current.scenes.map((scene, index) => (
                    <button data-action="preview-scene" data-preview-scene={scene.id} class={previewSelection.value?.kind === "scene" && previewSelection.value.sceneId === scene.id ? "primary" : ""} disabled={previewBusy.value || !hasScenePreview(scene.id)}>Scene {index + 1}</button>
                  ))}
                  <span class="spacer"></span>
                  <button data-action="preview-refresh" disabled={previewBusy.value || previewSelection.value == null}>{previewBusy.value ? "Refreshing…" : "Refresh preview"}</button>
                </div>
                {previewSelection.value == null ? (
                  <div class="preview-empty">Choose a generated scene or whole-story artifact. Playback, seeking, frame steps, range inspection, zoom, and pan use the embedded SVG Scrubber.</div>
                ) : (
                  <>
                    <iframe class="preview-frame" data-scrubber-frame data-morph-skip src="/scrubber" title="SVG Scrubber scene preview"></iframe>
                    {previewInfo.value != null && <p class="preview-meta">{previewInfo.value.artifact.path} · {previewInfo.value.durationMs}ms · revision {previewInfo.value.artifact.sourceRevisionId}</p>}
                  </>
                )}
              </section>
              <section class="panel review-panel">
                <h3>Review annotations</h3>
                <div class="review-compose">
                  <div class="review-fields">
                    <label class="field body"><span>New review note</span><textarea data-field="annotation-new-body" aria-label="New review note">{annotationBody.value}</textarea></label>
                    <label class="field scene-select"><span>Scope</span><select data-field="annotation-scene" aria-label="Annotation scope"><option value="" selected={annotationScene.value === ""}>Whole project</option>{current.scenes.map((scene) => <option value={scene.id} selected={annotationScene.value === scene.id}>{scene.title ?? scene.id}</option>)}</select></label>
                    <label class="field"><span>Reviewer</span><input data-field="annotation-author" value={annotationAuthor.value} aria-label="Annotation reviewer" /></label>
                    <label class="field"><span>Start / point (ms)</span><input data-field="annotation-start" value={annotationStartMs.value} inputMode="decimal" aria-label="Annotation start time" /></label>
                    <label class="field"><span>End (ms, optional)</span><input data-field="annotation-end" value={annotationEndMs.value} inputMode="decimal" aria-label="Annotation end time" /></label>
                    <label class="field"><span>Region x</span><input data-field="annotation-region-x" value={annotationRegionX.value} inputMode="decimal" aria-label="Annotation region x" /></label>
                    <label class="field"><span>Region y</span><input data-field="annotation-region-y" value={annotationRegionY.value} inputMode="decimal" aria-label="Annotation region y" /></label>
                    <label class="field"><span>Region width</span><input data-field="annotation-region-width" value={annotationRegionWidth.value} inputMode="decimal" aria-label="Annotation region width" /></label>
                    <label class="field"><span>Region height</span><input data-field="annotation-region-height" value={annotationRegionHeight.value} inputMode="decimal" aria-label="Annotation region height" /></label>
                  </div>
                  <div class="annotation-actions"><button data-action="annotation-create" disabled={busy.value || dirty.value}>Add annotation</button></div>
                  <p class="review-help">A note can be textual only; time and region grounding are optional. Save other project edits before changing review history.</p>
                </div>
                <div class="annotation-list">
                  {current.review.annotations.length === 0 && <p class="empty-notes">No review annotations yet.</p>}
                  {current.review.annotations.map((annotation) => (
                    <article class="annotation" data-annotation-id={annotation.id}>
                      <div class="annotation-head">
                        <span class="annotation-author">{annotation.author.kind}{annotation.author.name == null ? "" : ` · ${annotation.author.name}`}</span>
                        <span class={`badge ${annotation.status === "open" ? "warn" : "good"}`}>{annotation.status}</span>
                      </div>
                      <label class="field"><span>Comment</span><textarea data-field="annotation-existing-body" aria-label={`Annotation ${annotation.id} comment`}>{annotation.body}</textarea></label>
                      <div class="annotation-target">{annotationTargetLabel(annotation.target)}</div>
                      <div class="annotation-actions">
                        <button data-action="annotation-save" disabled={busy.value || dirty.value || annotation.status !== "open"}>Save note</button>
                        {annotation.status === "open" && <button data-action="annotation-resolve" disabled={busy.value || dirty.value}>Resolve</button>}
                        {annotation.status === "resolved" && <button data-action="annotation-reopen" disabled={busy.value || dirty.value}>Reopen note</button>}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            </>
          )}
        </main>
      </div>
    </>
  );
}

const app = document.getElementById("app")!;
if (app == null) throw new Error("Domotion Studio: missing #app");
mount(app, render);

function sendPreviewToScrubber(preview: PreviewResponse): void {
  const frame = app.querySelector<HTMLIFrameElement>("[data-scrubber-frame]");
  if (!scrubberReady.value || frame?.contentWindow == null) {
    pendingPreview = preview;
    return;
  }
  const command: ScrubberEmbedCommand = {
    channel: SCRUBBER_EMBED_CHANNEL,
    type: "load",
    sourceKey: preview.sourceKey,
    svg: preview.svg,
    name: preview.name,
    durationMs: preview.durationMs,
    ...(previewStates.has(preview.sourceKey) ? { restoreState: previewStates.get(preview.sourceKey)! } : {}),
  };
  frame.contentWindow.postMessage(command, location.origin);
  pendingPreview = null;
}

window.addEventListener("message", (event) => {
  const frame = app.querySelector<HTMLIFrameElement>("[data-scrubber-frame]");
  if (event.origin !== location.origin || event.source !== frame?.contentWindow || !isScrubberEmbedEvent(event.data)) return;
  if (event.data.type === "ready") {
    scrubberReady.value = true;
    if (pendingPreview != null) sendPreviewToScrubber(pendingPreview);
    return;
  }
  if (event.data.type === "error") {
    message.value = event.data.message;
    messageKind.value = "error";
    return;
  }
  previewStates.set(event.data.sourceKey, event.data.state);
});

async function loadPreview(selection: { kind: "story" } | { kind: "scene"; sceneId: string }): Promise<void> {
  previewSelection.value = selection;
  previewBusy.value = true;
  try {
    const response = await fetch("/api/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: projectPath.value, selection }),
    });
    const result = await response.json() as PreviewResponse & { error?: string };
    if (!response.ok) throw result;
    previewInfo.value = result;
    sendPreviewToScrubber(result);
  } catch (error) {
    setFailure(error);
  } finally {
    previewBusy.value = false;
  }
}

function setFailure(error: unknown): void {
  const fallback = error instanceof Error ? error.message : String(error);
  const response = error as { error?: string; issues?: StudioIssue[] };
  issues.value = response.issues ?? [];
  message.value = response.error ?? fallback;
  messageKind.value = "error";
}

async function post(path: string, body: unknown): Promise<ProjectResponse> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json() as ProjectResponse & { error?: string; issues?: StudioIssue[] };
  if (!response.ok) throw result;
  return result;
}

function acceptLoaded(result: ProjectResponse, action: string): void {
  projectPath.value = result.path;
  project.value = result.project;
  generation.value = result.generation;
  dirty.value = false;
  issues.value = [];
  message.value = `${action} ${result.path}`;
  messageKind.value = "success";
  if (annotationScene.value !== "" && !result.project.scenes.some((scene) => scene.id === annotationScene.value)) {
    annotationScene.value = "";
  }
  const selected = previewSelection.value;
  if (selected?.kind === "scene" && !result.project.scenes.some((scene) => scene.id === selected.sceneId)) {
    previewSelection.value = null;
    previewInfo.value = null;
    pendingPreview = null;
    scrubberReady.value = false;
  } else if (selected != null) {
    void loadPreview(selected);
  }
}

async function run(action: () => Promise<void>): Promise<void> {
  busy.value = true;
  try {
    await action();
  } catch (error) {
    setFailure(error);
  } finally {
    busy.value = false;
  }
}

void delegate(app, "click", "[data-action]", (_event, target) => {
  const action = (target as HTMLElement).dataset.action;
  if (action === "preview-story") {
    void loadPreview({ kind: "story" });
  } else if (action === "preview-scene") {
    const sceneId = (target as HTMLElement).dataset.previewScene;
    if (sceneId != null) void loadPreview({ kind: "scene", sceneId });
  } else if (action === "preview-refresh" && previewSelection.value != null) {
    void loadPreview(previewSelection.value);
  } else if (action === "create") {
    void run(async () => acceptLoaded(await post("/api/create", { path: projectPath.value, title: newTitle.value }), "Created"));
  } else if (action === "open" || action === "reopen") {
    void run(async () => acceptLoaded(await post("/api/open", { path: projectPath.value }), action === "reopen" ? "Reopened" : "Opened"));
  } else if (action === "save" && project.value != null) {
    void run(async () => acceptLoaded(await post("/api/save", { path: projectPath.value, expectedHeadRevisionId: project.value!.review.headRevisionId, project: project.value }), "Saved"));
  } else if (action === "annotation-create" && project.value != null) {
    const current = project.value;
    void run(async () => {
      const body = annotationBody.value.trim();
      if (body === "") throw new Error("A review note is required.");
      const numberOrUndefined = (value: string, label: string): number | undefined => {
        if (value.trim() === "") return undefined;
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative number.`);
        return parsed;
      };
      const atMs = numberOrUndefined(annotationStartMs.value, "Start time");
      const endMs = numberOrUndefined(annotationEndMs.value, "End time");
      if (endMs != null && atMs == null) throw new Error("End time requires a start time.");
      if (endMs != null && endMs < atMs!) throw new Error("End time must not be before start time.");
      const regionValues = [annotationRegionX.value, annotationRegionY.value, annotationRegionWidth.value, annotationRegionHeight.value];
      const hasAnyRegion = regionValues.some((value) => value.trim() !== "");
      if (hasAnyRegion && regionValues.some((value) => value.trim() === "")) throw new Error("A region requires x, y, width, and height.");
      const region = hasAnyRegion ? regionValues.map(Number) : [];
      if (region.some((value) => !Number.isFinite(value)) || (hasAnyRegion && (!(region[2] > 0) || !(region[3] > 0)))) {
        throw new Error("Region coordinates must be numbers and width/height must be positive.");
      }
      const target = {
        scope: annotationScene.value === "" ? { kind: "project" as const } : { kind: "scene" as const, sceneId: annotationScene.value },
        ...(atMs == null ? {} : { time: { pointMs: atMs, ...(endMs == null ? {} : { range: { startMs: atMs, endMs } }) } }),
        ...(hasAnyRegion ? { regions: [{ x: region[0], y: region[1], width: region[2], height: region[3], coordinateSpace: "scene" as const }] } : {}),
      };
      const result = await post("/api/annotation", {
        path: projectPath.value,
        expectedHeadRevisionId: current.review.headRevisionId,
        command: {
          kind: "create",
          body,
          author: { kind: "human", ...(annotationAuthor.value.trim() === "" ? {} : { name: annotationAuthor.value.trim() }) },
          ...(Object.keys(target).length === 0 ? {} : { target }),
          origin: { kind: "studio" },
        },
      });
      annotationBody.value = "";
      acceptLoaded(result, "Added annotation to");
    });
  } else if ((action === "annotation-save" || action === "annotation-resolve" || action === "annotation-reopen") && project.value != null) {
    const current = project.value;
    const card = (target as HTMLElement).closest<HTMLElement>("[data-annotation-id]");
    const annotationId = card?.dataset.annotationId;
    if (annotationId == null || card == null) return;
    void run(async () => {
      const author = { kind: "human" as const, ...(annotationAuthor.value.trim() === "" ? {} : { name: annotationAuthor.value.trim() }) };
      const draftBody = (card.querySelector<HTMLTextAreaElement>('[data-field="annotation-existing-body"]')?.value ?? "").trim();
      const persistedBody = current.review.annotations.find((annotation) => annotation.id === annotationId)?.body;
      let expectedHeadRevisionId = current.review.headRevisionId;
      if (action === "annotation-save" || (action === "annotation-resolve" && draftBody !== persistedBody)) {
        const edited = await post("/api/annotation", {
          path: projectPath.value,
          expectedHeadRevisionId,
          command: { kind: "edit", annotationId, author, body: draftBody },
        });
        if (action === "annotation-save") {
          acceptLoaded(edited, "Updated annotation in");
          return;
        }
        expectedHeadRevisionId = edited.project.review.headRevisionId;
      }
      const status = action === "annotation-resolve" ? "resolved" as const : "open" as const;
      acceptLoaded(await post("/api/annotation", {
        path: projectPath.value,
        expectedHeadRevisionId,
        command: { kind: "set-status", annotationId, author, status },
      }), action === "annotation-resolve" ? "Resolved annotation in" : "Reopened annotation in");
    });
  }
});

void delegate(app, "input", "[data-field]", (_event, target) => {
  const control = target as HTMLInputElement | HTMLTextAreaElement;
  const field = control.dataset.field;
  if (field === "project-path") {
    projectPath.value = control.value;
    return;
  }
  if (field === "new-title") {
    newTitle.value = control.value;
    return;
  }
  if (field === "annotation-new-body") { annotationBody.value = control.value; return; }
  if (field === "annotation-author") { annotationAuthor.value = control.value; return; }
  if (field === "annotation-scene") { annotationScene.value = control.value; return; }
  if (field === "annotation-start") { annotationStartMs.value = control.value; return; }
  if (field === "annotation-end") { annotationEndMs.value = control.value; return; }
  if (field === "annotation-region-x") { annotationRegionX.value = control.value; return; }
  if (field === "annotation-region-y") { annotationRegionY.value = control.value; return; }
  if (field === "annotation-region-width") { annotationRegionWidth.value = control.value; return; }
  if (field === "annotation-region-height") { annotationRegionHeight.value = control.value; return; }
  if (field === "annotation-existing-body") return;
  const current = project.value;
  if (current == null) return;
  const next = structuredClone(current);
  if (field === "narrative-title") next.narrative.title = control.value;
  else if (field === "narrative-summary") next.narrative.summary = control.value || undefined;
  else if (field === "narrative-objective") next.narrative.objective = control.value || undefined;
  else if (field === "narrative-audience") next.narrative.audience = control.value || undefined;
  else if (field === "narrative-tone") next.narrative.tone = control.value || undefined;
  else if (field === "scene-title") {
    const sceneId = (control.closest("[data-scene-id]") as HTMLElement | null)?.dataset.sceneId;
    const scene = next.scenes.find((candidate) => candidate.id === sceneId);
    if (scene != null) scene.title = control.value || undefined;
  } else return;
  project.value = next;
  dirty.value = true;
  issues.value = [];
  message.value = "";
});

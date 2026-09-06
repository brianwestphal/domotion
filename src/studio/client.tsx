/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

import { computed, delegate, mount, signal } from "kerfjs";
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

const openAnnotations = computed(() => project.value?.review.annotations.filter((annotation) => annotation.status === "open").length ?? 0);

const CSS = `
:root{font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e8edf7;background:#090d16;font-synthesis:none}
*{box-sizing:border-box}
body{margin:0;min-width:320px;min-height:100vh;background:radial-gradient(circle at 30% -20%,#27365f 0,transparent 42%),#090d16;color:#e8edf7}
button,input,textarea{font:inherit}
button{border:1px solid #37445d;border-radius:9px;background:#182238;color:#e8edf7;padding:8px 13px;cursor:pointer}
button:hover{background:#22304c}button:disabled{opacity:.5;cursor:default}.primary{background:#4d6df3;border-color:#6e87ff}.primary:hover{background:#5d7cff}
button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid #8fa5ff;outline-offset:2px}
input,textarea{width:100%;border:1px solid #34415a;border-radius:9px;background:#0d1423;color:#f6f8fc;padding:9px 11px}
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
@media(max-width:800px){.app{grid-template-columns:1fr}.rail{border-right:0;border-bottom:1px solid #263149}.main{padding:22px 18px 40px}.grid{grid-template-columns:1fr}.topbar{flex-direction:column}.formgrid{grid-template-columns:1fr}.wide{grid-column:auto}}
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
            </>
          )}
        </main>
      </div>
    </>
  );
}

const app = document.getElementById("app");
if (app == null) throw new Error("Domotion Studio: missing #app");
mount(app, render);

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
  if (action === "create") {
    void run(async () => acceptLoaded(await post("/api/create", { path: projectPath.value, title: newTitle.value }), "Created"));
  } else if (action === "open" || action === "reopen") {
    void run(async () => acceptLoaded(await post("/api/open", { path: projectPath.value }), action === "reopen" ? "Reopened" : "Opened"));
  } else if (action === "save" && project.value != null) {
    void run(async () => acceptLoaded(await post("/api/save", { path: projectPath.value, project: project.value }), "Saved"));
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

/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

import { computed, delegate, mount, signal } from "kerfjs";
import {
  SCRUBBER_EMBED_CHANNEL,
  isScrubberEmbedEvent,
  normalizeScrubberEmbedViewState,
  type ScrubberEmbedCommand,
  type ScrubberEmbedViewState,
} from "../scrubber/embed.js";
import {
  applyStudioAuthoringCommand,
  studioContentRevisionId,
  type StudioAuthoringCommand,
} from "./authoring.js";
import type { StudioProject, StudioScene } from "./project-schema.js";
import {
  buildStudioTimeline,
  moveStudioTimelineItems,
  resizeStudioTimelineItems,
  type StudioTimelineCommand,
  type StudioTimelineItem,
} from "./timeline.js";

interface StudioIssue { path: string; message: string; code: string }
interface Bootstrap {
  workspaceRoot: string;
  path: string;
  project: StudioProject | null;
  issues: readonly StudioIssue[];
  error: string;
  generationAvailable: boolean;
  recordingImportAvailable: boolean;
}
interface ProjectResponse {
  path: string;
  project: StudioProject;
  generation: {
    artifactCount: number;
    scenes: Array<{ id: string; generated: boolean }>;
  };
  generationResult?: {
    status: "completed";
    ai: { healing: { status: "accepted"; summary: string }; review: { status: "accepted"; summary: string } };
  } | { status: "clarification"; question: string; reason: string };
  recordingImportResult?: {
    status: "imported";
    sceneId: string;
    evidencePath: string;
    ai: { healing: { summary: string }; review: { summary: string } };
  } | { status: "clarification"; question: string; reason: string; phase: "healing" | "review" };
  inverse?: StudioTimelineCommand;
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
  generationAvailable: false,
  recordingImportAvailable: false,
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
          generated: bootstrap.project!.artifacts.some((artifact) => artifact.sourceRevisionId === studioContentRevisionId(bootstrap.project!) && artifact.sceneIds?.includes(scene.id) === true),
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
let pendingPreviewSeekMs: number | undefined;
const undoStack = signal<StudioProject[]>([]);
const recordingJson = signal("");
const timelineSelection = signal<string[]>([]);
const timelineZoom = signal(1);
const timelineSnapMs = signal(50);
const timelineUndo = signal<StudioTimelineCommand[]>([]);
const timelineRedo = signal<StudioTimelineCommand[]>([]);

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
.scene-list{display:flex;flex-direction:column;gap:11px}.scene{display:grid;grid-template-columns:40px minmax(0,1fr);gap:13px;align-items:start;border:1px solid #29364e;border-radius:12px;background:#0c1320;padding:13px}.scene-no{display:grid;place-items:center;width:32px;height:32px;border-radius:9px;background:#1b2942;color:#b9c9e7;font-weight:750}.scene-editor{min-width:0}.scene-head,.section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}.scene-head .field{flex:1}.scene-controls{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.scene-controls .span2{grid-column:span 2}.scene-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:11px}.scene-meta{display:flex;gap:7px;flex-wrap:wrap;margin-top:8px}.scene-id{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:#78869e}.scene-state{white-space:nowrap}.beat-list{display:grid;gap:10px}.beat{display:grid;grid-template-columns:minmax(140px,.7fr) minmax(200px,1.3fr) auto;gap:10px;align-items:end;border:1px solid #29364e;border-radius:11px;padding:11px;background:#0c1320}.help{font-size:12px;color:#8795ae;line-height:1.45}.danger{border-color:#6e3b49;color:#ffbdc8}
.preview-panel{margin-top:18px}.preview-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}.preview-toolbar .spacer{flex:1}.preview-frame{display:block;width:100%;height:min(70vh,680px);min-height:420px;border:1px solid #29364e;border-radius:12px;background:#0e0f13}.preview-meta{margin:10px 0 0;color:#8795ae;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.preview-empty{display:grid;place-items:center;min-height:240px;border:1px dashed #34415a;border-radius:12px;color:#8795ae;text-align:center;padding:24px}
.review-panel{margin-top:18px}.review-compose{border:1px solid #29364e;border-radius:12px;background:#0c1320;padding:14px;margin-bottom:14px}.review-fields{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:11px}.review-fields .body{grid-column:1/-1}.review-fields .scene-select{grid-column:span 2}.review-help{font-size:12px;color:#8795ae;margin:9px 0 0}.annotation-list{display:flex;flex-direction:column;gap:10px}.annotation{border:1px solid #29364e;border-radius:12px;background:#0c1320;padding:13px}.annotation-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px}.annotation-author{font-size:12px;color:#aebbd0}.annotation-target{font-size:12px;color:#8290a8;margin:8px 0}.annotation-actions{display:flex;gap:8px;margin-top:9px}.empty-notes{color:#8795ae;font-size:13px;margin:0}
.recording-panel{margin-top:18px}.recording-panel textarea{min-height:120px}.semantic-actions{display:grid;gap:7px;margin-top:10px}.semantic-action{display:grid;grid-template-columns:minmax(0,1fr) 130px;gap:10px;align-items:end;border-left:2px solid #536da8;padding-left:10px}.semantic-action code{font-size:11px;color:#aebbd0;overflow-wrap:anywhere}
.timeline-panel{margin-top:18px}.timeline-toolbar{display:flex;align-items:end;gap:9px;flex-wrap:wrap;margin-bottom:13px}.timeline-toolbar .field{min-width:110px}.timeline-scroll{overflow:auto;border:1px solid #29364e;border-radius:12px;background:#090f1b}.timeline-canvas{min-width:900px}.timeline-ruler{height:30px;border-bottom:1px solid #29364e;position:relative;margin-left:150px;background:linear-gradient(90deg,#33415a 1px,transparent 1px);background-size:80px 100%}.timeline-row{display:grid;grid-template-columns:150px minmax(0,1fr);min-height:46px;border-bottom:1px solid #202b40}.timeline-row:last-child{border-bottom:0}.timeline-label{padding:12px 10px;font-size:11px;color:#aebbd0;border-right:1px solid #29364e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.timeline-lane{position:relative;min-height:45px;background:linear-gradient(90deg,#1d2940 1px,transparent 1px);background-size:80px 100%}.timeline-item{position:absolute;top:7px;height:31px;min-width:24px;padding:6px 10px;border:1px solid #5572b7;border-radius:7px;background:#233a68;color:#eff4ff;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:grab;text-align:left}.timeline-item[data-selected="true"]{outline:3px solid #a5b5ff;outline-offset:1px;background:#3d56a0}.timeline-item[data-kind="annotation"]{background:#6a4824;border-color:#b98546}.timeline-item[data-kind="transition"]{background:#4f326f;border-color:#8c65b0}.timeline-item[data-kind="scene"]{background:#24534e;border-color:#4f9188}.timeline-resize{position:absolute;right:0;top:0;width:9px;height:100%;cursor:ew-resize;border-left:1px solid #a5b5ff66}.timeline-summary{margin:9px 0 0;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#8795ae}
@media(max-width:800px){.app{grid-template-columns:1fr}.rail{border-right:0;border-bottom:1px solid #263149}.main{padding:22px 18px 40px}.grid{grid-template-columns:1fr}.topbar{flex-direction:column}.formgrid,.review-fields,.scene-controls{grid-template-columns:1fr}.wide,.review-fields .body,.review-fields .scene-select,.scene-controls .span2{grid-column:auto}.beat{grid-template-columns:1fr}}
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

type StoryboardRecipe = Extract<StudioScene["render"], { kind: "storyboard" }>["recipe"];
type SceneSourceKind = "template" | "url" | "file" | "svg" | "cast";

function storyboardRecipe(scene: StudioScene): StoryboardRecipe {
  return scene.render.kind === "storyboard"
    ? scene.render.recipe
    : { template: "title-card", params: { title: scene.title ?? "Scene" }, duration: scene.render.duration ?? 1600 };
}

function scenePresentation(scene: StudioScene): Pick<StoryboardRecipe, "duration" | "trimStart" | "trimEnd" | "fit" | "transition"> {
  return scene.render.kind === "storyboard" ? scene.render.recipe : scene.render;
}

function sourceKind(scene: StudioScene): SceneSourceKind {
  const recipe = storyboardRecipe(scene);
  if (recipe.capture?.url != null) return "url";
  if (recipe.capture?.file != null) return "file";
  if (recipe.svg != null) return "svg";
  if (recipe.cast != null) return "cast";
  return "template";
}

function sourceValue(scene: StudioScene): string {
  const recipe = storyboardRecipe(scene);
  return recipe.capture?.url ?? recipe.capture?.file ?? recipe.svg ?? recipe.cast ?? recipe.template ?? "";
}

function replaceSource(scene: StudioScene, kind: SceneSourceKind, value: string): StoryboardRecipe {
  const previous = storyboardRecipe(scene);
  const presentation = {
    ...(previous.fit == null ? {} : { fit: previous.fit }),
    ...(previous.duration == null ? {} : { duration: previous.duration }),
    ...(previous.trimStart == null ? {} : { trimStart: previous.trimStart }),
    ...(previous.trimEnd == null ? {} : { trimEnd: previous.trimEnd }),
    ...(previous.transition == null ? {} : { transition: previous.transition }),
    ...(previous.overlays == null ? {} : { overlays: previous.overlays }),
  };
  if (kind === "template") return { template: value, params: { title: scene.title ?? "Scene" }, ...presentation };
  if (kind === "url") return { capture: { url: value, ...(previous.capture?.selector == null ? {} : { selector: previous.capture.selector }) }, ...presentation };
  if (kind === "file") return { capture: { file: value, ...(previous.capture?.selector == null ? {} : { selector: previous.capture.selector }) }, ...presentation };
  if (kind === "svg") return { svg: value, ...presentation };
  return { cast: value, ...presentation };
}

function sourceDefault(kind: SceneSourceKind): string {
  if (kind === "template") return "title-card";
  if (kind === "url") return "https://example.com";
  if (kind === "file") return "demo.html";
  if (kind === "svg") return "scene.svg";
  return "session.cast";
}

function cinematicPreset(scene: StudioScene): string {
  const treatments = scene.treatments ?? [];
  if (treatments.length === 0) return "none";
  if (treatments.length === 1 && ["browser-chrome", "device-frame", "zoom-pan", "spotlight", "title-card"].includes(treatments[0].kind)) return treatments[0].kind;
  return "custom";
}

function presetTreatments(scene: StudioScene, preset: string): StudioScene["treatments"] {
  const current = project.value!;
  if (preset === "none") return [];
  if (preset === "browser-chrome") return [{ kind: "browser-chrome", theme: "dark" }];
  if (preset === "device-frame") return [{ kind: "device-frame", device: "phone", theme: "dark" }];
  if (preset === "zoom-pan") return [{ kind: "zoom-pan", transform: { from: { x: 0, y: 0, scale: 1 }, to: { x: 0, y: 0, scale: 1.18 }, origin: { x: current.canvas.width / 2, y: current.canvas.height / 2 } } }];
  if (preset === "spotlight") return [{ kind: "spotlight", mask: { region: { x: current.canvas.width * .25, y: current.canvas.height * .25, width: current.canvas.width * .5, height: current.canvas.height * .5, radius: 18 } }, color: "#000000", opacity: .68 }];
  return [{ kind: "title-card", title: scene.title ?? "Scene", align: "center" }];
}

function updateSceneRecipe(scene: StudioScene, patch: Partial<StoryboardRecipe>): StudioAuthoringCommand {
  return { kind: "scene.update", sceneId: scene.id, patch: { render: { kind: "storyboard", recipe: { ...storyboardRecipe(scene), ...patch } } } };
}

function updateScenePresentation(scene: StudioScene, patch: Partial<Pick<StoryboardRecipe, "duration" | "trimStart" | "trimEnd" | "fit" | "transition">>): StudioAuthoringCommand {
  if (scene.render.kind === "storyboard") return updateSceneRecipe(scene, patch);
  return { kind: "scene.update", sceneId: scene.id, patch: { render: { ...scene.render, ...patch } } };
}

function replaceSceneRecipe(scene: StudioScene, recipe: StoryboardRecipe): StudioAuthoringCommand {
  return { kind: "scene.update", sceneId: scene.id, patch: { render: { kind: "storyboard", recipe } } };
}

function applyAuthoring(command: StudioAuthoringCommand): void {
  const current = project.value;
  if (current == null) return;
  try {
    const result = applyStudioAuthoringCommand(current, command);
    undoStack.value = [...undoStack.value, result.undo.project].slice(-50);
    project.value = result.project;
    dirty.value = true;
    generation.value = { artifactCount: current.artifacts.length, scenes: result.project.scenes.map((scene) => ({ id: scene.id, generated: false })) };
    issues.value = [];
    message.value = "";
  } catch (error) {
    setFailure(error);
  }
}

function isGenerated(sceneId: string): boolean {
  return !dirty.value && generation.value?.scenes.find((scene) => scene.id === sceneId)?.generated === true;
}

function hasScenePreview(sceneId: string): boolean {
  if (dirty.value || project.value == null) return false;
  const revision = studioContentRevisionId(project.value);
  return project.value.artifacts.some((artifact) => artifact.kind === "svg" && artifact.sourceRevisionId === revision && artifact.sceneIds?.length === 1 && artifact.sceneIds[0] === sceneId);
}

function hasStoryPreview(): boolean {
  if (dirty.value || project.value == null) return false;
  const revision = studioContentRevisionId(project.value);
  return project.value.artifacts.some((artifact) => artifact.kind === "svg" && artifact.sourceRevisionId === revision && (artifact.sceneIds == null || artifact.sceneIds.length === 0));
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

function semanticTargetLabel(event: NonNullable<StudioScene["tracks"]>[number]["events"][number]): string {
  if (event.kind === "scriptHook") return `hook ${event.hookId}`;
  if (event.kind === "scrollTo" && event.position != null) return `page ${event.position.x}, ${event.position.y}`;
  const target = event.target;
  if (target == null) return "page";
  if (target.role != null) return `${target.role}${target.name == null ? "" : ` “${target.name}”`}`;
  if (target.label != null) return `label “${target.label}”`;
  if (target.testId != null) return `test id ${target.testId}`;
  if (target.domId != null) return `id ${target.domId}`;
  return target.text ?? target.selector ?? "target";
}

function timelineScale(): number {
  return 0.08 * timelineZoom.value;
}

function timelineWidth(durationMs: number): number {
  return Math.max(900, Math.ceil(durationMs * timelineScale()) + 40);
}

function timelineItemTitle(item: StudioTimelineItem): string {
  return `${item.label}, ${Math.round(item.startMs)} to ${Math.round(item.endMs)} milliseconds`;
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
            <button data-action="undo" disabled={busy.value || undoStack.value.length === 0}>Undo</button>
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
                  <div class="actions" style="margin-top:12px">
                    <button class="primary" data-action="generate-story" disabled={busy.value || !bootstrap.generationAvailable}>Generate whole story</button>
                  </div>
                  <p class="help">{bootstrap.generationAvailable ? "Generation always runs required AI healing and AI review; ambiguity pauses for clarification." : "Connect an AI healing/review generation adapter to enable rendering."}</p>
                </section>
              </div>
              <section class="panel">
                <div class="section-head"><h3>Narrative beats</h3><button data-action="beat-add">Add beat</button></div>
                <div class="beat-list">
                  {current.narrative.beats.map((beat) => (
                    <article class="beat" data-beat-id={beat.id}>
                      <label class="field"><span>Beat title</span><input data-field="beat-title" value={beat.title} aria-label={`Beat ${beat.id} title`} /></label>
                      <label class="field"><span>Beat summary</span><input data-field="beat-summary" value={beat.summary ?? ""} aria-label={`Beat ${beat.id} summary`} /></label>
                      <button class="danger" data-action="beat-remove" disabled={current.narrative.beats.length === 1}>Remove</button>
                    </article>
                  ))}
                </div>
              </section>
              <section class="panel preview-panel">
                <div class="section-head"><h3>Story scenes</h3><button data-action="scene-add">Add scene</button></div>
                <div class="scene-list">
                  {current.scenes.map((scene, index) => (
                    <article class="scene" data-scene-id={scene.id}>
                      <div class="scene-no">{index + 1}</div>
                      <div class="scene-editor">
                        <div class="scene-head">
                          <label class="field"><span>Scene title</span><input data-field="scene-title" value={scene.title ?? ""} aria-label={`Scene ${index + 1} title`} /></label>
                          <span class={`badge scene-state ${isGenerated(scene.id) ? "good" : "warn"}`}>{isGenerated(scene.id) ? "Generated" : "Needs generation"}</span>
                        </div>
                        <div class="scene-controls">
                          <label class="field span2"><span>Description</span><textarea data-field="scene-description" aria-label={`Scene ${index + 1} description`}>{scene.description ?? ""}</textarea></label>
                          <label class="field span2"><span>Generation instructions</span><textarea data-field="scene-generation" aria-label={`Scene ${index + 1} generation instructions`}>{scene.generationInstructions ?? ""}</textarea></label>
                          <label class="field"><span>Narrative beat</span><select data-field="scene-beat" aria-label={`Scene ${index + 1} narrative beat`}><option value="">Unassigned</option>{current.narrative.beats.map((beat) => <option value={beat.id} selected={scene.narrativeBeatIds?.[0] === beat.id}>{beat.title}</option>)}</select></label>
                          <label class="field"><span>Source type</span><select data-field="scene-source-kind" aria-label={`Scene ${index + 1} source type`} disabled={scene.render.kind === "composition"}>{scene.render.kind === "composition" ? <option selected>composition</option> : (["template", "url", "file", "svg", "cast"] as const).map((kind) => <option value={kind} selected={sourceKind(scene) === kind}>{kind}</option>)}</select></label>
                          <label class="field span2"><span>Source</span><input data-field="scene-source-value" value={scene.render.kind === "composition" ? `${scene.render.composition.layers.length} authored layers` : sourceValue(scene)} aria-label={`Scene ${index + 1} source`} disabled={scene.render.kind === "composition"} /></label>
                          {scene.render.kind === "storyboard" && (sourceKind(scene) === "url" || sourceKind(scene) === "file") && <label class="field"><span>Capture selector</span><input data-field="scene-selector" value={storyboardRecipe(scene).capture?.selector ?? "body"} aria-label={`Scene ${index + 1} capture selector`} /></label>}
                          <label class="field"><span>Duration (ms)</span><input type="number" min="1" data-field="scene-duration" value={String(scenePresentation(scene).duration ?? "")} aria-label={`Scene ${index + 1} duration`} /></label>
                          <label class="field"><span>Trim start (ms)</span><input type="number" min="0" data-field="scene-trim-start" value={String(scenePresentation(scene).trimStart ?? "")} aria-label={`Scene ${index + 1} trim start`} /></label>
                          <label class="field"><span>Trim end (ms)</span><input type="number" min="1" data-field="scene-trim-end" value={String(scenePresentation(scene).trimEnd ?? "")} aria-label={`Scene ${index + 1} trim end`} /></label>
                          <label class="field"><span>Fit</span><select data-field="scene-fit" aria-label={`Scene ${index + 1} fit`}>{(["center", "contain", "cover"] as const).map((fit) => <option value={fit} selected={(scenePresentation(scene).fit ?? "center") === fit}>{fit}</option>)}</select></label>
                          <label class="field"><span>Transition</span><select data-field="scene-transition" aria-label={`Scene ${index + 1} transition`}>{(["cut", "crossfade", "push-left", "push-right", "push-up", "push-down", "wipe", "iris", "zoom-in", "zoom-out", "shine"] as const).map((transition) => <option value={transition} selected={(scenePresentation(scene).transition?.type ?? "crossfade") === transition}>{transition}</option>)}</select></label>
                          <label class="field"><span>Transition duration (ms)</span><input type="number" min="0" data-field="scene-transition-duration" value={String(scenePresentation(scene).transition?.duration ?? 300)} aria-label={`Scene ${index + 1} transition duration`} /></label>
                          <label class="field"><span>Cinematic preset</span><select data-field="scene-preset" aria-label={`Scene ${index + 1} cinematic preset`}><option value="none" selected={cinematicPreset(scene) === "none"}>None</option><option value="browser-chrome" selected={cinematicPreset(scene) === "browser-chrome"}>Browser chrome</option><option value="device-frame" selected={cinematicPreset(scene) === "device-frame"}>Phone frame</option><option value="zoom-pan" selected={cinematicPreset(scene) === "zoom-pan"}>Focus zoom</option><option value="spotlight" selected={cinematicPreset(scene) === "spotlight"}>Spotlight</option><option value="title-card" selected={cinematicPreset(scene) === "title-card"}>Title card</option>{cinematicPreset(scene) === "custom" && <option value="custom" selected disabled>Custom treatments</option>}</select></label>
                        </div>
                        <div class="scene-meta"><span class="badge">{sourceLabel(scene)}</span><span class="badge">{durationLabel(scene)}</span></div>
                        {(scene.tracks?.some((track) => track.events.length > 0) ?? false) && <div class="semantic-actions">
                          {scene.tracks!.flatMap((track) => track.events.map((event) => (
                            <div class="semantic-action" data-track-id={track.id} data-event-id={event.id}>
                              <code>{event.kind} · {semanticTargetLabel(event)}</code>
                              <label class="field"><span>Action timing (ms)</span><input type="number" min="0" data-field="scene-action-at" value={String(event.atMs)} aria-label={`Action ${event.id} timing`} /></label>
                            </div>
                          )))}
                        </div>}
                        <div class="scene-id">{scene.id}</div>
                        <div class="scene-actions">
                          <button data-action="scene-up" disabled={index === 0}>Move up</button>
                          <button data-action="scene-down" disabled={index === current.scenes.length - 1}>Move down</button>
                          <button data-action="scene-duplicate">Duplicate</button>
                          <button class="danger" data-action="scene-remove" disabled={current.scenes.length === 1}>Remove</button>
                          <button class="primary" data-action="generate-scene" disabled={busy.value || !bootstrap.generationAvailable}>Regenerate scene</button>
                        </div>
                      </div>
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
              {(() => {
                const timeline = buildStudioTimeline(current);
                const scale = timelineScale();
                const width = timelineWidth(timeline.durationMs);
                return <section class="panel timeline-panel" aria-label="Multitrack timeline">
                  <div class="section-head"><h3>Detailed timeline</h3><span class="badge">{timeline.rows.length} tracks</span></div>
                  <div class="timeline-toolbar">
                    <label class="field"><span>Zoom</span><input data-field="timeline-zoom" type="range" min="0.5" max="4" step="0.25" value={String(timelineZoom.value)} aria-label="Timeline zoom" /></label>
                    <label class="field"><span>Snap</span><select data-field="timeline-snap" aria-label="Timeline snap">{[1, 10, 25, 50, 100, 250].map((value) => <option value={String(value)} selected={timelineSnapMs.value === value}>{value} ms</option>)}</select></label>
                    <button data-action="timeline-earlier" disabled={busy.value || timelineSelection.value.length === 0}>Earlier</button>
                    <button data-action="timeline-later" disabled={busy.value || timelineSelection.value.length === 0}>Later</button>
                    <button data-action="timeline-shorter" disabled={busy.value || timelineSelection.value.length === 0}>Shorter</button>
                    <button data-action="timeline-longer" disabled={busy.value || timelineSelection.value.length === 0}>Longer</button>
                    <button data-action="timeline-undo" disabled={busy.value || timelineUndo.value.length === 0}>Undo timeline</button>
                    <button data-action="timeline-redo" disabled={busy.value || timelineRedo.value.length === 0}>Redo timeline</button>
                  </div>
                  <div class="timeline-scroll">
                    <div class="timeline-canvas" style={`width:${width + 150}px`}>
                      <div class="timeline-ruler" style={`width:${width}px`} aria-hidden="true"></div>
                      {timeline.rows.map((track) => <div class="timeline-row" data-timeline-row={track.id}>
                        <div class="timeline-label" title={track.label}>{track.label}</div>
                        <div class="timeline-lane" style={`width:${width}px`}>
                          {track.items.map((item) => <button
                            class="timeline-item"
                            data-timeline-id={item.id}
                            data-kind={item.kind}
                            data-selected={String(timelineSelection.value.includes(item.id))}
                            aria-pressed={timelineSelection.value.includes(item.id)}
                            aria-label={timelineItemTitle(item)}
                            title={`${timelineItemTitle(item)}. Arrow keys move; Alt+Arrow resizes.`}
                            style={`left:${item.startMs * scale}px;width:${Math.max(8, (item.endMs - item.startMs) * scale)}px`}
                          >{item.label}{item.resizable && <span class="timeline-resize" data-timeline-resize="end" aria-hidden="true"></span>}</button>)}
                        </div>
                      </div>)}
                    </div>
                  </div>
                  <p class="timeline-summary">{Math.round(timeline.durationMs)}ms · click to select, Cmd/Ctrl-click for multiselect · arrows move by {timelineSnapMs.value}ms · Alt+arrows resize</p>
                </section>;
              })()}
              <section class="panel recording-panel">
                <h3>Import a real interaction recording</h3>
                <label class="field"><span>Redacted recording JSON</span><textarea data-field="recording-json" aria-label="Recorded interaction JSON" placeholder="Paste a domotion-studio-interaction-recording document">{recordingJson.value}</textarea></label>
                <div class="actions" style="margin-top:10px"><button class="primary" data-action="import-recording" disabled={busy.value || !bootstrap.recordingImportAvailable}>Import as editable scene</button></div>
                <p class="help">{bootstrap.recordingImportAvailable ? "AI healing simplifies raw input into semantic actions; AI review accepts it or asks a clarifying question. Redacted raw evidence remains attached to the imported scene." : "Connect AI healing and review adapters to enable recording import."}</p>
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

function sendPreviewToScrubber(preview: PreviewResponse, seekMs?: number): void {
  const frame = app.querySelector<HTMLIFrameElement>("[data-scrubber-frame]");
  if (!scrubberReady.value || frame?.contentWindow == null) {
    pendingPreview = preview;
    pendingPreviewSeekMs = seekMs;
    return;
  }
  const previous = previewStates.get(preview.sourceKey);
  const restoreState = seekMs == null
    ? previous
    : { ...normalizeScrubberEmbedViewState(previous, preview.durationMs), playheadMs: Math.max(0, Math.min(preview.durationMs, seekMs)) };
  const command: ScrubberEmbedCommand = {
    channel: SCRUBBER_EMBED_CHANNEL,
    type: "load",
    sourceKey: preview.sourceKey,
    svg: preview.svg,
    name: preview.name,
    durationMs: preview.durationMs,
    ...(restoreState == null ? {} : { restoreState }),
  };
  frame.contentWindow.postMessage(command, location.origin);
  pendingPreview = null;
  pendingPreviewSeekMs = undefined;
}

window.addEventListener("message", (event) => {
  const frame = app.querySelector<HTMLIFrameElement>("[data-scrubber-frame]");
  if (event.origin !== location.origin || event.source !== frame?.contentWindow || !isScrubberEmbedEvent(event.data)) return;
  if (event.data.type === "ready") {
    scrubberReady.value = true;
    if (pendingPreview != null) sendPreviewToScrubber(pendingPreview, pendingPreviewSeekMs);
    return;
  }
  if (event.data.type === "error") {
    message.value = event.data.message;
    messageKind.value = "error";
    return;
  }
  previewStates.set(event.data.sourceKey, event.data.state);
});

async function loadPreview(selection: { kind: "story" } | { kind: "scene"; sceneId: string }, seekMs?: number): Promise<void> {
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
    sendPreviewToScrubber(result, seekMs);
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

function acceptLoaded(result: ProjectResponse, action: string, preserveTimelineHistory = false): void {
  projectPath.value = result.path;
  project.value = result.project;
  generation.value = result.generation;
  dirty.value = false;
  issues.value = [];
  message.value = `${action} ${result.path}`;
  messageKind.value = "success";
  undoStack.value = [];
  if (!preserveTimelineHistory) {
    timelineUndo.value = [];
    timelineRedo.value = [];
  }
  const liveTimelineIds = new Set(buildStudioTimeline(result.project).items.map((item) => item.id));
  timelineSelection.value = timelineSelection.value.filter((id) => liveTimelineIds.has(id));
  if (annotationScene.value !== "" && !result.project.scenes.some((scene) => scene.id === annotationScene.value)) {
    annotationScene.value = "";
  }
  const selected = previewSelection.value;
  if (selected?.kind === "scene" && !result.project.scenes.some((scene) => scene.id === selected.sceneId)) {
    previewSelection.value = null;
    previewInfo.value = null;
    pendingPreview = null;
    pendingPreviewSeekMs = undefined;
    scrubberReady.value = false;
  } else if (selected != null) {
    void loadPreview(selected);
  }
}

async function seekTimelineItem(item: StudioTimelineItem): Promise<void> {
  const current = project.value;
  if (current == null) return;
  if (hasStoryPreview()) {
    await loadPreview({ kind: "story" }, item.startMs);
    return;
  }
  if (item.sceneId != null && hasScenePreview(item.sceneId)) {
    const sceneItem = buildStudioTimeline(current).items.find((candidate) => candidate.id === `scene:${item.sceneId}`);
    await loadPreview({ kind: "scene", sceneId: item.sceneId }, item.startMs - (sceneItem?.startMs ?? 0));
  }
}

async function applyTimeline(command: StudioTimelineCommand, mode: "edit" | "undo" | "redo" = "edit"): Promise<void> {
  let current = project.value;
  if (current == null) return;
  if (dirty.value) {
    const saved = await post("/api/save", { path: projectPath.value, expectedHeadRevisionId: current.review.headRevisionId, project: current });
    acceptLoaded(saved, "Saved");
    current = saved.project;
  }
  const result = await post("/api/timeline", {
    path: projectPath.value,
    expectedHeadRevisionId: current.review.headRevisionId,
    command,
  });
  if (result.inverse == null) throw new Error("Timeline response did not include an inverse command.");
  acceptLoaded(result, mode === "edit" ? "Updated timeline in" : mode === "undo" ? "Undid timeline change in" : "Redid timeline change in", true);
  if (mode === "edit") {
    timelineUndo.value = [...timelineUndo.value, result.inverse];
    timelineRedo.value = [];
  } else if (mode === "undo") {
    timelineUndo.value = timelineUndo.value.slice(0, -1);
    timelineRedo.value = [...timelineRedo.value, result.inverse];
  } else {
    timelineRedo.value = timelineRedo.value.slice(0, -1);
    timelineUndo.value = [...timelineUndo.value, result.inverse];
  }
}

function selectedTimelineCommand(operation: "move" | "resize", deltaMs: number): StudioTimelineCommand {
  const current = project.value;
  if (current == null) throw new Error("Open a Studio project first.");
  const timeline = buildStudioTimeline(current);
  return operation === "move"
    ? moveStudioTimelineItems(timeline, timelineSelection.value, deltaMs, timelineSnapMs.value)
    : resizeStudioTimelineItems(timeline, timelineSelection.value, "end", deltaMs, timelineSnapMs.value);
}

async function generate(selection: { kind: "story" } | { kind: "scene"; sceneId: string }): Promise<void> {
  let current = project.value;
  if (current == null) return;
  if (dirty.value) {
    const saved = await post("/api/save", { path: projectPath.value, expectedHeadRevisionId: current.review.headRevisionId, project: current });
    acceptLoaded(saved, "Saved");
    current = saved.project;
  }
  const result = await post("/api/generate", {
    path: projectPath.value,
    expectedHeadRevisionId: current.review.headRevisionId,
    selection,
  });
  acceptLoaded(result, result.generationResult?.status === "completed" ? "Generated" : "Generation paused for");
  if (result.generationResult?.status === "clarification") {
    message.value = `${result.generationResult.question} ${result.generationResult.reason}`;
    messageKind.value = "info";
    return;
  }
  await loadPreview(selection);
}

async function importRecording(): Promise<void> {
  let current = project.value;
  if (current == null) return;
  if (dirty.value) {
    const saved = await post("/api/save", { path: projectPath.value, expectedHeadRevisionId: current.review.headRevisionId, project: current });
    acceptLoaded(saved, "Saved");
    current = saved.project;
  }
  let recording: unknown;
  try { recording = JSON.parse(recordingJson.value); } catch { throw new Error("Recorded interaction JSON is invalid."); }
  const result = await post("/api/recording/import", { path: projectPath.value, expectedHeadRevisionId: current.review.headRevisionId, recording });
  acceptLoaded(result, result.recordingImportResult?.status === "imported" ? "Imported recording into" : "Recording import paused for");
  if (result.recordingImportResult?.status === "clarification") {
    message.value = `${result.recordingImportResult.question} ${result.recordingImportResult.reason}`;
    messageKind.value = "info";
  } else {
    recordingJson.value = "";
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
  const sceneCard = (target as HTMLElement).closest<HTMLElement>("[data-scene-id]");
  const sceneId = sceneCard?.dataset.sceneId;
  const sceneIndex = project.value?.scenes.findIndex((scene) => scene.id === sceneId) ?? -1;
  const beatId = (target as HTMLElement).closest<HTMLElement>("[data-beat-id]")?.dataset.beatId;
  if (action === "timeline-earlier" || action === "timeline-later" || action === "timeline-shorter" || action === "timeline-longer") {
    const resize = action === "timeline-shorter" || action === "timeline-longer";
    const delta = (action === "timeline-earlier" || action === "timeline-shorter" ? -1 : 1) * timelineSnapMs.value;
    void run(() => applyTimeline(selectedTimelineCommand(resize ? "resize" : "move", delta)));
  } else if (action === "timeline-undo") {
    const command = timelineUndo.value.at(-1);
    if (command != null) void run(() => applyTimeline(command, "undo"));
  } else if (action === "timeline-redo") {
    const command = timelineRedo.value.at(-1);
    if (command != null) void run(() => applyTimeline(command, "redo"));
  } else if (action === "undo") {
    const previous = undoStack.value.at(-1);
    if (previous != null) {
      project.value = structuredClone(previous);
      undoStack.value = undoStack.value.slice(0, -1);
      dirty.value = true;
      generation.value = { artifactCount: previous.artifacts.length, scenes: previous.scenes.map((scene) => ({ id: scene.id, generated: false })) };
    }
  } else if (action === "scene-add") {
    applyAuthoring({ kind: "scene.add" });
  } else if (action === "scene-duplicate" && sceneId != null) {
    applyAuthoring({ kind: "scene.duplicate", sceneId });
  } else if (action === "scene-up" && sceneId != null) {
    applyAuthoring({ kind: "scene.move", sceneId, toIndex: sceneIndex - 1 });
  } else if (action === "scene-down" && sceneId != null) {
    applyAuthoring({ kind: "scene.move", sceneId, toIndex: sceneIndex + 1 });
  } else if (action === "scene-remove" && sceneId != null && window.confirm("Remove this scene? Generated scene artifacts will no longer belong to the story.")) {
    applyAuthoring({ kind: "scene.remove", sceneId });
  } else if (action === "beat-add") {
    applyAuthoring({ kind: "beat.add" });
  } else if (action === "beat-remove" && beatId != null) {
    applyAuthoring({ kind: "beat.remove", beatId });
  } else if (action === "generate-story") {
    void run(() => generate({ kind: "story" }));
  } else if (action === "generate-scene" && sceneId != null) {
    void run(() => generate({ kind: "scene", sceneId }));
  } else if (action === "import-recording") {
    void run(importRecording);
  } else if (action === "preview-story") {
    void loadPreview({ kind: "story" });
  } else if (action === "preview-scene") {
    const previewSceneId = (target as HTMLElement).dataset.previewScene;
    if (previewSceneId != null) void loadPreview({ kind: "scene", sceneId: previewSceneId });
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
  if (field === "timeline-zoom") {
    timelineZoom.value = Number(control.value);
    return;
  }
  if (field === "timeline-snap") {
    timelineSnapMs.value = Number(control.value);
    return;
  }
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
  if (field === "recording-json") { recordingJson.value = control.value; return; }
  const current = project.value;
  if (current == null) return;
  const next = structuredClone(current);
  if (field === "narrative-title") next.narrative.title = control.value;
  else if (field === "narrative-summary") next.narrative.summary = control.value || undefined;
  else if (field === "narrative-objective") next.narrative.objective = control.value || undefined;
  else if (field === "narrative-audience") next.narrative.audience = control.value || undefined;
  else if (field === "narrative-tone") next.narrative.tone = control.value || undefined;
  else if (field === "beat-title" || field === "beat-summary") {
    const beatId = (control.closest("[data-beat-id]") as HTMLElement | null)?.dataset.beatId;
    const beat = next.narrative.beats.find((candidate) => candidate.id === beatId);
    if (beat == null) return;
    if (field === "beat-title") beat.title = control.value;
    else beat.summary = control.value || undefined;
  }
  else if (field === "scene-title") {
    const sceneId = (control.closest("[data-scene-id]") as HTMLElement | null)?.dataset.sceneId;
    const scene = next.scenes.find((candidate) => candidate.id === sceneId);
    if (scene != null) scene.title = control.value || undefined;
  } else if (field === "scene-description" || field === "scene-generation") {
    const sceneId = (control.closest("[data-scene-id]") as HTMLElement | null)?.dataset.sceneId;
    const scene = next.scenes.find((candidate) => candidate.id === sceneId);
    if (scene == null) return;
    if (field === "scene-description") scene.description = control.value || undefined;
    else scene.generationInstructions = control.value || undefined;
  } else return;
  project.value = next;
  dirty.value = true;
  generation.value = { artifactCount: next.artifacts.length, scenes: next.scenes.map((scene) => ({ id: scene.id, generated: false })) };
  issues.value = [];
  message.value = "";
});

void delegate(app, "change", "[data-field]", (_event, target) => {
  const control = target as HTMLInputElement | HTMLSelectElement;
  const field = control.dataset.field;
  const current = project.value;
  const sceneId = (control.closest("[data-scene-id]") as HTMLElement | null)?.dataset.sceneId;
  const scene = current?.scenes.find((candidate) => candidate.id === sceneId);
  if (current == null || scene == null) return;
  if (field === "scene-action-at") {
    const action = control.closest<HTMLElement>("[data-event-id]");
    const trackId = action?.dataset.trackId;
    const eventId = action?.dataset.eventId;
    const atMs = Number(control.value);
    if (!Number.isFinite(atMs) || atMs < 0) { setFailure(new Error("Action timing must be non-negative.")); return; }
    const tracks = structuredClone(scene.tracks ?? []);
    const event = tracks.find((track) => track.id === trackId)?.events.find((candidate) => candidate.id === eventId);
    if (event == null) return;
    event.atMs = atMs;
    applyAuthoring({ kind: "scene.update", sceneId: scene.id, patch: { tracks } });
  } else if (field === "scene-beat") {
    applyAuthoring({ kind: "scene.update", sceneId: scene.id, patch: { narrativeBeatIds: control.value === "" ? [] : [control.value] } });
  } else if (field === "scene-source-kind") {
    const kind = control.value as SceneSourceKind;
    applyAuthoring(replaceSceneRecipe(scene, replaceSource(scene, kind, sourceDefault(kind))));
  } else if (field === "scene-source-value") {
    const value = control.value.trim();
    if (value === "") { setFailure(new Error("A scene source is required.")); return; }
    applyAuthoring(replaceSceneRecipe(scene, replaceSource(scene, sourceKind(scene), value)));
  } else if (field === "scene-selector") {
    const recipe = storyboardRecipe(scene);
    if (recipe.capture == null) return;
    applyAuthoring(updateSceneRecipe(scene, { capture: { ...recipe.capture, selector: control.value.trim() || "body" } }));
  } else if (field === "scene-duration" || field === "scene-trim-start" || field === "scene-trim-end") {
    const number = control.value.trim() === "" ? undefined : Number(control.value);
    if (number != null && (!Number.isFinite(number) || number < (field === "scene-trim-start" ? 0 : 1))) {
      setFailure(new Error(`${field === "scene-duration" ? "Duration" : "Trim"} is outside its valid range.`));
      return;
    }
    const recipe = { ...scenePresentation(scene) };
    if (field === "scene-duration") recipe.duration = number;
    else if (field === "scene-trim-start") recipe.trimStart = number;
    else recipe.trimEnd = number;
    if (recipe.trimEnd != null && recipe.trimStart != null) {
      if (recipe.trimEnd <= recipe.trimStart) { setFailure(new Error("Trim end must be after trim start.")); return; }
      recipe.duration = recipe.trimEnd - recipe.trimStart;
    }
    applyAuthoring(updateScenePresentation(scene, recipe));
  } else if (field === "scene-fit") {
    applyAuthoring(updateScenePresentation(scene, { fit: control.value as StoryboardRecipe["fit"] }));
  } else if (field === "scene-transition") {
    const previous = scenePresentation(scene).transition;
    const transition = { type: control.value, duration: previous?.duration ?? 300 } as StoryboardRecipe["transition"];
    applyAuthoring(updateScenePresentation(scene, { transition }));
  } else if (field === "scene-transition-duration") {
    const duration = Number(control.value);
    if (!Number.isFinite(duration) || duration < 0) { setFailure(new Error("Transition duration must be non-negative.")); return; }
    const previous = scenePresentation(scene).transition;
    const transition = previous == null ? { type: "crossfade" as const, duration } : { ...previous, duration };
    applyAuthoring(updateScenePresentation(scene, { transition }));
  } else if (field === "scene-preset" && control.value !== "custom") {
    applyAuthoring({ kind: "scene.update", sceneId: scene.id, patch: { treatments: presetTreatments(scene, control.value) } });
  }
});

void delegate(app, "click", "[data-timeline-id]", (event, target) => {
  const itemId = (target as HTMLElement).dataset.timelineId;
  if (itemId == null) return;
  const mouse = event as MouseEvent;
  if (mouse.metaKey || mouse.ctrlKey) {
    timelineSelection.value = timelineSelection.value.includes(itemId)
      ? timelineSelection.value.filter((id) => id !== itemId)
      : [...timelineSelection.value, itemId];
  } else if (!timelineSelection.value.includes(itemId)) {
    timelineSelection.value = [itemId];
  }
  const item = project.value == null ? undefined : buildStudioTimeline(project.value).items.find((candidate) => candidate.id === itemId);
  if (item != null) void seekTimelineItem(item);
});

let timelineDrag: { itemId: string; startX: number; operation: "move" | "resize" } | null = null;
void delegate(app, "pointerdown", "[data-timeline-id]", (event, target) => {
  const itemId = (target as HTMLElement).dataset.timelineId;
  if (itemId == null) return;
  const pointer = event as PointerEvent;
  if (!timelineSelection.value.includes(itemId)) timelineSelection.value = [itemId];
  const resizeHandle = (pointer.target as HTMLElement | null)?.closest("[data-timeline-resize]");
  timelineDrag = { itemId, startX: pointer.clientX, operation: resizeHandle == null ? "move" : "resize" };
  (target as HTMLElement).setPointerCapture?.(pointer.pointerId);
});

window.addEventListener("pointerup", (event) => {
  if (timelineDrag == null) return;
  const drag = timelineDrag;
  timelineDrag = null;
  const deltaMs = (event.clientX - drag.startX) / timelineScale();
  if (Math.abs(deltaMs) < 1) return;
  void run(() => applyTimeline(selectedTimelineCommand(drag.operation, deltaMs)));
});

void delegate(app, "keydown", "[data-timeline-id]", (event) => {
  const keyboard = event as KeyboardEvent;
  if (keyboard.key !== "ArrowLeft" && keyboard.key !== "ArrowRight") return;
  keyboard.preventDefault();
  const direction = keyboard.key === "ArrowLeft" ? -1 : 1;
  const multiplier = keyboard.shiftKey ? 5 : 1;
  void run(() => applyTimeline(selectedTimelineCommand(keyboard.altKey ? "resize" : "move", direction * multiplier * timelineSnapMs.value)));
});

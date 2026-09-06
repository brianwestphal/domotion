import { chromium, type Browser } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createStudioProjectDocument } from "./app-projects.js";
import { applyStudioAuthoringCommand } from "./authoring.js";
import { compileStudioInteractiveProject } from "./interactive-compile.js";
import { validateStudioProject } from "./project.js";
import {
  importStudioInteractionRecording,
  persistStudioRecordingEvidence,
  recordStudioInteractions,
  STUDIO_REDACTED_VALUE,
} from "./recording.js";

const SECRET = "correct horse battery staple";
const URL_SECRET = "navigation-token";

function appHtml(version: 1 | 2): string {
  const button = version === 1 ? "Add item" : "Create item";
  const wrapper = version === 1 ? "controls" : "toolbar redesigned";
  return `<!doctype html>
<meta charset="utf-8">
<style>
  body{margin:0;font:16px system-ui;background:${version === 1 ? "#f6f8fc" : "#f2f5ff"};color:#172033}
  main{padding:${version === 1 ? 24 : 32}px;max-width:680px}
  .${wrapper.split(" ").join(".")}{display:flex;gap:12px;align-items:end}
  label{display:grid;gap:5px}input,button{font:inherit;padding:9px 12px}
  button{background:${version === 1 ? "rgb(12, 80, 190)" : "rgb(80, 58, 190)"};color:white;border:0;border-radius:8px}
  #scroller{height:90px;overflow:auto;border:1px solid #ccd3e0;margin-top:18px}#scroller>div{height:300px;padding:8px}
  .confirmed{outline:3px solid #45a36b}
</style>
<main>
  <h1>Recording fixture ${version}</h1>
  <div class="${wrapper}">
    <label>Password <input id="password" type="password" autocomplete="current-password"></label>
    <button data-testid="create-action">${button}</button>
  </div>
  <ul id="items"></ul>
  <div id="scroller" data-testid="activity"><div>Activity log</div></div>
</main>
<script>
  document.querySelector('[data-testid="create-action"]').addEventListener('click', event => {
    const item=document.createElement('li'); item.textContent='Recorded result v${version}';
    document.querySelector('#items').append(item); event.currentTarget.classList.add('confirmed');
    history.pushState({}, '', '?step=added&token=${URL_SECRET}');
  });
</script>`;
}

describe("Studio real browser recording and semantic replay (DM-2696)", () => {
  let browser: Browser | null = null;

  afterAll(async () => browser?.close(), 15_000);

  it("records, redacts, imports, edits, and replays after a modest application change", async () => {
    try {
      browser = await chromium.launch({ headless: true });
    } catch {
      return;
    }
    const root = mkdtempSync(join(tmpdir(), "domotion-recording-e2e-"));
    const appPath = join(root, "app.html");
    const artifactDir = join(root, "generated");
    const page = await browser.newPage({ viewport: { width: 800, height: 520 } });
    try {
      writeFileSync(appPath, appHtml(1), "utf8");
      await page.goto(pathToFileURL(appPath).href);
      const recording = await recordStudioInteractions(page, async (recordedPage) => {
        const password = recordedPage.getByLabel("Password");
        await password.click();
        await password.pressSequentially(SECRET, { delay: 1 });
        await recordedPage.getByTestId("create-action").hover();
        await recordedPage.getByTestId("create-action").click();
        await recordedPage.getByTestId("activity").evaluate((element) => {
          element.scrollTop = 64;
          element.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
      }, { id: "recording-real-flow", settleMs: 120 });

      const rawJson = JSON.stringify(recording);
      expect(rawJson).not.toContain(SECRET);
      expect(rawJson).not.toContain(URL_SECRET);
      expect(recording.redactions).toBeGreaterThan(0);
      expect(recording.events.some((event) => event.kind === "input" && event.value === STUDIO_REDACTED_VALUE)).toBe(true);
      expect(recording.events.some((event) => event.kind === "pointer" && event.phase === "click")).toBe(true);
      expect(recording.events.some((event) => event.kind === "scroll")).toBe(true);
      expect(recording.events.some((event) => event.kind === "navigation" && event.navigationKind === "push-state")).toBe(true);
      const feedback = recording.events.find((event) => event.kind === "dom-feedback");
      expect(feedback).toBeDefined();
      if (feedback?.kind === "dom-feedback") {
        expect(feedback.mutations.some((mutation) => mutation.kind === "childList")).toBe(true);
        expect(feedback.snapshots.some((snapshot) => Object.hasOwn(snapshot.styles, "backgroundColor"))).toBe(true);
      }

      const project = createStudioProjectDocument({ title: "Recorded story", width: 800, height: 520, createdAt: "2026-09-06T06:00:00.000Z" });
      let requiredPolicyObserved = false;
      const imported = await importStudioInteractionRecording(project, recording, {
        ai: {
          heal: async (request) => {
            requiredPolicyObserved = JSON.stringify(request.aiPolicy) === JSON.stringify({ healing: "required", review: "required" });
            return {
              kind: "candidate",
              summary: "Removed pointer travel, key noise, feedback mutations, and navigation bookkeeping while retaining two intentional actions.",
              evidence: { summary: "Selected the label for the field and data-testid for the action after reviewing live DOM, geometry, and computed CSS evidence." },
              scene: {
                id: "scene-recorded-flow",
                title: "Recorded flow",
                description: "Editable semantic actions inferred from a real interaction.",
                narrativeBeatIds: ["beat-opening"],
                render: { kind: "storyboard", recipe: { capture: { file: basename(appPath) }, duration: 1800 } },
                tracks: [{
                  id: "track-recorded-flow",
                  kind: "semantic-interactions",
                  events: [
                    { id: "event-enter-secret", kind: "type", atMs: 180, durationMs: 300, target: { label: "Password" }, text: STUDIO_REDACTED_VALUE },
                    { id: "event-create", kind: "click", atMs: 760, target: { testId: "create-action" } },
                  ],
                }],
              },
            };
          },
          review: async ({ candidate, aiPolicy }) => {
            expect(aiPolicy).toEqual({ healing: "required", review: "required" });
            expect(candidate.tracks?.[0].events).toHaveLength(2);
            return { kind: "accept", summary: "Accepted the stable targets, redaction, simplification, and naturalized pacing.", evidence: { summary: "The candidate is schema-valid and keeps editable intent." } };
          },
        },
        now: "2026-09-06T06:01:00.000Z",
      });
      expect(requiredPolicyObserved).toBe(true);
      expect(imported.status).toBe("imported");
      if (imported.status !== "imported") return;
      persistStudioRecordingEvidence(root, imported);
      expect(readFileSync(join(root, imported.evidencePath), "utf8")).not.toContain(SECRET);

      const editedTracks = structuredClone(imported.scene.tracks!);
      editedTracks[0].events[1].atMs = 900;
      const edited = applyStudioAuthoringCommand(imported.project, {
        kind: "scene.update",
        sceneId: imported.scene.id,
        patch: { title: "Edited recorded flow", tracks: editedTracks },
      }).project;
      expect(validateStudioProject(edited).scenes.at(-1)?.title).toBe("Edited recorded flow");

      // The app's DOM nesting, visual styling, and button name now differ. The
      // AI-selected stable test id and label survive, so the ordinary interactive
      // compiler can replay and capture the edited semantic scene.
      writeFileSync(appPath, appHtml(2), "utf8");
      const compiled = await compileStudioInteractiveProject(browser, edited, {
        projectDir: root,
        artifactDir,
        generatedAt: () => "2026-09-06T06:02:00.000Z",
        generatorVersion: "test",
      });
      const segment = compiled.segments.find((candidate) => candidate.sceneId === imported.scene.id);
      expect(segment?.evidence.map((item) => item.eventId)).toEqual(["event-enter-secret", "event-create"]);
      expect(segment?.durationMs).toBeGreaterThanOrEqual(1800);
      expect(compiled.svg).toContain("Recorded result v2");
      expect(compiled.project.scenes.find((scene) => scene.id === imported.scene.id)?.title).toBe("Edited recorded flow");
    } finally {
      await page.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

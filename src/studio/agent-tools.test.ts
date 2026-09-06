import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  STUDIO_AGENT_TOOL_VERSION,
  buildStudioAgentToolRequestJsonSchema,
  runStudioAgentTool,
  studioAgentProjectDigest,
  studioAgentToolRequestSchema,
  StudioAgentToolError,
  type RunStudioAgentToolOptions,
  type StudioAgentGenerationResult,
  type StudioAgentToolResponse,
} from "./agent-tools.js";
import { validateStudioProject } from "./project.js";
import type { StudioProject } from "./project-schema.js";

const T0 = "2026-09-06T03:00:00.000Z";

function projectFrom(response: StudioAgentToolResponse): StudioProject {
  expect(response.status).toBe("ok");
  expect(response.project).toBeDefined();
  return validateStudioProject(response.project);
}

describe("Studio agent tools (DM-2693)", () => {
  let workspace: string | null = null;

  afterEach(() => {
    if (workspace != null) rmSync(workspace, { recursive: true, force: true });
    workspace = null;
  });

  it("pins the protocol version and reuses canonical Studio scene/track validation", () => {
    const jsonSchema = buildStudioAgentToolRequestJsonSchema();
    expect(jsonSchema).toMatchObject({ $schema: "https://json-schema.org/draft/2020-12/schema", title: "Domotion Studio agent tool request" });
    expect(JSON.stringify(jsonSchema)).toContain(`\"const\":${STUDIO_AGENT_TOOL_VERSION}`);
    expect(studioAgentToolRequestSchema.safeParse({
      version: 2,
      tool: "project.create",
      title: "Future request",
    }).success).toBe(false);
    expect(studioAgentToolRequestSchema.safeParse({
      version: STUDIO_AGENT_TOOL_VERSION,
      tool: "project.create",
      title: "Spoofed actor",
      actor: { kind: "system" },
    }).success).toBe(false);
    expect(studioAgentToolRequestSchema.safeParse({
      version: STUDIO_AGENT_TOOL_VERSION,
      tool: "project.edit",
      expectedProjectDigest: "0".repeat(64),
      changes: {
        scenes: [{
          sceneId: "scene-opening",
          tracks: [{
            id: "canonical-track",
            kind: "semantic-interactions",
            events: [
              { id: "first", kind: "hover", atMs: 100, durationMs: 200, target: { role: "button" } },
              { id: "overlap", kind: "click", atMs: 200, target: { role: "button" } },
            ],
          }],
        }],
      },
    }).success).toBe(false);
  });

  it("supports an agent create → capture → preview → annotate → revise workflow", async () => {
    workspace = mkdtempSync(join(tmpdir(), "domotion-studio-agent-"));
    let tick = 0;
    const now = (): string => `2026-09-06T03:${String(tick++).padStart(2, "0")}:00.000Z`;
    const options: RunStudioAgentToolOptions = {
      workspaceRoot: workspace,
      actor: { kind: "ai", name: "Demo Director" },
      permissions: {
        editProject: true,
        destructiveProjectEdits: true,
        capture: true,
        artifactWrites: true,
        overwriteArtifacts: true,
        renderVideo: true,
      },
      timestamp: now,
      capture: async ({ project, absolutePath, workspacePath, selection, aiPolicy }) => {
        expect(aiPolicy).toEqual({ healing: "required", review: "required" });
        mkdirSync(absolutePath, { recursive: true });
        const evidencePath = join(absolutePath, "opening-dom.json");
        writeFileSync(evidencePath, JSON.stringify({ selector: "button", computedStyle: { color: "rgb(255, 255, 255)" } }));
        const next = structuredClone(project);
        next.artifacts.push({
          id: "artifact-dom-evidence",
          kind: "capture-evidence",
          path: `${workspacePath}/opening-dom.json`,
          generatedAt: T0,
          generator: { name: "proactive-dom-css-inspector", version: "1" },
          sourceRevisionId: project.review.headRevisionId,
          sceneIds: ["scene-opening"],
          metadata: { inspected: ["dom", "computed-css"] },
        });
        return {
          project: next,
          artifacts: [{
            id: "artifact-dom-evidence",
            kind: "capture-evidence",
            path: evidencePath,
            workspacePath: `${workspacePath}/opening-dom.json`,
            sourceRevisionId: project.review.headRevisionId,
            sceneIds: selection.kind === "scenes" ? selection.sceneIds : project.scenes.map((scene) => scene.id),
          }],
          evidence: { inspected: ["dom", "computed-css"], selectorCount: 1 },
        };
      },
      preview: async ({ project, absolutePath, workspacePath, aiPolicy }): Promise<StudioAgentGenerationResult> => {
        expect(aiPolicy).toEqual({ healing: "required", review: "required" });
        mkdirSync(resolve(absolutePath, ".."), { recursive: true });
        writeFileSync(absolutePath, '<svg xmlns="http://www.w3.org/2000/svg"/>');
        const next = structuredClone(project);
        next.artifacts.push({
          id: "artifact-preview",
          kind: "svg",
          path: workspacePath,
          generatedAt: T0,
          generator: { name: "studio-preview", version: "1" },
          sourceRevisionId: project.review.headRevisionId,
          sceneIds: ["scene-opening"],
          derivedFromArtifactIds: ["artifact-dom-evidence"],
        });
        return {
          project: next,
          artifacts: [{ id: "artifact-preview", kind: "svg", path: absolutePath, workspacePath, sourceRevisionId: project.review.headRevisionId, sceneIds: ["scene-opening"] }],
          evidence: { sourceArtifactIds: ["artifact-dom-evidence"] },
        };
      },
    };

    const created = await runStudioAgentTool(null, {
      version: STUDIO_AGENT_TOOL_VERSION,
      tool: "project.create",
      title: "Agent-authored tour",
    }, options);
    let project = projectFrom(created);
    expect(project.review.revisions[0].author).toEqual({ kind: "ai", name: "Demo Director" });

    const authored = await runStudioAgentTool(project, {
      version: STUDIO_AGENT_TOOL_VERSION,
      tool: "project.edit",
      expectedProjectDigest: studioAgentProjectDigest(project),
      changes: {
        narrative: { objective: "Show the real checkout interaction." },
        scenes: [{
          sceneId: "scene-opening",
          render: { kind: "storyboard", recipe: { capture: { url: "https://example.test/checkout", selector: "main" }, duration: 1800 } },
          tracks: [{
            id: "track-checkout",
            kind: "semantic-interactions",
            events: [{ id: "action-buy", kind: "click", atMs: 700, target: { role: "button", name: "Buy now" } }],
          }],
        }],
      },
    }, options);
    project = projectFrom(authored);

    const captured = await runStudioAgentTool(project, {
      version: STUDIO_AGENT_TOOL_VERSION,
      tool: "capture.compile",
      selection: { kind: "scenes", sceneIds: ["scene-opening"] },
      artifactDir: "artifacts/capture",
    }, options);
    project = projectFrom(captured);
    expect(captured.artifacts).toEqual([expect.objectContaining({
      path: join(workspace, "artifacts/capture/opening-dom.json"),
      workspacePath: "artifacts/capture/opening-dom.json",
    })]);
    expect(captured.data).toMatchObject({ inspected: ["dom", "computed-css"] });

    const previewed = await runStudioAgentTool(project, {
      version: STUDIO_AGENT_TOOL_VERSION,
      tool: "render.preview",
      selection: { kind: "project" },
      outputPath: "artifacts/preview.svg",
    }, options);
    project = projectFrom(previewed);
    expect(previewed.artifacts?.[0]).toMatchObject({ path: join(workspace, "artifacts/preview.svg"), workspacePath: "artifacts/preview.svg" });

    const annotated = await runStudioAgentTool(project, {
      version: STUDIO_AGENT_TOOL_VERSION,
      tool: "annotation.apply",
      expectedProjectDigest: studioAgentProjectDigest(project),
      command: {
        kind: "create",
        body: "AI review: give the CTA another 300ms of dwell time.",
        target: {
          scope: { kind: "scene", sceneId: "scene-opening" },
          trackId: "track-checkout",
          eventId: "action-buy",
          time: { pointMs: 700, range: { startMs: 650, endMs: 1000 } },
          domTarget: { role: "button", name: "Buy now" },
          regions: [{ x: 640, y: 520, width: 180, height: 48, coordinateSpace: "artifact-pixels", artifactId: "artifact-preview" }],
        },
        evidenceArtifactIds: ["artifact-preview", "artifact-dom-evidence"],
      },
    }, options);
    project = projectFrom(annotated);
    expect(project.review.annotations[0]).toMatchObject({ author: { kind: "ai", name: "Demo Director" }, status: "open" });

    const revised = await runStudioAgentTool(project, {
      version: STUDIO_AGENT_TOOL_VERSION,
      tool: "project.edit",
      expectedProjectDigest: studioAgentProjectDigest(project),
      changes: { narrative: { summary: "Revised after grounded AI review." } },
    }, options);
    project = projectFrom(revised);
    const inspected = await runStudioAgentTool(project, { version: STUDIO_AGENT_TOOL_VERSION, tool: "project.inspect", include: "annotations" }, options);
    expect(inspected.data).toMatchObject({
      title: "Agent-authored tour",
      scenes: [{ id: "scene-opening", trackIds: ["track-checkout"], eventIds: ["action-buy"] }],
      review: { openAnnotationIds: [project.review.annotations[0].id] },
      annotations: [expect.objectContaining({ body: "AI review: give the CTA another 300ms of dwell time." })],
    });
    expect(inspected.project).toBeUndefined();
    expect(JSON.stringify(inspected.data).length).toBeLessThan(JSON.stringify(project).length);
  });

  it("returns explicit clarification, conflict, and bounded permission states", async () => {
    workspace = mkdtempSync(join(tmpdir(), "domotion-studio-agent-"));
    const baseOptions: RunStudioAgentToolOptions = {
      workspaceRoot: workspace,
      actor: { kind: "ai" },
      permissions: { editProject: true, artifactWrites: true },
      timestamp: () => T0,
      preview: async () => { throw new Error("ambiguous request must not call the adapter"); },
    };
    let project = projectFrom(await runStudioAgentTool(null, {
      version: STUDIO_AGENT_TOOL_VERSION, tool: "project.create", title: "Permissions",
    }, baseOptions));
    project = projectFrom(await runStudioAgentTool(project, {
      version: STUDIO_AGENT_TOOL_VERSION,
      tool: "project.edit",
      expectedProjectDigest: studioAgentProjectDigest(project),
      changes: { addScenes: [{ id: "scene-second", render: { kind: "storyboard", recipe: { template: "title-card", params: { title: "Second" }, duration: 1000 } } }] },
    }, baseOptions));

    const clarification = await runStudioAgentTool(project, {
      version: STUDIO_AGENT_TOOL_VERSION, tool: "render.preview", outputPath: "preview.svg",
    }, baseOptions);
    expect(clarification).toMatchObject({ status: "clarification", clarification: { choices: ["complete project", "scene-opening", "scene-second"] } });

    const stale = await runStudioAgentTool(project, {
      version: STUDIO_AGENT_TOOL_VERSION,
      tool: "project.edit",
      expectedProjectDigest: "0".repeat(64),
      changes: { narrative: { title: "Stale" } },
    }, baseOptions);
    expect(stale.status).toBe("conflict");

    const digest = studioAgentProjectDigest(project);
    const unconfirmed = await runStudioAgentTool(project, {
      version: STUDIO_AGENT_TOOL_VERSION,
      tool: "project.edit",
      expectedProjectDigest: digest,
      changes: { removeSceneIds: ["scene-second"] },
    }, baseOptions);
    expect(unconfirmed).toMatchObject({ status: "permission-required", permission: { name: "destructiveProjectEdits", destructiveIds: ["scene-second"] } });

    const denied = await runStudioAgentTool(project, {
      version: STUDIO_AGENT_TOOL_VERSION,
      tool: "project.edit",
      expectedProjectDigest: digest,
      changes: { removeSceneIds: ["scene-second"] },
      destructive: { allow: true, reason: "Remove the obsolete alternate scene.", expectedProjectDigest: digest },
    }, baseOptions);
    expect(denied).toMatchObject({ status: "permission-required", permission: { name: "destructiveProjectEdits" } });
  });

  it("keeps artifact writes inside the workspace and makes required AI video review observable", async () => {
    workspace = mkdtempSync(join(tmpdir(), "domotion-studio-agent-"));
    const options: RunStudioAgentToolOptions = {
      workspaceRoot: workspace,
      actor: { kind: "ai" },
      permissions: { editProject: true, artifactWrites: true, renderVideo: true },
      timestamp: () => T0,
      video: async ({ review, aiPolicy }) => ({
        clarification: {
          question: "Should the unreadable mobile label be shortened or wrapped?",
          reason: `AI review is ${review}; healing is ${aiPolicy.healing}; DOM/CSS-backed legibility is ambiguous.`,
          choices: ["shorten", "wrap"],
        },
        evidence: { inspected: ["dom", "computed-css", "rendered-frame"] },
      }),
    };
    const project = projectFrom(await runStudioAgentTool(null, {
      version: STUDIO_AGENT_TOOL_VERSION, tool: "project.create", title: "Reviewed video",
    }, options));
    const review = await runStudioAgentTool(project, {
      version: STUDIO_AGENT_TOOL_VERSION,
      tool: "render.video",
      selection: { kind: "project" },
      inputSvgPath: "artifacts/preview.svg",
      outputPath: "artifacts/review.mp4",
      review: "required",
    }, options);
    expect(review).toMatchObject({ status: "clarification", data: { inspected: ["dom", "computed-css", "rendered-frame"] } });

    await expect(runStudioAgentTool(project, {
      version: STUDIO_AGENT_TOOL_VERSION,
      tool: "render.preview",
      outputPath: "../outside.svg",
    }, { ...options, preview: async () => ({ artifacts: [] }) })).rejects.toThrow(StudioAgentToolError);
  });
});

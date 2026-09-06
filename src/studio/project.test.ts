import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { compileStudioProject } from "./compile.js";
import {
  StudioProjectValidationError,
  importStoryboardConfig,
  loadStudioProject,
  parseStudioProjectJson,
  saveStudioProject,
  serializeStudioProject,
  studioProjectToStoryboardConfig,
  validateStudioProject,
} from "./project.js";
import {
  STUDIO_PROJECT_FORMAT,
  STUDIO_PROJECT_SCHEMA_ID,
  STUDIO_PROJECT_VERSION,
} from "./project-schema.js";

const NOW = "2026-09-06T01:00:00.000Z";

function comprehensiveProject(): unknown {
  return {
    $schema: STUDIO_PROJECT_SCHEMA_ID,
    format: STUDIO_PROJECT_FORMAT,
    version: STUDIO_PROJECT_VERSION,
    id: "project-tour",
    createdAt: NOW,
    canvas: { width: 640, height: 360, background: "#05070d", title: "Tour" },
    narrative: {
      title: "Product tour",
      objective: "Explain the core workflow",
      audience: "New users",
      beats: [{ id: "beat-intro", title: "Introduce", sceneIds: ["scene-intro"] }],
    },
    scenes: [{
      id: "scene-intro",
      title: "Introduction",
      narrativeBeatIds: ["beat-intro"],
      render: {
        kind: "composition",
        duration: 1200,
        transition: { type: "crossfade", duration: 200 },
        composition: {
          width: 640,
          height: 360,
          duration: 1200,
          layers: [{
            id: "layer-group",
            kind: "composition",
            placement: { x: 20, y: 20, width: 600, height: 320 },
            composition: {
              width: 600,
              height: 320,
              duration: 1200,
              layers: [{
                id: "layer-title",
                kind: "source",
                source: { template: "title-card", params: { title: "Hello" } },
              }],
            },
          }],
        },
      },
      tracks: [{
        id: "track-primary",
        kind: "semantic-interactions",
        events: [
          { id: "event-click", kind: "click", atMs: 100, target: { role: "button", name: "Continue" } },
          { id: "event-hook", kind: "scriptHook", atMs: 300, hookId: "hook-seed" },
        ],
      }],
      scriptHooks: [{ hookId: "hook-seed", phase: "beforeCapture" }],
    }],
    scriptHooks: [{ id: "hook-seed", module: "./hooks/seed.mjs", export: "seed" }],
    review: {
      headRevisionId: "revision-1",
      revisions: [{
        id: "revision-1",
        createdAt: NOW,
        author: { kind: "human", name: "Ada" },
        summary: "Created the tour.",
      }],
      annotations: [{
        id: "annotation-1",
        status: "open",
        body: "Pause longer on the call to action.",
        author: { kind: "human", name: "Ada" },
        createdAt: NOW,
        createdRevisionId: "revision-1",
        target: {
          sceneId: "scene-intro",
          trackId: "track-primary",
          eventId: "event-click",
          layerId: "layer-title",
          atMs: 100,
          endMs: 300,
          regions: [{ x: 10, y: 10, width: 80, height: 40 }],
        },
        evidenceArtifactIds: ["artifact-preview"],
      }],
    },
    artifacts: [{
      id: "artifact-preview",
      kind: "svg",
      path: "./generated/preview.svg",
      generatedAt: NOW,
      generator: { name: "domotion", version: "0.27.1" },
      sourceRevisionId: "revision-1",
      sceneIds: ["scene-intro"],
      sha256: "a".repeat(64),
    }],
    exportTargets: { svgPath: "./generated/tour.svg", reviewVideoPath: "./generated/tour.mp4" },
  };
}

describe("Studio project validation", () => {
  it("accepts the complete v1 model and preserves stable identities", () => {
    const project = validateStudioProject(comprehensiveProject());
    expect(project.version).toBe(1);
    expect(project.scenes[0].id).toBe("scene-intro");
    expect(project.scenes[0].tracks?.[0].events.map((event) => event.id)).toEqual(["event-click", "event-hook"]);
    expect(project.review.annotations[0].target?.layerId).toBe("layer-title");
    expect(project.artifacts[0].sourceRevisionId).toBe("revision-1");
  });

  it("reports unknown versions directly", () => {
    expect(() => validateStudioProject({ ...(comprehensiveProject() as object), version: 2 })).toThrow(
      /\$\.version: unsupported Studio project version 2; this build supports version 1/,
    );
  });

  it("reports strict unknown fields and broken references with their JSON paths", () => {
    const raw = comprehensiveProject() as Record<string, unknown>;
    raw.unexpected = true;
    try {
      validateStudioProject(raw);
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(StudioProjectValidationError);
      const validation = error as StudioProjectValidationError;
      expect(validation.issues.some((issue) => issue.path === "$" && /unexpected/.test(issue.message))).toBe(true);
    }

    const brokenRef = comprehensiveProject() as Record<string, unknown>;
    const narrative = brokenRef.narrative as { beats: { sceneIds: string[] }[] };
    narrative.beats[0].sceneIds = ["scene-missing"];
    expect(() => validateStudioProject(brokenRef)).toThrow(
      /\$\.narrative\.beats\[0\]\.sceneIds\[0\]: references unknown scene id "scene-missing"/,
    );
  });

  it("rejects duplicate stable IDs and malformed semantic targets", () => {
    const raw = comprehensiveProject() as Record<string, unknown>;
    const scenes = raw.scenes as Record<string, unknown>[];
    scenes.push({ ...scenes[0] });
    const firstTrack = (scenes[0].tracks as { events: Record<string, unknown>[] }[])[0];
    firstTrack.events[0].target = {};
    expect(() => validateStudioProject(raw)).toThrow(/duplicate scene id|semantic locator/);
  });

  it("turns malformed JSON into a source-labeled validation error", () => {
    expect(() => parseStudioProjectJson("{ nope", "demo.project.json")).toThrow(
      /demo\.project\.json is invalid:[\s\S]*invalid JSON/,
    );
  });
});

describe("Studio project persistence and storyboard migration", () => {
  it("has byte-stable save/load/save round trips", () => {
    const dir = mkdtempSync(join(tmpdir(), "domotion-studio-project-"));
    try {
      const first = join(dir, "first.json");
      const second = join(dir, "second.json");
      const saved = saveStudioProject(first, comprehensiveProject());
      const loaded = loadStudioProject(first);
      saveStudioProject(second, loaded);
      expect(loaded).toEqual(saved);
      expect(readFileSync(second, "utf8")).toBe(readFileSync(first, "utf8"));
      expect(serializeStudioProject(loaded)).toBe(readFileSync(first, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("imports today's storyboard recipe losslessly and deterministically", () => {
    const storyboard = {
      width: 480,
      height: 270,
      output: "tour.svg",
      background: "#111827",
      title: "Tour",
      desc: "A short tour",
      cursor: { events: [{ frame: 0, at: 100, type: "moveClick" as const, to: { x: 30, y: 40 } }] },
      scenes: [
        { svg: "intro.svg", duration: 1000, transition: { type: "crossfade" as const, duration: 200 } },
        { capture: { file: "demo.html" }, duration: 800 },
      ],
    };
    const a = importStoryboardConfig(storyboard, { createdAt: NOW });
    const b = importStoryboardConfig(storyboard, { createdAt: NOW });
    expect(a.scenes.map((scene) => scene.id)).toEqual(b.scenes.map((scene) => scene.id));
    expect(studioProjectToStoryboardConfig(a)).toEqual(storyboard);
    expect(a.exportTargets?.svgPath).toBe("tour.svg");
  });
});

describe("Studio static compile boundary", () => {
  it("rejects semantic tracks instead of silently ignoring authored interaction", async () => {
    const browser = null as unknown as Browser;
    await expect(compileStudioProject(browser, comprehensiveProject())).rejects.toThrow(
      /\$\.scenes\[0\]\.tracks\[0\].*does not execute semantic interaction events/,
    );
  });
});

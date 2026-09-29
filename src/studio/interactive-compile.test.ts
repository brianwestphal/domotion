import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Browser } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { compileStudioInteractiveProject, finalCursorPoint, sceneCursorOptions } from "./interactive-compile.js";
import { STUDIO_PROJECT_FORMAT, STUDIO_PROJECT_VERSION, type StudioProject } from "./project-schema.js";

const noBrowser = null as unknown as Browser;
const fixtureDir = resolve("tests/fixtures/studio");

function staticProject(): StudioProject {
  return {
    format: STUDIO_PROJECT_FORMAT,
    version: STUDIO_PROJECT_VERSION,
    id: "pre-rendered-project",
    createdAt: "2026-09-06T00:00:00.000Z",
    canvas: { width: 480, height: 270 },
    narrative: { title: "Pre-rendered", beats: [{ id: "beat", title: "Finish", sceneIds: ["scene"] }] },
    scenes: [
      {
        id: "scene",
        narrativeBeatIds: ["beat"],
        render: { kind: "storyboard", recipe: { svg: "interactive-followup.svg", duration: 700 } },
      },
    ],
    review: {
      headRevisionId: "revision",
      revisions: [
        { id: "revision", createdAt: "2026-09-06T00:00:00.000Z", author: { kind: "system" }, summary: "Created." },
      ],
      annotations: [],
    },
    artifacts: [],
  };
}

describe("Studio interactive compiler boundaries", () => {
  it("keeps pre-rendered scenes on the static path and cleans staging after success or early failure", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "domotion-studio-interactive-unit-"));
    try {
      const project = staticProject();
      const result = await compileStudioInteractiveProject(noBrowser, project, { projectDir: fixtureDir, artifactDir });
      expect(result.segments).toEqual([]);
      expect(result.project).toEqual(project);
      expect(result.svg).toContain("interactive-followup-marker");
      expect(readdirSync(artifactDir)).toEqual([]);

      const activeSvg = structuredClone(project);
      activeSvg.scenes[0].tracks = [
        {
          id: "track",
          kind: "semantic-interactions",
          events: [{ id: "click", atMs: 0, kind: "click", target: { text: "All done" } }],
        },
      ];
      await expect(
        compileStudioInteractiveProject(noBrowser, activeSvg, { projectDir: fixtureDir, artifactDir }),
      ).rejects.toThrow(/must use a live URL\/file capture source/);
      expect(readdirSync(artifactDir)).toEqual([]);
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });
});

describe("cursor continuity between live scenes", () => {
  const timing = (
    point: { x: number; y: number },
    destinationPoint?: { x: number; y: number },
  ): {
    eventId: string;
    authoredAtMs: number;
    presentedAtMs: number;
    point: typeof point;
    destinationPoint?: typeof point;
  } => ({
    eventId: "e",
    authoredAtMs: 0,
    presentedAtMs: 0,
    point,
    ...(destinationPoint != null ? { destinationPoint } : {}),
  });

  it("finalCursorPoint is the last interaction's rest point: a drag's destination, else its aim", () => {
    expect(finalCursorPoint({ interactions: [] })).toBeUndefined();
    expect(finalCursorPoint({ interactions: [timing({ x: 1, y: 2 })] })).toEqual({ x: 1, y: 2 });
    expect(
      finalCursorPoint({ interactions: [timing({ x: 1, y: 2 }), timing({ x: 3, y: 4 }, { x: 9, y: 8 })] }),
    ).toEqual({
      x: 9,
      y: 8,
    });
  });

  it("chains the previous scene's rest point as `start`, seeded by the scene id", () => {
    expect(sceneCursorOptions("scene-b", { x: 5, y: 6 }, undefined)).toEqual({
      seed: "scene-b",
      start: { x: 5, y: 6 },
    });
    expect(sceneCursorOptions("scene-a", undefined, undefined)).toEqual({ seed: "scene-a" });
  });

  it("an explicit caller `cursor.start` (and seed) wins over continuity", () => {
    expect(sceneCursorOptions("s", { x: 5, y: 6 }, { start: { x: 100, y: 100 } })).toEqual({
      seed: "s",
      start: { x: 100, y: 100 },
    });
    expect(sceneCursorOptions("s", { x: 5, y: 6 }, { seed: "fixed", leadInMs: 200 })).toEqual({
      seed: "fixed",
      start: { x: 5, y: 6 },
      leadInMs: 200,
    });
  });
});

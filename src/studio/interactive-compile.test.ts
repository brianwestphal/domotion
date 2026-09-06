import type { Browser } from "@playwright/test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compileStudioInteractiveProject } from "./interactive-compile.js";
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
    scenes: [{
      id: "scene",
      narrativeBeatIds: ["beat"],
      render: { kind: "storyboard", recipe: { svg: "interactive-followup.svg", duration: 700 } },
    }],
    review: {
      headRevisionId: "revision",
      revisions: [{ id: "revision", createdAt: "2026-09-06T00:00:00.000Z", author: { kind: "system" }, summary: "Created." }],
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
      activeSvg.scenes[0].tracks = [{
        id: "track",
        kind: "semantic-interactions",
        events: [{ id: "click", atMs: 0, kind: "click", target: { text: "All done" } }],
      }];
      await expect(compileStudioInteractiveProject(noBrowser, activeSvg, { projectDir: fixtureDir, artifactDir }))
        .rejects.toThrow(/must use a live URL\/file capture source/);
      expect(readdirSync(artifactDir)).toEqual([]);
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });
});

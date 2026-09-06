import type { Browser } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resumeStudioHealingLoop, runStudioHealingLoop, StudioHealingError } from "./healing.js";
import { STUDIO_PROJECT_FORMAT, STUDIO_PROJECT_VERSION, type StudioProject } from "./project-schema.js";

const noBrowser = null as unknown as Browser;
const fixtureDir = resolve("tests/fixtures/studio");
const timestamp = () => "2026-09-06T06:00:00.000Z";

function project(): StudioProject {
  return {
    format: STUDIO_PROJECT_FORMAT,
    version: STUDIO_PROJECT_VERSION,
    id: "healing-unit",
    createdAt: "2026-09-06T00:00:00.000Z",
    canvas: { width: 480, height: 270 },
    narrative: { title: "Original", beats: [{ id: "beat", title: "Finish", sceneIds: ["scene"] }] },
    scenes: [{
      id: "scene",
      narrativeBeatIds: ["beat"],
      render: { kind: "storyboard", recipe: { svg: "interactive-followup.svg", duration: 700 } },
    }],
    review: {
      headRevisionId: "revision-1",
      revisions: [{ id: "revision-1", createdAt: "2026-09-06T00:00:00.000Z", author: { kind: "human" }, summary: "Created." }],
      annotations: [],
    },
    artifacts: [],
  };
}

function withArtifacts<T>(run: (artifactDir: string) => Promise<T>): Promise<T> {
  const artifactDir = mkdtempSync(join(tmpdir(), "domotion-healing-unit-"));
  return run(artifactDir).finally(() => rmSync(artifactDir, { recursive: true, force: true }));
}

describe("Studio AI healing state machine", () => {
  it("requires AI review, records review edits with exact provenance, then hands the candidate to a human", () => withArtifacts(async (artifactDir) => {
    const review = vi.fn(async ({ project: current }: { project: StudioProject }) => {
      if (current.narrative.title === "Original") {
        const edited = structuredClone(current);
        edited.narrative.title = "AI-polished";
        return { kind: "edit" as const, project: edited, summary: "Clarified the story title.", evidence: { summary: "The title did not state the outcome.", data: { rubric: "clarity" } } };
      }
      return { kind: "accept" as const, summary: "Ready for human review.", evidence: { summary: "Clarity check passed." } };
    });
    const result = await runStudioHealingLoop(noBrowser, project(), {
      projectDir: fixtureDir,
      artifactDir,
      heal: async () => { throw new Error("healing should not run"); },
      review,
      revisionTimestamp: timestamp,
    });

    expect(result.status).toBe("human-review");
    if (result.status !== "human-review") return;
    expect(review).toHaveBeenCalledTimes(2);
    expect(result.project.narrative.title).toBe("AI-polished");
    expect(result.project.review.revisions).toHaveLength(2);
    expect(result.project.review.revisions[1]).toMatchObject({
      parentId: "revision-1",
      author: { kind: "ai", name: "Studio AI" },
      summary: "Clarified the story title.",
      metadata: { automation: { phase: "review", evidence: { data: { rubric: "clarity" } } } },
    });
    expect(result.project.review.revisions[1].metadata).toMatchObject({
      automation: { changes: [{ path: "$.narrative.title", before: "Original", after: "AI-polished" }] },
    });
  }));

  it("pauses review for clarification and resumes from the exact project snapshot", () => withArtifacts(async (artifactDir) => {
    const initial = project();
    const first = await runStudioHealingLoop(noBrowser, initial, {
      projectDir: fixtureDir,
      artifactDir,
      heal: async () => { throw new Error("healing should not run"); },
      review: async () => ({
        kind: "clarify",
        question: "Should the ending emphasize speed or trust?",
        reason: "Both readings are plausible.",
        evidence: { summary: "The narrative objective does not choose one." },
      }),
    });
    expect(first.status).toBe("clarification");
    if (first.status !== "clarification") return;
    expect(first.project).toEqual(initial);

    const tampered = structuredClone(first.checkpoint);
    tampered.project.narrative.title = "Modified outside the checkpoint";
    await expect(resumeStudioHealingLoop(noBrowser, tampered, "Emphasize trust.", {
      projectDir: fixtureDir,
      artifactDir,
      heal: async () => { throw new Error("healing should not run"); },
      review: async () => { throw new Error("review should not run"); },
    })).rejects.toThrow(/checkpoint was modified/);

    const resumed = await resumeStudioHealingLoop(noBrowser, first.checkpoint, "Emphasize trust.", {
      projectDir: fixtureDir,
      artifactDir,
      heal: async () => { throw new Error("healing should not run"); },
      review: async ({ clarification }) => {
        expect(clarification).toEqual({ phase: "review", question: first.checkpoint.question, answer: "Emphasize trust." });
        return { kind: "accept", summary: "Trust is clear.", evidence: { summary: "The human resolved the ambiguity." } };
      },
    });
    expect(resumed.status).toBe("human-review");
    expect(resumed.project.review).toEqual(initial.review);
  }));

  it("isolates callback inputs so mutation cannot bypass revision provenance", () => withArtifacts(async (artifactDir) => {
    const result = await runStudioHealingLoop(noBrowser, project(), {
      projectDir: fixtureDir,
      artifactDir,
      heal: async () => { throw new Error("healing should not run"); },
      review: async (request) => {
        request.project.narrative.title = "Untracked mutation";
        request.candidate.project.narrative.title = "Another untracked mutation";
        return { kind: "accept", summary: "No edit requested.", evidence: { summary: "Callback isolation test." } };
      },
    });
    expect(result.project.narrative.title).toBe("Original");
    expect(result.project.review.revisions).toHaveLength(1);
  }));

  it("returns unrecoverable intent without invoking review", () => withArtifacts(async (artifactDir) => {
    const active = project();
    active.scenes[0].tracks = [{
      id: "track",
      kind: "semantic-interactions",
      events: [{ id: "missing", atMs: 0, kind: "click", target: { text: "Unknown intent" } }],
    }];
    const review = vi.fn();
    const result = await runStudioHealingLoop(noBrowser, active, {
      projectDir: fixtureDir,
      artifactDir,
      heal: async ({ failure }) => ({ kind: "unrecoverable", reason: "No current product action matches the intent.", evidence: { summary: failure.message } }),
      review,
    });
    expect(result).toMatchObject({ status: "unrecoverable", phase: "heal", reason: "No current product action matches the intent." });
    expect(result.project).toEqual(active);
    expect(review).not.toHaveBeenCalled();
  }));

  it("rejects no-op AI edits instead of silently cycling", () => withArtifacts(async (artifactDir) => {
    await expect(runStudioHealingLoop(noBrowser, project(), {
      projectDir: fixtureDir,
      artifactDir,
      heal: async () => { throw new Error("healing should not run"); },
      review: async ({ project: current }) => ({ kind: "edit", project: current, summary: "No change.", evidence: { summary: "None." } }),
    })).rejects.toBeInstanceOf(StudioHealingError);
  }));

  it("requires clarification before AI changes a script trust boundary", () => withArtifacts(async (artifactDir) => {
    const initial = project();
    initial.scriptHooks = [{ id: "hook", module: "./trusted.ts" }];
    await expect(runStudioHealingLoop(noBrowser, initial, {
      projectDir: fixtureDir,
      artifactDir,
      heal: async () => { throw new Error("healing should not run"); },
      review: async ({ project: current }) => {
        const edited = structuredClone(current);
        edited.scriptHooks![0].module = "./replacement.ts";
        return { kind: "edit", project: edited, summary: "Change executable code.", evidence: { summary: "Requested by review." } };
      },
    })).rejects.toThrow(/script-hook trust boundary without clarification/);
  }));
});

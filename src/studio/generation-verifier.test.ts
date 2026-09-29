import { describe, expect, it } from "vitest";
import { createStudioProjectDocument } from "./app-projects.js";
import { studioContentRevisionId } from "./authoring.js";
import { verifyGeneratedProject } from "./generation-verifier.js";
import type { StudioArtifact, StudioProject } from "./project-schema.js";

const NOW = "2026-09-06T02:00:00.000Z";

function base(): StudioProject {
  return createStudioProjectDocument({ title: "Verifier", createdAt: NOW });
}

/** A generation result that satisfies every invariant: the same project plus one current whole-story SVG. */
function generatedFrom(current: StudioProject, overrides: Partial<StudioArtifact> = {}): StudioProject {
  const next = structuredClone(current);
  next.artifacts.push({
    id: "artifact-story",
    kind: "svg",
    path: "out/story.svg",
    generatedAt: NOW,
    generator: { name: "test" },
    sourceRevisionId: studioContentRevisionId(next),
    ...overrides,
  });
  return next;
}

const story = { kind: "story" } as const;
const rejects = (current: StudioProject, next: StudioProject, message: RegExp, selection = story) => {
  let caught: unknown;
  try {
    verifyGeneratedProject(current, next, selection);
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ status: 400, message: expect.stringMatching(message) });
};

describe("verifyGeneratedProject", () => {
  it("accepts a result that only adds a current SVG artifact for the selection", () => {
    const current = base();
    expect(() => verifyGeneratedProject(current, generatedFrom(current), story)).not.toThrow();
  });

  it("accepts a fresh updatedAt and review provenance appended after the existing entries", () => {
    const current = base();
    const next = generatedFrom(current);
    next.updatedAt = "2026-09-07T00:00:00.000Z";
    expect(() => verifyGeneratedProject(current, next, story)).not.toThrow();
  });

  it("rejects a change to authored content", () => {
    const current = base();
    const next = generatedFrom(current);
    next.canvas.title = "Changed by the adapter";
    rejects(current, next, /preserve authored narrative, scenes, and settings/);
  });

  it("rejects rewritten or dropped review revisions", () => {
    const current = base();
    const next = generatedFrom(current);
    next.review.revisions = [];
    rejects(current, next, /preserve existing review provenance/);
  });

  it("rejects a replaced or dropped existing artifact", () => {
    const current = generatedFrom(base());
    const next = structuredClone(current);
    next.artifacts[0] = { ...next.artifacts[0], path: "elsewhere.svg" };
    next.artifacts.push({ ...current.artifacts[0], id: "artifact-again" });
    rejects(current, next, /preserve existing artifacts/);
  });

  it("rejects a result without an SVG artifact for the current content revision", () => {
    const current = base();
    rejects(current, structuredClone(current), /did not return a current SVG artifact/);
    rejects(current, generatedFrom(current, { sourceRevisionId: "stale-revision" }), /did not return a current SVG/);
    rejects(current, generatedFrom(current, { kind: "image" }), /did not return a current SVG/);
  });

  it("matches the artifact to the requested selection", () => {
    const current = base();
    const sceneOnly = generatedFrom(current, { sceneIds: ["scene-a"] });
    // A whole-story request needs an artifact with no scene ids; a scene request needs exactly that scene.
    rejects(current, sceneOnly, /did not return a current SVG/, story);
    expect(() => verifyGeneratedProject(current, sceneOnly, { kind: "scene", sceneId: "scene-a" })).not.toThrow();
    rejects(current, sceneOnly, /did not return a current SVG/, { kind: "scene", sceneId: "scene-b" } as never);
    const twoScenes = generatedFrom(current, { sceneIds: ["scene-a", "scene-b"] });
    rejects(current, twoScenes, /did not return a current SVG/, { kind: "scene", sceneId: "scene-a" } as never);
  });
});

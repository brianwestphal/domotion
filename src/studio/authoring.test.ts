import { describe, expect, it } from "vitest";
import { createStudioProjectDocument } from "./app-projects.js";
import { validateStudioProject } from "./project.js";
import {
  applyStudioAuthoringCommand,
  commitStudioAuthoringRevision,
  studioContentRevisionId,
  StudioAuthoringError,
} from "./authoring.js";

const NOW = "2026-09-06T05:00:00.000Z";

function ids(): (prefix: string) => string {
  let next = 0;
  return (prefix) => `${prefix}-test-${++next}`;
}

describe("Studio high-level authoring", () => {
  it("adds, duplicates, reorders, and removes scenes without mutating the input", () => {
    const original = createStudioProjectDocument({ title: "Story", createdAt: NOW });
    original.scenes[0].tracks = [{
      id: "track-opening",
      kind: "semantic-interactions",
      events: [{ id: "event-opening", kind: "click", atMs: 100, target: { role: "button", name: "Start" } }],
    }];
    const snapshot = structuredClone(original);
    const duplicated = applyStudioAuthoringCommand(original, { kind: "scene.duplicate", sceneId: "scene-opening" }, { id: ids() });

    expect(original).toEqual(snapshot);
    expect(duplicated.project.scenes).toHaveLength(2);
    expect(duplicated.project.scenes[1]).toMatchObject({ title: "Opening copy", narrativeBeatIds: ["beat-opening"] });
    expect(duplicated.project.scenes[1].id).not.toBe("scene-opening");
    expect(duplicated.project.scenes[1].tracks?.[0].id).not.toBe("track-opening");
    expect(duplicated.project.scenes[1].tracks?.[0].events[0].id).not.toBe("event-opening");
    expect(duplicated.project.narrative.beats[0].sceneIds).toEqual(duplicated.project.scenes.map((scene) => scene.id));

    const moved = applyStudioAuthoringCommand(duplicated.project, {
      kind: "scene.move",
      sceneId: duplicated.project.scenes[1].id,
      toIndex: 0,
    });
    expect(moved.project.narrative.beats[0].sceneIds).toEqual(moved.project.scenes.map((scene) => scene.id));

    const removed = applyStudioAuthoringCommand(moved.project, { kind: "scene.remove", sceneId: "scene-opening" });
    expect(removed.project.scenes).toHaveLength(1);
    expect(removed.project.narrative.beats[0].sceneIds).toEqual([removed.project.scenes[0].id]);
    expect(() => validateStudioProject(removed.project)).not.toThrow();
  });

  it("returns an exact validated undo snapshot for every command", () => {
    const original = createStudioProjectDocument({ title: "Undo story", createdAt: NOW });
    const edited = applyStudioAuthoringCommand(original, { kind: "scene.add" }, { id: ids() });
    const restored = applyStudioAuthoringCommand(edited.project, edited.undo);
    expect(restored.project).toEqual(original);
    expect(edited.project).not.toBe(original);
    expect(restored.project).not.toBe(original);
  });

  it("edits beats and scene authoring fields while maintaining both sides of beat membership", () => {
    const original = createStudioProjectDocument({ title: "Edit story", createdAt: NOW });
    const beatAdded = applyStudioAuthoringCommand(original, { kind: "beat.add", title: "Payoff" }, { id: ids() });
    const payoff = beatAdded.project.narrative.beats[1];
    const sceneUpdated = applyStudioAuthoringCommand(beatAdded.project, {
      kind: "scene.update",
      sceneId: "scene-opening",
      patch: {
        title: "Live product",
        description: "Show the useful path.",
        generationInstructions: "Keep the cursor deliberate and inspect live DOM/CSS before every capture.",
        narrativeBeatIds: [payoff.id],
        render: {
          kind: "storyboard",
          recipe: {
            capture: { url: "https://example.test/product", selector: "main" },
            duration: 2400,
            fit: "contain",
            transition: { type: "push-left", duration: 280 },
          },
        },
        treatments: [{ kind: "browser-chrome", theme: "dark" }],
      },
    });
    expect(sceneUpdated.project.scenes[0]).toMatchObject({
      title: "Live product",
      generationInstructions: expect.stringContaining("DOM/CSS"),
      narrativeBeatIds: [payoff.id],
      treatments: [{ kind: "browser-chrome", theme: "dark" }],
    });
    expect(sceneUpdated.project.narrative.beats[0].sceneIds).toEqual([]);
    expect(sceneUpdated.project.narrative.beats[1].sceneIds).toEqual(["scene-opening"]);
    expect(() => validateStudioProject(sceneUpdated.project)).not.toThrow();
  });

  it("refuses destructive removal when it would orphan annotations or the last scene", () => {
    const original = createStudioProjectDocument({ title: "Guarded story", createdAt: NOW });
    expect(() => applyStudioAuthoringCommand(original, { kind: "scene.remove", sceneId: "scene-opening" })).toThrow(/at least one scene/);
    const added = applyStudioAuthoringCommand(original, { kind: "scene.add" }, { id: ids() }).project;
    added.review.annotations.push({
      id: "annotation-opening",
      status: "open",
      body: "Keep this evidence",
      author: { kind: "human" },
      createdAt: NOW,
      createdRevisionId: added.review.headRevisionId,
      target: { scope: { kind: "scene", sceneId: "scene-opening" } },
    });
    expect(() => applyStudioAuthoringCommand(added, { kind: "scene.remove", sceneId: "scene-opening" }))
      .toThrow(StudioAuthoringError);
  });

  it("commits authored changes as content revisions without letting generic saves rewrite review or artifacts", () => {
    const current = createStudioProjectDocument({ title: "Versioned story", createdAt: NOW });
    const proposed = structuredClone(current);
    proposed.narrative.title = "Versioned story revised";
    const committed = commitStudioAuthoringRevision(current, proposed, {
      expectedHeadRevisionId: current.review.headRevisionId,
      now: "2026-09-06T05:01:00.000Z",
      revisionId: "revision-content-test",
    });
    expect(studioContentRevisionId(committed)).toBe("revision-content-test");
    expect(committed.review.revisions.at(-1)).toMatchObject({
      id: "revision-content-test",
      parentId: "revision-initial",
      kind: "content",
      author: { kind: "human" },
    });
    expect(current.narrative.title).toBe("Versioned story");

    const tampered = structuredClone(proposed);
    tampered.artifacts.push({
      id: "artifact-injected",
      kind: "svg",
      path: "injected.svg",
      generatedAt: NOW,
      generator: { name: "browser" },
      sourceRevisionId: current.review.headRevisionId,
    });
    expect(() => commitStudioAuthoringRevision(current, tampered, { expectedHeadRevisionId: current.review.headRevisionId }))
      .toThrow(/generation API/);
  });
});

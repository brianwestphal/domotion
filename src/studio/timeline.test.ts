import { describe, expect, it } from "vitest";
import { createStudioProjectDocument } from "./app-projects.js";
import { validateStudioProject } from "./project.js";
import {
  applyStudioTimelineCommand,
  buildStudioTimeline,
  moveStudioTimelineItems,
  resizeStudioTimelineItems,
  StudioTimelineError,
  type StudioTimelineCommand,
} from "./timeline.js";

const NOW = "2026-09-06T09:00:00.000Z";

function fixture() {
  const project = createStudioProjectDocument({ title: "Timeline story", createdAt: NOW });
  project.scenes[0] = {
    id: "scene-opening",
    title: "Opening",
    narrativeBeatIds: ["beat-opening"],
    render: {
      kind: "composition",
      duration: 1_000,
      transition: { type: "push-left", duration: 200 },
      overlays: [{ kind: "tap", x: 10, y: 20, delay: 100, endAt: 700 }],
      composition: {
        width: 1280,
        height: 720,
        duration: 1_000,
        layers: [{
          id: "layer-opening",
          kind: "source",
          source: {
            template: "title-card",
            start: 20,
            animations: [{ property: "opacity", from: 0, to: 1, start: 80, duration: 300 }],
          },
        }],
      },
    },
    treatments: [{
      kind: "spotlight",
      mask: { region: { x: 0, y: 0, width: 100, height: 100 } },
      color: "#000000",
      opacity: 0.68,
      timing: { startMs: 200, durationMs: 400, easing: "linear" },
    }],
    tracks: [
      { id: "track-primary", kind: "semantic-interactions", events: [{ id: "event-click", kind: "click", atMs: 100, durationMs: 100, target: { role: "button", name: "Start" } }] },
      { id: "track-secondary", kind: "semantic-interactions", events: [{ id: "event-hover", kind: "hover", atMs: 120, durationMs: 200, target: { role: "link", name: "Help" } }] },
    ],
  };
  project.scenes.push({
    id: "scene-payoff",
    title: "Payoff",
    render: { kind: "storyboard", recipe: { template: "title-card", params: { title: "Done" }, duration: 800, transition: { type: "cut", duration: 999 } } },
  });
  project.narrative.beats[0].sceneIds.push("scene-payoff");
  project.playback = { cursor: { events: [{ frame: 0, at: 150, type: "move", to: { x: 50, y: 60 }, duration: 200 }] } };
  project.review.annotations.push({
    id: "annotation-timed",
    status: "open",
    body: "Hold here",
    author: { kind: "human" },
    createdAt: NOW,
    createdRevisionId: project.review.headRevisionId,
    target: { scope: { kind: "scene", sceneId: "scene-opening" }, time: { pointMs: 250, range: { startMs: 250, endMs: 450 } } },
  });
  return validateStudioProject(project);
}

function run(project: ReturnType<typeof fixture>, command: StudioTimelineCommand, suffix: string) {
  return applyStudioTimelineCommand(project, command, {
    expectedHeadRevisionId: project.review.headRevisionId,
    now: `2026-09-06T09:0${suffix}:00.000Z`,
    revisionId: `revision-timeline-${suffix}`,
  });
}

describe("Studio detailed multitrack timeline transition matrix", () => {
  it("projects scenes and every semantic, cursor, overlay, transition, treatment, annotation, and animation track on the exact shared clock", () => {
    const timeline = buildStudioTimeline(fixture());
    expect(timeline.durationMs).toBe(2_000); // 1000 + 200, then 800 + cut(0)
    expect(new Set(timeline.items.map((item) => item.kind))).toEqual(new Set([
      "scene", "semantic-action", "cursor", "overlay", "transition", "treatment", "annotation", "animation",
    ]));
    expect(timeline.items.find((item) => item.id === "scene:scene-payoff")).toMatchObject({ startMs: 1200, endMs: 2000 });
    expect(timeline.items.find((item) => item.id === "animation:scene-opening:0:0")).toMatchObject({ startMs: 100, endMs: 400 });
    expect(timeline.items.find((item) => item.id === "transition:scene-opening")).toMatchObject({ startMs: 1000, endMs: 1200 });
  });

  it.each([
    ["semantic:scene-opening:track-primary:event-click", 250, 350],
    ["cursor:0", 300, 500],
    ["overlay:scene-opening:0", 250, 850],
    ["treatment:scene-opening:0", 350, 750],
    ["annotation:annotation-timed", 400, 600],
    ["animation:scene-opening:0:0", 250, 550],
  ] as const)("moves %s through explicit overrides and round-trips exact undo/redo", (itemId, startMs, endMs) => {
    const original = fixture();
    const moved = run(original, { kind: "set-timing", changes: [{ itemId, startMs, endMs }] }, "1");
    expect(buildStudioTimeline(moved.project).items.find((item) => item.id === itemId)).toMatchObject({ startMs, endMs });
    expect(original).toEqual(fixture());

    const undone = run(moved.project, moved.inverse, "2");
    const originalItem = buildStudioTimeline(original).items.find((item) => item.id === itemId);
    expect(buildStudioTimeline(undone.project).items.find((item) => item.id === itemId)).toMatchObject({
      startMs: originalItem?.startMs,
      endMs: originalItem?.endMs,
    });
    const redone = run(undone.project, undone.inverse, "3");
    expect(buildStudioTimeline(redone.project).items.find((item) => item.id === itemId)).toMatchObject({ startMs, endMs });
  });

  it("resizes scene and transition ranges while recalculating downstream absolute starts", () => {
    const original = fixture();
    const sceneResize = run(original, resizeStudioTimelineItems(buildStudioTimeline(original), ["scene:scene-opening"], "end", 200, 50), "1");
    expect(buildStudioTimeline(sceneResize.project).items.find((item) => item.id === "scene:scene-payoff")?.startMs).toBe(1400);
    const transitionResize = run(sceneResize.project, resizeStudioTimelineItems(buildStudioTimeline(sceneResize.project), ["transition:scene-opening"], "end", -100, 50), "2");
    expect(buildStudioTimeline(transitionResize.project).items.find((item) => item.id === "scene:scene-payoff")?.startMs).toBe(1300);
  });

  it("supports overlapping items on separate tracks, snapping, multiselect, and rejects same-track overlap atomically", () => {
    const original = fixture();
    const timeline = buildStudioTimeline(original);
    const multi = moveStudioTimelineItems(timeline, [
      "semantic:scene-opening:track-primary:event-click",
      "semantic:scene-opening:track-secondary:event-hover",
    ], 137, 50);
    const moved = run(original, multi, "1");
    expect(multi.changes.map((change) => change.startMs)).toEqual([250, 250]);
    expect(() => validateStudioProject(moved.project)).not.toThrow();

    const invalid = structuredClone(original);
    invalid.scenes[0].tracks![0].events.push({ id: "event-second", kind: "hover", atMs: 300, durationMs: 100, target: { text: "Next" } });
    const valid = validateStudioProject(invalid);
    expect(() => run(valid, { kind: "set-timing", changes: [{ itemId: "semantic:scene-opening:track-primary:event-click", startMs: 250, endMs: 350 }] }, "2"))
      .toThrow(StudioTimelineError);
    expect(valid.scenes[0].tracks![0].events[0].atMs).toBe(100);
  });

  it("records whether the mutation is content or review and honors optimistic concurrency", () => {
    const original = fixture();
    const annotation = run(original, { kind: "set-timing", changes: [{ itemId: "annotation:annotation-timed", startMs: 500, endMs: 500 }] }, "1");
    expect(annotation.project.review.revisions.at(-1)).toMatchObject({ kind: "review", author: { kind: "human" } });
    const content = applyStudioTimelineCommand(original, { kind: "set-timing", changes: [{ itemId: "cursor:0", startMs: 200, endMs: 400 }] }, {
      expectedHeadRevisionId: original.review.headRevisionId,
      author: { kind: "ai", name: "Timeline assistant" },
      revisionId: "revision-ai-timeline",
      now: NOW,
    });
    expect(content.project.review.revisions.at(-1)).toMatchObject({ kind: "content", author: { kind: "ai" } });
    expect(() => applyStudioTimelineCommand(original, content.inverse, { expectedHeadRevisionId: "stale" })).toThrow(/stale timeline change/);
  });
});

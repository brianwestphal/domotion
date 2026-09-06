import { describe, expect, it } from "vitest";
import {
  applyStudioAnnotationCommand,
  importSvgReviewRegionsAnnotation,
  importSvgScrubberReviewAnnotation,
  parseSvgReviewRegions,
  StudioAnnotationError,
} from "./annotations.js";
import { createStudioProjectDocument } from "./app-projects.js";
import { parseStudioProjectJson, serializeStudioProject, validateStudioProject } from "./project.js";
import type { StudioProject } from "./project-schema.js";

const T0 = "2026-09-06T01:00:00.000Z";
const T1 = "2026-09-06T01:01:00.000Z";
const T2 = "2026-09-06T01:02:00.000Z";

function sparseProject(): StudioProject {
  return createStudioProjectDocument({ title: "Review model", createdAt: T0 });
}

function groundedProject(): StudioProject {
  const base = sparseProject();
  return validateStudioProject({
    ...base,
    scenes: [{
      ...base.scenes[0],
      render: {
        kind: "composition",
        composition: {
          width: 1280,
          height: 720,
          duration: 1600,
          layers: [{ id: "layer-cta", kind: "source", source: { template: "title-card", params: { title: "Buy" } } }],
        },
      },
      tracks: [{
        id: "track-primary",
        kind: "semantic-interactions",
        events: [{ id: "action-buy", kind: "click", atMs: 700, target: { role: "button", name: "Buy" } }],
      }],
    }],
    artifacts: [{
      id: "artifact-frame",
      kind: "image",
      path: "./generated/frame.png",
      generatedAt: T0,
      generator: { name: "test" },
      sourceRevisionId: base.review.headRevisionId,
      sceneIds: [base.scenes[0].id],
    }],
  });
}

describe("Studio unified review annotations (DM-2690)", () => {
  it("round-trips a sparse human comment without inventing a target", () => {
    const source = sparseProject();
    const result = applyStudioAnnotationCommand(source, {
      kind: "create",
      body: "Clarify the opening sentence.",
      author: { kind: "human", name: "Ada" },
      origin: { kind: "studio" },
    }, { now: T1, annotationId: "annotation-human", revisionId: "revision-human" });

    expect(source.review.annotations).toEqual([]);
    expect(result.annotation).toMatchObject({
      id: "annotation-human",
      status: "open",
      author: { kind: "human", name: "Ada" },
      createdRevisionId: "revision-human",
    });
    expect(result.annotation.target).toBeUndefined();
    expect(result.revision).toMatchObject({ kind: "review", parentId: "revision-initial" });
    expect(parseStudioProjectJson(serializeStudioProject(result.project))).toEqual(result.project);
  });

  it("uses the same command API for a fully grounded AI finding", () => {
    const source = groundedProject();
    const result = applyStudioAnnotationCommand(source, {
      kind: "create",
      body: "The primary action needs more dwell time.",
      author: { kind: "ai", name: "Studio AI" },
      target: {
        scope: { kind: "scene", sceneId: "scene-opening" },
        time: { pointMs: 760, range: { startMs: 700, endMs: 950 } },
        trackId: "track-primary",
        eventId: "action-buy",
        layerId: "layer-cta",
        domTarget: { role: "button", name: "Buy" },
        regions: [
          { x: 20, y: 30, width: 120, height: 44, coordinateSpace: "artifact-pixels", artifactId: "artifact-frame", sourceImage: "frame.png", label: "CTA" },
          { x: 0, y: 0, width: 1280, height: 720, coordinateSpace: "scene" },
        ],
      },
      evidenceArtifactIds: ["artifact-frame"],
      origin: { kind: "studio", data: { producer: "ai-review" } },
    }, { now: T1, annotationId: "annotation-ai", revisionId: "revision-ai" });

    expect(result.annotation.target?.time).toEqual({ pointMs: 760, range: { startMs: 700, endMs: 950 } });
    expect(result.annotation.target?.regions).toHaveLength(2);
    expect(result.annotation.author.kind).toBe("ai");
    expect(parseStudioProjectJson(serializeStudioProject(result.project)).review.annotations[0]).toEqual(result.annotation);
  });

  it("records recoverable edit/status provenance and enforces lifecycle + stale-head rules", () => {
    const created = applyStudioAnnotationCommand(sparseProject(), {
      kind: "create",
      body: "First wording",
      author: { kind: "human" },
    }, { now: T0, annotationId: "annotation-one", revisionId: "revision-create" });
    const edited = applyStudioAnnotationCommand(created.project, {
      kind: "edit",
      annotationId: "annotation-one",
      author: { kind: "human", name: "Editor" },
      body: "Revised wording",
      target: { scope: { kind: "project" }, time: { pointMs: 400 } },
    }, { now: T1, revisionId: "revision-edit", expectedHeadRevisionId: "revision-create" });
    expect(edited.annotation).toMatchObject({ body: "Revised wording", updatedRevisionId: "revision-edit" });
    expect(edited.revision.metadata).toMatchObject({
      before: { body: "First wording" },
      after: { body: "Revised wording", updatedRevisionId: "revision-edit" },
    });

    const resolved = applyStudioAnnotationCommand(edited.project, {
      kind: "set-status", annotationId: "annotation-one", author: { kind: "human" }, status: "resolved",
    }, { now: T2, revisionId: "revision-resolve" });
    expect(resolved.annotation).toMatchObject({ status: "resolved", statusRevisionId: "revision-resolve", resolvedRevisionId: "revision-resolve" });
    const reopened = applyStudioAnnotationCommand(resolved.project, {
      kind: "set-status", annotationId: "annotation-one", author: { kind: "human" }, status: "open",
    }, { now: T2, revisionId: "revision-reopen" });
    expect(reopened.annotation.status).toBe("open");
    expect(reopened.annotation.resolvedRevisionId).toBeUndefined();
    const superseded = applyStudioAnnotationCommand(reopened.project, {
      kind: "set-status", annotationId: "annotation-one", author: { kind: "human" }, status: "superseded",
    }, { now: T2, revisionId: "revision-supersede" });
    expect(() => applyStudioAnnotationCommand(superseded.project, {
      kind: "set-status", annotationId: "annotation-one", author: { kind: "human" }, status: "open",
    })).toThrow(/superseded and cannot be reopened/);
    expect(() => applyStudioAnnotationCommand(created.project, {
      kind: "edit", annotationId: "annotation-one", author: { kind: "human" }, body: "stale",
    }, { expectedHeadRevisionId: "revision-initial" })).toThrow(/stale annotation change/);
    expect(() => applyStudioAnnotationCommand(created.project, {
      kind: "edit", annotationId: "annotation-one", author: { kind: "human" }, body: "First wording",
    })).toThrow(/did not change anything/);
  });

  it("keeps historically valid sparse resolved v1 annotations readable", () => {
    const legacy = sparseProject();
    legacy.review.annotations.push({
      id: "annotation-legacy-resolved",
      status: "resolved",
      body: "A resolved v1 note without later provenance fields.",
      author: { kind: "human" },
      createdAt: T0,
      createdRevisionId: legacy.review.headRevisionId,
    });
    const validated = validateStudioProject(legacy);
    expect(parseStudioProjectJson(serializeStudioProject(validated))).toEqual(validated);
  });

  it("losslessly migrates modern and legacy SVG Scrubber review tickets", () => {
    const modern = importSvgScrubberReviewAnnotation({
      tool: "svg-scrubber",
      version: 1,
      createdAt: T0,
      title: "Logo jump",
      note: "Watch the transition.",
      svg: "/demo/logo.svg",
      svgName: "logo",
      frameTimeMs: 1234,
      range: { startMs: 1000, endMs: 1500 },
      regions: [{ x: 10, y: 20, w: 30, h: 40 }, { x: 50, y: 60, w: 70, h: 80 }],
      region: { x: 99, y: 99, w: 1, h: 1 },
      framePng: "/demo/logo.png",
    }, { author: { kind: "human", name: "Reviewer" }, sceneId: "scene-opening", sourceReference: "imports/logo.svg", frameReference: "imports/logo.png" });
    expect(modern.target).toMatchObject({
      scope: { kind: "scene", sceneId: "scene-opening" },
      time: { pointMs: 1234, range: { startMs: 1000, endMs: 1500 } },
      regions: [
        { x: 10, y: 20, width: 30, height: 40, coordinateSpace: "svg-user-space" },
        { x: 50, y: 60, width: 70, height: 80, coordinateSpace: "svg-user-space" },
      ],
    });
    expect(modern.body).toBe("Logo jump\n\nWatch the transition.");
    expect(modern.origin).toMatchObject({
      reference: "imports/logo.svg",
      data: { frameReference: "imports/logo.png", frameTimeMs: 1234, range: { startMs: 1000, endMs: 1500 }, sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });

    const legacy = importSvgScrubberReviewAnnotation({
      tool: "svg-scrubber", version: 1, createdAt: T0, title: "Old note", svgName: "old",
      frameTimeMs: 9, range: { startMs: 0, endMs: 0 }, region: { x: 1, y: 2, w: 3, h: 4 },
    }, { author: { kind: "human" } });
    expect(legacy.target?.regions).toHaveLength(1);
    expect(legacy.target?.scope).toEqual({ kind: "project" });
    expect(() => importSvgScrubberReviewAnnotation({
      tool: "svg-scrubber", version: 1, createdAt: T0, title: "Unsafe path", svgName: "old",
      frameTimeMs: 9, range: { startMs: 0, endMs: 0 },
    }, { author: { kind: "human" }, sourceReference: "/private/source.svg" })).toThrow(/project-relative path/);
  });

  it("reuses canonical REGIONS parsing and preserves each image/caption association", () => {
    const text = [
      "Review note",
      "REGIONS:",
      "- image=actual.png (x=10 y=20 w=30 h=40) — first area",
      "- [7] image=diff.png (x=50 y=60 w=70 h=80) - second area",
      "",
      "This trailing prose is outside the block.",
    ].join("\n");
    expect(parseSvgReviewRegions(text).map(({ index, image, caption }) => ({ index, image, caption }))).toEqual([
      { index: 1, image: "actual.png", caption: "first area" },
      { index: 7, image: "diff.png", caption: "second area" },
    ]);
    const command = importSvgReviewRegionsAnnotation(text, {
      body: "Compare the highlighted areas.",
      author: { kind: "human" },
      target: { scope: { kind: "scene", sceneId: "scene-opening" }, time: { pointMs: 100 } },
    });
    expect(command.target?.regions).toEqual([
      { x: 10, y: 20, width: 30, height: 40, coordinateSpace: "artifact-pixels", sourceImage: "actual.png", label: "first area" },
      { x: 50, y: 60, width: 70, height: 80, coordinateSpace: "artifact-pixels", sourceImage: "diff.png", label: "second area" },
    ]);
    expect(() => parseSvgReviewRegions("REGIONS:\n- [1] (x=-1 y=2 w=3 h=4)")).toThrow(StudioAnnotationError);
  });
});

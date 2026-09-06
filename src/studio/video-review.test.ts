import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  STUDIO_VIDEO_REVIEW_DIMENSIONS,
  renderAndReviewStudioVideo,
  resumeStudioVideoReview,
  type StudioVideoReviewFinding,
} from "./video-review.js";
import { STUDIO_PROJECT_FORMAT, STUDIO_PROJECT_VERSION, type StudioProject } from "./project-schema.js";

const NOW = "2026-09-06T07:00:00.000Z";

function project(): StudioProject {
  return {
    format: STUDIO_PROJECT_FORMAT,
    version: STUDIO_PROJECT_VERSION,
    id: "video-review",
    createdAt: "2026-09-06T00:00:00.000Z",
    canvas: { width: 640, height: 360, background: "#fff" },
    narrative: { title: "Checkout", beats: [{ id: "beat-buy", title: "Buy", sceneIds: ["scene-buy"] }] },
    scenes: [{
      id: "scene-buy",
      narrativeBeatIds: ["beat-buy"],
      render: {
        kind: "composition",
        composition: {
          width: 640,
          height: 360,
          duration: 1200,
          layers: [{ id: "layer-product", kind: "source", source: { svg: "product.svg" } }],
        },
      },
      tracks: [{
        id: "track-buy",
        kind: "semantic-interactions",
        events: [{ id: "event-buy", kind: "click", atMs: 600, target: { role: "button", name: "Buy" } }],
      }],
    }],
    review: {
      headRevisionId: "revision-1",
      revisions: [{ id: "revision-1", createdAt: "2026-09-06T00:00:00.000Z", author: { kind: "human", name: "Ada" }, summary: "Created." }],
      annotations: [{
        id: "annotation-human",
        status: "open",
        body: "Keep the checkout concise.",
        author: { kind: "human", name: "Ada" },
        createdAt: "2026-09-06T00:00:00.000Z",
        createdRevisionId: "revision-1",
      }],
    },
    artifacts: [],
  };
}

function findings(): StudioVideoReviewFinding[] {
  return STUDIO_VIDEO_REVIEW_DIMENSIONS.map((dimension, index) => ({
    id: `finding-${index + 1}`,
    dimension,
    severity: index === 0 ? "major" : "minor",
    evidence: {
      summary: `${dimension} observation`,
      observations: [`Visible frame evidence for ${dimension}.`],
      frameTimesMs: [index * 100],
    },
    inference: `${dimension} makes the action harder to follow.`,
    recommendedChange: `Improve ${dimension}.`,
    ...(index === 0 ? {
      target: {
        sceneId: "scene-buy",
        trackId: "track-buy",
        eventId: "event-buy",
        layerId: "layer-product",
        atMs: 500,
        endMs: 900,
        regions: [{ x: 20, y: 30, width: 120, height: 40 }],
        domIdentity: "role=button[name=Buy]",
      },
    } : {}),
  }));
}

function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "domotion-video-review-"));
  writeFileSync(join(dir, "source.svg"), "<svg/>");
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("Studio structured AI video review", () => {
  it("renders through the media boundary and adds every grounded finding to the shared revision queue", () => withDir(async (dir) => {
    const review = vi.fn(async (request) => {
      expect(request.rubric).toEqual(STUDIO_VIDEO_REVIEW_DIMENSIONS);
      expect(request.media.sha256).toMatch(/^[a-f0-9]{64}$/);
      return { kind: "report" as const, summary: "Seven-dimension review complete.", findings: findings() };
    });
    const result = await renderAndReviewStudioVideo(project(), {
      projectDir: dir,
      svgPath: "source.svg",
      outputPath: "review.mp4",
      renderVideo: async ({ outputPath }) => writeFileSync(outputPath, "deterministic-video"),
      review,
      timestamp: () => NOW,
    });

    expect(result.status).toBe("reviewed");
    if (result.status !== "reviewed") return;
    expect(review).toHaveBeenCalledOnce();
    expect(result.project.review.annotations[0]).toMatchObject({ id: "annotation-human", author: { kind: "human" } });
    expect(result.project.review.annotations.slice(1)).toHaveLength(7);
    expect(result.project.review.annotations[1]).toMatchObject({
      author: { kind: "ai", name: "Studio AI" },
      status: "open",
      target: {
        scope: { kind: "scene", sceneId: "scene-buy" },
        trackId: "track-buy",
        eventId: "event-buy",
        layerId: "layer-product",
        time: { pointMs: 500, range: { startMs: 500, endMs: 900 } },
        regions: [{ x: 20, y: 30, width: 120, height: 40 }],
        domIdentity: "role=button[name=Buy]",
      },
    });
    expect(result.project.review.annotations[1].body).toContain("Evidence:");
    expect(result.project.review.annotations[1].body).toContain("Inference:");
    expect(result.project.review.annotations[1].body).toContain("Severity: major");
    expect(result.project.review.annotations[1].body).toContain("Recommended change:");
    expect(result.project.artifacts.map((artifact) => artifact.kind)).toEqual(["review-video", "other"]);
    expect(JSON.parse(readFileSync(join(dir, "review.mp4.review.json"), "utf8"))).toMatchObject({
      version: 1,
      rubric: [...STUDIO_VIDEO_REVIEW_DIMENSIONS],
      kind: "report",
    });
  }));

  it("keeps the general rubric authoritative when comparing revisions", () => withDir(async (dir) => {
    const previous = project();
    writeFileSync(join(dir, "old.mp4"), "old-video");
    const result = await renderAndReviewStudioVideo(project(), {
      projectDir: dir,
      svgPath: "source.svg",
      outputPath: "review.mp4",
      renderVideo: async ({ outputPath }) => writeFileSync(outputPath, "new-video"),
      comparison: {
        project: previous,
        media: { path: join(dir, "old.mp4"), sha256: "b261985457e281a3015ac85c953553a8914f2d2f25f5dc160c25da2ad6b63590", sourceRevisionId: "revision-1", width: 640, height: 360, mimeType: "video/mp4" },
      },
      review: async (request) => {
        expect(request.comparison?.project.narrative.title).toBe("Checkout");
        return {
          kind: "report",
          summary: "Comparison complete.",
          findings: findings(),
          comparison: { summary: "Pacing improved.", improvements: ["Shorter opening."], regressions: [] },
        };
      },
      timestamp: () => NOW,
    });
    expect(result.status).toBe("reviewed");
    if (result.status === "reviewed") {
      expect(result.project.review.revisions.at(-1)?.metadata).toMatchObject({ automation: { comparison: { summary: "Pacing improved." } } });
    }
  }));

  it("rejects a report that skips any rubric dimension", () => withDir(async (dir) => {
    await expect(renderAndReviewStudioVideo(project(), {
      projectDir: dir,
      svgPath: "source.svg",
      outputPath: "review.mp4",
      renderVideo: async ({ outputPath }) => writeFileSync(outputPath, "video"),
      review: async () => ({ kind: "report", summary: "Incomplete.", findings: findings().slice(0, -1) }),
    })).rejects.toThrow(/missing authoritative rubric dimension "overall-polish"/);
  }));

  it("pauses for clarification, verifies its media and project, and resumes without rerendering", () => withDir(async (dir) => {
    const initial = await renderAndReviewStudioVideo(project(), {
      projectDir: dir,
      svgPath: "source.svg",
      outputPath: "review.mp4",
      renderVideo: async ({ outputPath }) => writeFileSync(outputPath, "video-for-question"),
      review: async () => ({
        kind: "clarify",
        question: "Should the call to action emphasize speed or trust?",
        reason: "The intended brand promise is ambiguous.",
        evidence: { summary: "The ending supports both interpretations." },
      }),
    });
    expect(initial.status).toBe("clarification");
    if (initial.status !== "clarification") return;
    expect(initial.project).toEqual(project());

    const result = await resumeStudioVideoReview(initial.checkpoint, "Emphasize trust.", {
      review: async (request) => {
        expect(request.clarification).toEqual({ question: initial.checkpoint.question, answer: "Emphasize trust." });
        return { kind: "report", summary: "Trust-led review complete.", findings: findings() };
      },
      timestamp: () => NOW,
    });
    expect(result.status).toBe("reviewed");

    writeFileSync(initial.checkpoint.media.path, "tampered-video");
    await expect(resumeStudioVideoReview(initial.checkpoint, "Trust", {
      review: async () => ({ kind: "report", summary: "Never reached.", findings: findings() }),
    })).rejects.toThrow(/review video changed/);
  }));
});

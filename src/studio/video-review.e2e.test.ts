import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STUDIO_VIDEO_REVIEW_DIMENSIONS, renderAndReviewStudioVideo } from "./video-review.js";
import { STUDIO_PROJECT_FORMAT, STUDIO_PROJECT_VERSION, type StudioProject } from "./project-schema.js";

const describeWithFfmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).status === 0 ? describe : describe.skip;

function project(): StudioProject {
  return {
    format: STUDIO_PROJECT_FORMAT,
    version: STUDIO_PROJECT_VERSION,
    id: "video-review-e2e",
    createdAt: "2026-09-06T00:00:00.000Z",
    canvas: { width: 100, height: 100, background: "#ffffff" },
    narrative: { title: "Motion", beats: [{ id: "beat", title: "Move", sceneIds: ["scene"] }] },
    scenes: [{ id: "scene", narrativeBeatIds: ["beat"], render: { kind: "storyboard", recipe: { svg: "source.svg", duration: 500 } } }],
    review: {
      headRevisionId: "revision-1",
      revisions: [{ id: "revision-1", createdAt: "2026-09-06T00:00:00.000Z", author: { kind: "human" }, summary: "Created." }],
      annotations: [],
    },
    artifacts: [],
  };
}

describeWithFfmpeg("Studio production video-review pipeline", () => {
  it("renders real review media before invoking AI", async () => {
    const dir = mkdtempSync(join(tmpdir(), "domotion-video-review-e2e-"));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>@keyframes move{from{transform:translateX(0)}to{transform:translateX(60px)}}.box{animation:move .5s linear infinite}</style><rect class="box" y="35" width="30" height="30" fill="#e91e63"/></svg>`;
    writeFileSync(join(dir, "source.svg"), svg);
    try {
      const result = await renderAndReviewStudioVideo(project(), {
        projectDir: dir,
        svgPath: "source.svg",
        outputPath: "review.mp4",
        fps: 4,
        scale: 1,
        review: async (request) => {
          expect(readFileSync(request.media.path).length).toBeGreaterThan(500);
          return {
            kind: "report",
            summary: "Rendered video reviewed.",
            findings: STUDIO_VIDEO_REVIEW_DIMENSIONS.map((dimension, index) => ({
              id: `finding-${index}`,
              dimension,
              severity: "info",
              evidence: { summary: `${dimension} checked from rendered frames.`, frameTimesMs: [125] },
              inference: `${dimension} is acceptable in this fixture.`,
              recommendedChange: `Retain the current ${dimension}.`,
              target: { sceneId: "scene", atMs: 0, endMs: 500, regions: [{ x: 0, y: 0, width: 100, height: 100 }] },
            })),
          };
        },
      });
      expect(result.status).toBe("reviewed");
      expect(readFileSync(join(dir, "review.mp4")).subarray(4, 8).toString()).toBe("ftyp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

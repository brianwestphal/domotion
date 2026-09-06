import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { Browser } from "@playwright/test";
import { z } from "zod";
import { launchChromium } from "../capture/index.js";
import { runSvgToVideo } from "../cli/svg-to-video-core.js";
import { applyStudioAnnotationCommand } from "./annotations.js";
import { validateStudioProject } from "./project.js";
import {
  studioAnnotationTargetSchema,
  studioIdSchema,
  type StudioProject,
} from "./project-schema.js";

export const STUDIO_VIDEO_REVIEW_DIMENSIONS = [
  "pacing",
  "cursor-realism",
  "readability",
  "transitions",
  "narrative-clarity",
  "brand-presentation",
  "overall-polish",
] as const;

export type StudioVideoReviewDimension = typeof STUDIO_VIDEO_REVIEW_DIMENSIONS[number];
export type StudioVideoReviewSeverity = "info" | "minor" | "major" | "critical";

const nonEmpty = z.string().trim().min(1);
const evidenceSchema = z.strictObject({
  summary: nonEmpty,
  observations: z.array(nonEmpty).optional(),
  frameTimesMs: z.array(z.number().nonnegative()).optional(),
});

export const studioVideoReviewFindingSchema = z.strictObject({
  id: studioIdSchema,
  dimension: z.enum(STUDIO_VIDEO_REVIEW_DIMENSIONS),
  severity: z.enum(["info", "minor", "major", "critical"]),
  evidence: evidenceSchema,
  inference: nonEmpty,
  recommendedChange: nonEmpty,
  target: studioAnnotationTargetSchema.optional(),
});

export const studioVideoReviewReportSchema = z
  .strictObject({
    kind: z.literal("report"),
    summary: nonEmpty,
    findings: z.array(studioVideoReviewFindingSchema).min(STUDIO_VIDEO_REVIEW_DIMENSIONS.length),
    comparison: z.strictObject({
      summary: nonEmpty,
      improvements: z.array(nonEmpty),
      regressions: z.array(nonEmpty),
    }).optional(),
  })
  .superRefine((report, ctx) => {
    const ids = new Set<string>();
    report.findings.forEach((finding, index) => {
      if (ids.has(finding.id)) ctx.addIssue({ code: "custom", path: ["findings", index, "id"], message: `duplicate finding id "${finding.id}"` });
      ids.add(finding.id);
    });
    for (const dimension of STUDIO_VIDEO_REVIEW_DIMENSIONS) {
      if (!report.findings.some((finding) => finding.dimension === dimension)) {
        ctx.addIssue({ code: "custom", path: ["findings"], message: `missing authoritative rubric dimension "${dimension}"` });
      }
    }
  });

const clarificationSchema = z.strictObject({
  kind: z.literal("clarify"),
  question: nonEmpty,
  reason: nonEmpty,
  evidence: evidenceSchema,
});

const decisionSchema = z.discriminatedUnion("kind", [studioVideoReviewReportSchema, clarificationSchema]);

export type StudioVideoReviewFinding = z.infer<typeof studioVideoReviewFindingSchema>;
export type StudioVideoReviewReport = z.infer<typeof studioVideoReviewReportSchema>;
export type StudioVideoReviewClarification = z.infer<typeof clarificationSchema>;
export type StudioVideoReviewDecision = z.infer<typeof decisionSchema>;

export interface StudioReviewMedia {
  path: string;
  sha256: string;
  sourceRevisionId: string;
  width: number;
  height: number;
  mimeType: "video/mp4";
}

export interface StudioVideoReviewComparison {
  project: StudioProject;
  media: StudioReviewMedia;
  report?: StudioVideoReviewReport;
}

export interface StudioVideoReviewRequest {
  project: StudioProject;
  media: StudioReviewMedia;
  rubric: readonly StudioVideoReviewDimension[];
  comparison?: StudioVideoReviewComparison;
  clarification?: { question: string; answer: string };
}

export interface StudioVideoReviewClarificationCheckpoint {
  version: 1;
  checkpointDigest: string;
  projectDir: string;
  project: StudioProject;
  projectDigest: string;
  media: StudioReviewMedia;
  comparison?: StudioVideoReviewComparison;
  question: string;
  reason: string;
  evidence: z.infer<typeof evidenceSchema>;
}

export type StudioVideoReviewResult =
  | { status: "reviewed"; project: StudioProject; report: StudioVideoReviewReport; media: StudioReviewMedia }
  | { status: "clarification"; project: StudioProject; checkpoint: StudioVideoReviewClarificationCheckpoint };

export interface RenderStudioReviewVideoOptions {
  svgPath: string;
  outputPath?: string;
  projectDir?: string;
  fps?: number;
  scale?: number;
  ffmpegPath?: string;
  launchBrowser?: () => Promise<Browser>;
  renderVideo?: (input: { svgPath: string; outputPath: string; project: StudioProject }) => Promise<void>;
  review: (request: StudioVideoReviewRequest) => StudioVideoReviewDecision | Promise<StudioVideoReviewDecision>;
  comparison?: StudioVideoReviewComparison;
  aiName?: string;
  timestamp?: () => string;
  log?: (message: string) => void;
}

export interface ResumeStudioVideoReviewOptions {
  review: RenderStudioReviewVideoOptions["review"];
  aiName?: string;
  timestamp?: () => string;
}

export class StudioVideoReviewError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StudioVideoReviewError";
  }
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function projectDigest(project: StudioProject): string {
  return digest(JSON.stringify(project));
}

function checkpointDigest(checkpoint: Omit<StudioVideoReviewClarificationCheckpoint, "checkpointDigest">): string {
  return digest(JSON.stringify(checkpoint));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function artifactPath(projectDir: string, absolutePath: string): string {
  const local = relative(projectDir, absolutePath).replaceAll("\\", "/");
  return local.startsWith(".") ? local : `./${local}`;
}

function findingBody(finding: StudioVideoReviewFinding): string {
  return [
    `[${finding.dimension}] ${finding.evidence.summary}`,
    `Evidence: ${finding.evidence.observations?.join(" ") ?? finding.evidence.summary}`,
    `Inference: ${finding.inference}`,
    `Severity: ${finding.severity}`,
    `Recommended change: ${finding.recommendedChange}`,
  ].join("\n\n");
}

function applyReport(
  source: StudioProject,
  media: StudioReviewMedia,
  report: StudioVideoReviewReport,
  projectDir: string,
  aiName: string,
  timestamp: () => string,
): StudioProject {
  const now = timestamp();
  const signature = digest(JSON.stringify({ parent: source.review.headRevisionId, media: media.sha256, report }));
  const revisionId = `revision-ai-video-${signature.slice(0, 16)}`;
  if (source.review.revisions.some((revision) => revision.id === revisionId)) {
    throw new StudioVideoReviewError("this exact AI video review is already present in the revision queue");
  }
  const videoArtifactId = `artifact-review-video-${signature.slice(0, 16)}`;
  const reportArtifactId = `artifact-review-report-${signature.slice(0, 16)}`;
  const reportPath = `${media.path}.review.json`;
  const persistedReport = {
    version: 1,
    reviewedArtifactId: videoArtifactId,
    sourceRevisionId: media.sourceRevisionId,
    rubric: STUDIO_VIDEO_REVIEW_DIMENSIONS,
    ...report,
  };
  const persistedText = `${JSON.stringify(persistedReport, null, 2)}\n`;

  let project = clone(source);
  project.artifacts.push({
    id: videoArtifactId,
    kind: "review-video",
    path: artifactPath(projectDir, media.path),
    generatedAt: now,
    generator: { name: "domotion-svg-to-video" },
    sourceRevisionId: media.sourceRevisionId,
    sceneIds: project.scenes.map((scene) => scene.id),
    sha256: media.sha256,
    metadata: { width: media.width, height: media.height, mimeType: media.mimeType },
  }, {
    id: reportArtifactId,
    kind: "other",
    path: artifactPath(projectDir, reportPath),
    generatedAt: now,
    generator: { name: "domotion-studio-ai-review" },
    sourceRevisionId: media.sourceRevisionId,
    derivedFromArtifactIds: [videoArtifactId],
    sha256: digest(persistedText),
    metadata: { mediaType: "application/json", rubric: [...STUDIO_VIDEO_REVIEW_DIMENSIONS] },
  });
  project.review.revisions.push({
    id: revisionId,
    parentId: project.review.headRevisionId,
    createdAt: now,
    author: { kind: "ai", name: aiName },
    kind: "review",
    summary: report.summary,
    metadata: {
      automation: {
        phase: "video-review",
        reviewedArtifactId: videoArtifactId,
        reportArtifactId,
        rubric: [...STUDIO_VIDEO_REVIEW_DIMENSIONS],
        comparison: report.comparison ?? null,
      },
    },
  });
  project.review.headRevisionId = revisionId;
  for (const finding of report.findings) {
    project = applyStudioAnnotationCommand(project, {
      kind: "create",
      body: findingBody(finding),
      author: { kind: "ai", name: aiName },
      ...(finding.target != null ? { target: finding.target } : {}),
      evidenceArtifactIds: [videoArtifactId, reportArtifactId],
      origin: {
        kind: "studio",
        data: { producer: "ai-video-review", findingId: finding.id, dimension: finding.dimension },
      },
    }, {
      now,
      annotationId: `annotation-ai-${signature.slice(0, 10)}-${digest(finding.id).slice(0, 12)}`,
      attachToHeadRevision: true,
    }).project;
  }
  project.updatedAt = now;
  const validated = validateStudioProject(project);
  writeFileSync(reportPath, persistedText, "utf8");
  return validated;
}

function validateComparison(comparison: StudioVideoReviewComparison | undefined): StudioVideoReviewComparison | undefined {
  if (comparison == null) return undefined;
  const checked = clone(comparison);
  checked.project = validateStudioProject(checked.project);
  if (!existsSync(checked.media.path) || digest(readFileSync(checked.media.path)) !== checked.media.sha256) {
    throw new StudioVideoReviewError("comparison video is missing or does not match its SHA-256 evidence");
  }
  if (!checked.project.review.revisions.some((revision) => revision.id === checked.media.sourceRevisionId)) {
    throw new StudioVideoReviewError("comparison media references an unknown source revision");
  }
  return checked;
}

async function decide(
  project: StudioProject,
  media: StudioReviewMedia,
  review: RenderStudioReviewVideoOptions["review"],
  comparison?: StudioVideoReviewComparison,
  clarification?: { question: string; answer: string },
): Promise<StudioVideoReviewDecision> {
  const raw = await review(clone({
    project,
    media,
    rubric: [...STUDIO_VIDEO_REVIEW_DIMENSIONS],
    ...(comparison != null ? { comparison } : {}),
    ...(clarification != null ? { clarification } : {}),
  }));
  const parsed = decisionSchema.safeParse(raw);
  if (!parsed.success) throw new StudioVideoReviewError(`AI video review returned an invalid decision: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  return parsed.data;
}

/** Render the current SVG through the production video pipeline, then require structured AI review. */
export async function renderAndReviewStudioVideo(
  raw: unknown,
  options: RenderStudioReviewVideoOptions,
): Promise<StudioVideoReviewResult> {
  const project = validateStudioProject(raw);
  const comparison = validateComparison(options.comparison);
  const projectDir = resolve(options.projectDir ?? process.cwd());
  const svgPath = resolve(projectDir, options.svgPath);
  const outputPath = resolve(projectDir, options.outputPath ?? project.exportTargets?.reviewVideoPath ?? "generated/studio-review.mp4");
  mkdirSync(dirname(outputPath), { recursive: true });
  if (options.renderVideo != null) {
    await options.renderVideo({ svgPath, outputPath, project: clone(project) });
  } else {
    await runSvgToVideo({
      input: svgPath,
      output: outputPath,
      width: project.canvas.width,
      height: project.canvas.height,
      fps: options.fps ?? 30,
      format: "h264",
      scale: options.scale ?? 2,
      background: project.canvas.background ?? "#ffffff",
      burnCaptions: false,
      ffmpegPath: options.ffmpegPath ?? "ffmpeg",
      quiet: true,
      log: options.log ?? (() => {}),
      launchBrowser: options.launchBrowser ?? (() => launchChromium()),
    });
  }
  if (!existsSync(outputPath)) throw new StudioVideoReviewError(`video renderer did not create ${outputPath}`);
  const media: StudioReviewMedia = {
    path: outputPath,
    sha256: digest(readFileSync(outputPath)),
    sourceRevisionId: project.review.headRevisionId,
    width: project.canvas.width,
    height: project.canvas.height,
    mimeType: "video/mp4",
  };
  const decision = await decide(project, media, options.review, comparison);
  if (decision.kind === "clarify") {
    const checkpointBase: Omit<StudioVideoReviewClarificationCheckpoint, "checkpointDigest"> = {
      version: 1,
      projectDir,
      project,
      projectDigest: projectDigest(project),
      media,
      ...(comparison != null ? { comparison } : {}),
      question: decision.question,
      reason: decision.reason,
      evidence: decision.evidence,
    };
    return {
      status: "clarification",
      project,
      checkpoint: {
        ...checkpointBase,
        checkpointDigest: checkpointDigest(checkpointBase),
      },
    };
  }
  return {
    status: "reviewed",
    project: applyReport(project, media, decision, projectDir, options.aiName ?? "Studio AI", options.timestamp ?? (() => new Date().toISOString())),
    report: decision,
    media,
  };
}

/** Resume an AI-requested clarification without rerendering or accepting tampered evidence. */
export async function resumeStudioVideoReview(
  checkpoint: StudioVideoReviewClarificationCheckpoint,
  answer: string,
  options: ResumeStudioVideoReviewOptions,
): Promise<StudioVideoReviewResult> {
  if (answer.trim() === "") throw new StudioVideoReviewError("clarification answer must not be empty");
  const project = validateStudioProject(checkpoint.project);
  const { checkpointDigest: recordedDigest, ...checkpointBase } = checkpoint;
  if (checkpoint.version !== 1 || projectDigest(project) !== checkpoint.projectDigest || checkpointDigest(checkpointBase) !== recordedDigest) {
    throw new StudioVideoReviewError("video-review clarification checkpoint was modified");
  }
  if (!existsSync(checkpoint.media.path) || digest(readFileSync(checkpoint.media.path)) !== checkpoint.media.sha256) {
    throw new StudioVideoReviewError("review video changed after the clarification checkpoint was created");
  }
  const decision = await decide(project, checkpoint.media, options.review, checkpoint.comparison, {
    question: checkpoint.question,
    answer,
  });
  if (decision.kind === "clarify") {
    const nextBase: Omit<StudioVideoReviewClarificationCheckpoint, "checkpointDigest"> = {
      ...checkpointBase,
      question: decision.question,
      reason: decision.reason,
      evidence: decision.evidence,
    };
    return {
      status: "clarification",
      project,
      checkpoint: {
        ...nextBase,
        checkpointDigest: checkpointDigest(nextBase),
      },
    };
  }
  return {
    status: "reviewed",
    project: applyReport(project, checkpoint.media, decision, resolve(checkpoint.projectDir), options.aiName ?? "Studio AI", options.timestamp ?? (() => new Date().toISOString())),
    report: decision,
    media: checkpoint.media,
  };
}

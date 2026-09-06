---
id: "requirements/studio-ai-video-review"
title: "Domotion Studio structured AI video review"
kind: "contract"
status: "current"
owners: ["studio","review","images-media"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2694"]
code: ["src/studio/video-review.ts","src/studio/video-review.test.ts","src/studio/video-review.e2e.test.ts","src/studio/project-schema.ts"]
aliases: ["docs/246-studio-ai-video-review.md","doc-246"]
---

# Domotion Studio structured AI video review

Status: **Shipped.** Studio renders the current animation through the existing
frame-accurate SVG-to-video pipeline, gives that exact MP4 and its SHA-256 to an
application-owned AI reviewer, and inserts the resulting findings into the same
revision and annotation queue as human comments.

## Review contract

`renderAndReviewStudioVideo(project, options)` requires a `review` callback. The
callback receives a structured clone of the authored project, rendered-media
path and digest, optional prior-revision comparison, and the complete
authoritative rubric:

- pacing;
- cursor realism;
- readability;
- transitions;
- narrative clarity;
- brand presentation; and
- overall polish.

A report is rejected unless it covers every dimension. Each finding keeps
observed evidence separate from inference, severity, and recommended change.
It may target a scene, time range, region, semantic track/action, composition
layer, and DOM identity. Studio preserves those targets on ordinary open review
annotations and links each annotation to both the reviewed video and the
persisted JSON report.

Revision comparison is extra context, not a substitute rubric: compared reports
must still cover every general quality dimension. Existing human annotations
are retained and the AI report appends one parent-linked AI revision.

## Clarification and integrity

The AI may return `clarify` when intended emphasis or another material decision
is ambiguous. Studio returns the unchanged project plus a checkpoint containing
the question, evidence, project digest, video digest, and comparison context.
`resumeStudioVideoReview` rejects modified projects or media and routes the
answer back to the reviewer without rerendering.

The report sidecar records the reviewed artifact ID, source revision, rubric,
and structured findings. Video and report artifacts carry source-revision and
SHA-256 provenance. There are no token, time, iteration, cost, or other budget
controls in this phase.

The video renderer remains the production `runSvgToVideo` implementation
described by [the SVG-to-video contract](47-svg-to-video.md): Chromium owns
frame rendering and ffmpeg owns encoding. Studio does not infer visual quality
from the authored SVG alone.

## Verification

Deterministic tests cover all seven rubric dimensions and the complete grounding
shape (scene, time range, region, track, action, layer, and DOM identity), shared
human/AI queue behavior, structured report persistence, comparison context,
missing-dimension rejection, clarification resume, and tamper rejection. The
real Chromium/ffmpeg test proves that the AI boundary runs only after a genuine
MP4 has been rendered through the production pipeline.

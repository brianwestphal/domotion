import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { parseStudioProjectJson } from "../src/studio/project.js";
import {
  glassboxBenchmarkHealDecision,
  glassboxBenchmarkReviewDecision,
} from "../benchmarks/glassbox/run.js";

const PROJECT_PATH = resolve("benchmarks/glassbox/glassbox.project.json");

function project() {
  return parseStudioProjectJson(readFileSync(PROJECT_PATH, "utf8"), PROJECT_PATH);
}

describe("Glassbox Studio acceptance benchmark", () => {
  it("keeps the AI-authored story, real workflow, brand treatments, hooks, and outputs in durable project JSON", () => {
    const value = project();
    expect(value.review.revisions[0].author.kind).toBe("ai");
    expect(value.narrative.beats.map((beat) => beat.id)).toEqual([
      "beat-promise", "beat-launch", "beat-review", "beat-handoff",
    ]);
    expect(value.scenes.map((scene) => scene.id)).toEqual([
      "scene-promise", "scene-launch", "scene-live-review", "scene-handoff", "scene-end",
    ]);
    const live = value.scenes.find((scene) => scene.id === "scene-live-review")!;
    expect(live.render.kind).toBe("storyboard");
    expect(live.tracks?.flatMap((track) => track.events.map((event) => event.id))).toEqual(expect.arrayContaining([
      "event-risk", "event-type-note", "event-complete", "event-apply-fix",
    ]));
    expect(live.scriptHooks).toEqual([{ hookId: "prepare-glassbox", phase: "beforeCapture" }]);
    expect(value.scriptHooks?.map((hook) => hook.id)).toEqual([
      "prepare-glassbox", "wait-for-analysis", "apply-reviewed-fix",
    ]);
    expect(value.scenes.flatMap((scene) => scene.treatments ?? []).map((item) => item.kind)).toEqual(expect.arrayContaining([
      "title-card", "logo-reveal", "terminal-chrome", "browser-chrome", "scene-transition",
    ]));
    expect(value.exportTargets).toEqual({
      svgPath: "../../../glassbox/assets/demo.svg",
      reviewVideoPath: "generated/glassbox-review.mp4",
    });
    expect(value.metadata?.aiPolicy).toEqual({ healing: "required", review: "required" });
  });

  it("heals the controlled accessible-name change from live DOM and computed-style evidence", () => {
    const value = project();
    const decision = glassboxBenchmarkHealDecision({
      project: value,
      failure: {
        name: "StudioInteractiveSceneError",
        message: "role=button name=Sort files by AI risk score matched no element",
        sceneId: "scene-live-review",
        eventId: "event-risk",
        completedEventIds: [],
        completedEvidence: [],
        causes: [],
        inspection: {
          url: "http://127.0.0.1:4188",
          title: "Glassbox",
          ariaSnapshot: "- button \"Risk review\"",
          viewport: { width: 1280, height: 800 },
          truncated: false,
          candidates: [{
            selector: "body > main > button:nth-of-type(2)",
            tag: "button",
            ariaLabelAttribute: "Risk review",
            text: "Risk review",
            rect: { x: 10, y: 10, width: 90, height: 32 },
            styles: { display: "block", visibility: "visible", opacity: "1", cursor: "pointer", pointerEvents: "auto", position: "static" },
          }],
        },
      },
    });
    expect(decision.kind).toBe("edit");
    if (decision.kind !== "edit") return;
    const live = decision.project as ReturnType<typeof project>;
    const event = live.scenes.find((scene) => scene.id === "scene-live-review")!.tracks![0].events[0];
    expect(event).toMatchObject({ id: "event-risk", target: { role: "button", name: "Risk review" } });
    expect(decision.evidence.data).toMatchObject({ name: "Risk review", styles: { cursor: "pointer" } });
  });

  it("revises persistent brand framing once, then accepts only a capture containing every causal beat", () => {
    const value = project();
    const evidence = value.scenes.find((scene) => scene.id === "scene-live-review")!.tracks![0].events.map((event) => ({
      version: 1 as const,
      eventId: event.id,
      path: `$.events.${event.id}`,
      targetRef: "target",
      settleReason: "settled" as const,
      durationMs: 10,
      truncated: false,
      meaningful: true,
      summary: { addedNodes: 0, removedNodes: 0, attributes: 0, characterData: 0, directChanges: 1, actionEffects: 0, incidentalChanges: 0 },
      changes: [], mutations: [], signals: [],
      hoverDiff: { changed: false, entries: [] },
      suggestedSynthesis: "cut" as const,
    }));
    const candidate = { svg: "<svg/>", project: value, segments: [{
      sceneId: "scene-live-review", artifactId: "artifact-live", evidenceArtifactId: "artifact-evidence",
      path: "live.svg", evidencePath: "evidence.json", durationMs: 16600,
      sha256: "a".repeat(64), evidenceSha256: "b".repeat(64), evidence,
      cursor: { overlay: { events: [] }, interactions: [], timeOffsetMs: 0, durationMs: 0 },
    }] };
    const first = glassboxBenchmarkReviewDecision({ project: value, candidate });
    expect(first.kind).toBe("edit");
    if (first.kind !== "edit") return;
    const revised = first.project as ReturnType<typeof project>;
    revised.review.revisions.push({
      id: "revision-review-framing", parentId: revised.review.headRevisionId,
      createdAt: "2026-09-06T00:00:01.000Z", author: { kind: "ai" }, kind: "content",
      summary: "Clarified the live browser frame.", metadata: { automation: { phase: "review" } },
    });
    revised.review.headRevisionId = "revision-review-framing";
    const second = glassboxBenchmarkReviewDecision({ project: revised, candidate: { ...candidate, project: revised } });
    expect(second).toMatchObject({ kind: "accept", evidence: { data: { eventCount: evidence.length } } });
  });
});

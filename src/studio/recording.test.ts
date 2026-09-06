import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createStudioProjectDocument } from "./app-projects.js";
import { compileStudioSemanticTracks } from "./interactions.js";
import {
  importStudioInteractionRecording,
  persistStudioRecordingEvidence,
  STUDIO_INTERACTION_RECORDING_FORMAT,
  STUDIO_INTERACTION_RECORDING_VERSION,
  STUDIO_REDACTED_VALUE,
  StudioRecordingError,
  studioInteractionRecordingSchema,
  type StudioInteractionRecording,
} from "./recording.js";

const NOW = "2026-09-06T05:00:00.000Z";

function recording(): StudioInteractionRecording {
  return studioInteractionRecordingSchema.parse({
    format: STUDIO_INTERACTION_RECORDING_FORMAT,
    version: STUDIO_INTERACTION_RECORDING_VERSION,
    id: "recording-checkout",
    startedAt: NOW,
    durationMs: 420,
    viewport: { width: 900, height: 600 },
    sourceUrls: ["https://example.test/checkout?token=%5BREDACTED%5D"],
    redactions: 1,
    events: [
      {
        sequence: 0,
        atMs: 100,
        url: "https://example.test/checkout",
        kind: "input",
        value: STUDIO_REDACTED_VALUE,
        inputType: "insertText",
        redacted: true,
        target: {
          tag: "input",
          selector: "#password",
          semantic: { label: "Password", domId: "password" },
          text: STUDIO_REDACTED_VALUE,
          rect: { x: 20, y: 30, width: 180, height: 32 },
          styles: { display: "inline-block", color: "rgb(0, 0, 0)" },
          state: { disabled: false },
          sensitive: true,
        },
      },
      {
        sequence: 1,
        atMs: 300,
        url: "https://example.test/checkout",
        kind: "pointer",
        phase: "click",
        point: { x: 120, y: 160 },
        button: 0,
        buttons: 0,
        target: {
          tag: "button",
          selector: "[data-testid=\"create-action\"]",
          semantic: { role: "button", name: "Add item", testId: "create-action" },
          text: "Add item",
          rect: { x: 60, y: 140, width: 120, height: 40 },
          styles: { display: "inline-block", backgroundColor: "rgb(12, 80, 190)" },
          state: { disabled: false },
          sensitive: false,
        },
      },
      {
        sequence: 2,
        atMs: 420,
        url: "https://example.test/checkout",
        kind: "dom-feedback",
        mutationCount: 1,
        mutations: [{ kind: "childList", targetSelector: "#items", addedNodes: 1, removedNodes: 0 }],
        snapshots: [],
      },
    ],
  });
}

function importedScene() {
  return {
    id: "scene-recorded-checkout",
    title: "Recorded checkout",
    description: "A simplified semantic replay inferred from redacted browser evidence.",
    narrativeBeatIds: ["beat-opening"],
    render: { kind: "storyboard" as const, recipe: { capture: { file: "demo.html" }, duration: 1600 } },
    tracks: [{
      id: "track-recorded-checkout",
      kind: "semantic-interactions" as const,
      events: [
        { id: "event-password", kind: "type" as const, atMs: 100, durationMs: 250, target: { label: "Password" }, text: STUDIO_REDACTED_VALUE },
        { id: "event-add", kind: "click" as const, atMs: 650, target: { testId: "create-action" } },
      ],
    }],
  };
}

describe("Studio real-interaction recording import (DM-2696)", () => {
  it("rejects sensitive values before they can become recording evidence", () => {
    const raw = structuredClone(recording());
    const input = raw.events[0];
    if (input.kind !== "input") throw new Error("fixture drift");
    input.value = "hunter2";
    expect(() => studioInteractionRecordingSchema.parse(raw)).toThrow(/sensitive input must be redacted/);
  });

  it("pauses on an AI healing clarification without calling review or changing the project", async () => {
    const project = createStudioProjectDocument({ title: "Import test", createdAt: NOW });
    const review = vi.fn();
    const result = await importStudioInteractionRecording(project, recording(), {
      ai: {
        heal: async ({ aiPolicy, recording: raw }) => {
          expect(aiPolicy).toEqual({ healing: "required", review: "required" });
          expect(JSON.stringify(raw)).not.toContain("hunter2");
          return { kind: "clarify", question: "Should the redacted field be replayed?", reason: "The value was intentionally removed.", evidence: { summary: "One sensitive input is ambiguous." } };
        },
        review,
      },
    });
    expect(result).toMatchObject({ status: "clarification", phase: "healing", project });
    expect(review).not.toHaveBeenCalled();
  });

  it("requires AI healing and review, emits a normal validated scene, and persists only redacted evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "domotion-recording-unit-"));
    try {
      const project = createStudioProjectDocument({ title: "Import test", createdAt: NOW });
      const heal = vi.fn(async () => ({ kind: "candidate" as const, scene: importedScene(), summary: "Collapsed raw keystrokes and pointer noise into two semantic actions.", evidence: { summary: "Used accessible labels and a stable test id." } }));
      const review = vi.fn(async ({ candidate }) => ({ kind: "accept" as const, summary: `Reviewed ${candidate.tracks?.[0].events.length} semantic actions.`, evidence: { summary: "Targets and pacing are unambiguous." } }));
      const result = await importStudioInteractionRecording(project, recording(), {
        ai: { heal, review },
        now: "2026-09-06T05:05:00.000Z",
        generatorVersion: "test",
      });
      expect(result.status).toBe("imported");
      if (result.status !== "imported") return;
      expect(heal).toHaveBeenCalledOnce();
      expect(review).toHaveBeenCalledOnce();
      expect(result.project.scenes.at(-1)).toEqual(result.scene);
      expect(compileStudioSemanticTracks(result.scene.tracks ?? []).steps).toHaveLength(2);
      expect(result.project.review.revisions.at(-1)).toMatchObject({ author: { kind: "ai" }, kind: "content", metadata: { operation: "studio.recording.import" } });
      expect(result.project.artifacts.at(-1)).toMatchObject({ kind: "capture-evidence", sceneIds: [result.scene.id], sourceRevisionId: result.project.review.headRevisionId, metadata: { redactions: 1 } });
      expect(result.project.narrative.beats[0].sceneIds).toContain(result.scene.id);

      const evidencePath = persistStudioRecordingEvidence(root, result);
      const persisted = readFileSync(evidencePath, "utf8");
      expect(persisted).toBe(result.evidenceText);
      expect(persisted).not.toContain("hunter2");
      expect(persisted).toContain(STUDIO_REDACTED_VALUE);
      expect(persistStudioRecordingEvidence(root, result)).toBe(evidencePath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects AI output that is replay-only or reuses an existing scene identity", async () => {
    const project = createStudioProjectDocument({ title: "Import test", createdAt: NOW });
    const duplicate = { ...importedScene(), id: "scene-opening" };
    await expect(importStudioInteractionRecording(project, recording(), {
      ai: {
        heal: async () => ({ kind: "candidate", scene: duplicate, summary: "Candidate", evidence: { summary: "Evidence" } }),
        review: async () => ({ kind: "accept", summary: "Accepted", evidence: { summary: "Evidence" } }),
      },
    })).rejects.toBeInstanceOf(StudioRecordingError);
  });
});

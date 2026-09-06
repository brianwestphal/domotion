import { chromium, type Browser } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { resumeStudioHealingLoop, runStudioHealingLoop, type StudioAiHealingDecision } from "./healing.js";
import { loadStudioProject } from "./project.js";

const fixturePath = resolve("tests/fixtures/studio/healing-story.project.json");
const fixtureDir = resolve("tests/fixtures/studio");
const revisionTimestamp = () => "2026-09-06T06:30:00.000Z";

describe("Studio AI replay healing (DM-2695)", () => {
  let browser: Browser | null = null;

  afterAll(async () => browser?.close(), 15_000);

  it("uses live Chromium evidence to heal a renamed and moved control, wait for delayed state, review, and recapture", async () => {
    try {
      browser = await chromium.launch({ headless: true });
    } catch {
      return;
    }
    const artifactDir = mkdtempSync(join(tmpdir(), "domotion-healing-e2e-"));
    try {
      const authored = loadStudioProject(fixturePath);
      const heal = vi.fn(async ({ project, failure }: Parameters<Parameters<typeof runStudioHealingLoop>[2]["heal"]>[0]): Promise<StudioAiHealingDecision> => {
        if (failure.eventId === "event-name") {
          expect(failure.message).toContain("Project");
          expect(failure.inspection?.ariaSnapshot).toContain('textbox "Workspace"');
          expect(failure.inspection?.candidates.some((item) => item.labelText === "Workspace")).toBe(true);
          const edited = structuredClone(project);
          const event = edited.scenes[0].tracks![0].events[0];
          if (event.kind !== "type") throw new Error("fixture event must be typing");
          event.target = { label: "Workspace" };
          return {
            kind: "edit" as const,
            project: edited,
            summary: "Repaired the changed field label.",
            evidence: { summary: "Chromium exposes Workspace as the input's current accessible name." },
          };
        }
        if (failure.eventId === "event-ready") {
          expect(failure.completedEventIds).toEqual(["event-name", "event-launch"]);
          expect(failure.completedEvidence).toHaveLength(2);
          expect(failure.failedEvidence?.eventId).toBe("event-ready");
          expect(failure.inspection?.ariaSnapshot).toContain("Loading");
          const edited = structuredClone(project);
          const wait = edited.scenes[0].tracks![0].events[2];
          if (wait.kind !== "waitForState") throw new Error("fixture event must be a state wait");
          wait.timeoutMs = 3000;
          return {
            kind: "edit" as const,
            project: edited,
            summary: "Extend the wait for the application's delayed ready state.",
            evidence: { summary: "The current application remains Loading after the old 100 ms limit.", data: { completedEventIds: [...failure.completedEventIds] } },
          };
        }
        expect(failure.eventId).toBe("event-launch");
        expect(failure.message).toContain("Launch tour");
        expect(failure.inspection?.ariaSnapshot).toContain('button "Start tour"');
        const currentControl = failure.inspection?.candidates.find((item) => item.text === "Start tour");
        expect(currentControl?.rect.x).toBeGreaterThan(200);
        expect(currentControl?.styles.display).toBe("block");
        const edited = structuredClone(project);
        const event = edited.scenes[0].tracks![0].events[1];
        if (event.kind !== "click") throw new Error("fixture event must be a click");
        event.target = { role: "button", name: "Start tour" };
        return {
          kind: "edit" as const,
          project: edited,
          summary: "Repaired the renamed launch control.",
          evidence: { summary: "Chromium exposes Start tour at the control's new location.", data: { ariaSnapshot: failure.inspection?.ariaSnapshot ?? "", rect: currentControl?.rect ?? null } },
        };
      });
      const review = vi.fn(async () => ({ kind: "accept" as const, summary: "Ready for a person.", evidence: { summary: "The repaired flow reaches Ready and the SVG is self-contained." } }));
      const result = await runStudioHealingLoop(browser, authored, {
        projectDir: fixtureDir,
        artifactDir,
        generatedAt: revisionTimestamp,
        revisionTimestamp,
        heal,
        review,
      });

      expect(result.status).toBe("human-review");
      if (result.status !== "human-review") return;
      expect(heal).toHaveBeenCalledTimes(3);
      expect(review).toHaveBeenCalledTimes(1);
      expect(result.candidate.svg).toContain("Flow complete");
      expect(result.project.review.revisions).toHaveLength(4);
      expect(result.project.review.revisions[2]).toMatchObject({
        author: { kind: "ai", name: "Studio AI" },
        metadata: { automation: { phase: "heal", changes: [{ path: "$.scenes[0].tracks[0].events[1].target.name", before: "Launch tour", after: "Start tour" }] } },
      });
      expect(result.project.review.revisions[3].metadata).toMatchObject({
        automation: {
          phase: "heal",
          evidence: { data: { completedEventIds: ["event-name", "event-launch"] } },
          trigger: { failure: { eventId: "event-ready", completedEventIds: ["event-name", "event-launch"] } },
        },
      });
      expect(result.project.artifacts.every((artifact) => artifact.sourceRevisionId === result.project.review.headRevisionId)).toBe(true);
      expect(readFileSync(result.candidate.segments[0].path, "utf8")).toContain("Flow complete");
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("pauses an ambiguous repair for clarification, resumes unchanged, and represents unrecoverable intent", async () => {
    if (browser == null) return;
    const artifactDir = mkdtempSync(join(tmpdir(), "domotion-healing-clarify-e2e-"));
    try {
      const ambiguous = loadStudioProject(fixturePath);
      const event = ambiguous.scenes[0].tracks![0].events[0];
      if (event.kind !== "type") throw new Error("fixture event must be typing");
      event.target = { label: "Workspace" };
      const launch = ambiguous.scenes[0].tracks![0].events[1];
      if (launch.kind !== "click") throw new Error("fixture event must be a click");
      launch.target = { role: "button" };
      ambiguous.scenes[0].tracks![0].events.splice(2, 2);
      const first = await runStudioHealingLoop(browser, ambiguous, {
        projectDir: fixtureDir,
        artifactDir,
        heal: async ({ failure }) => {
          expect(failure.message).toContain("ambiguous (2 matches)");
          return { kind: "clarify", question: "Which Start action expresses the story intent?", reason: "Two exact button candidates remain.", evidence: { summary: "Chromium exposes Start tour and Start settings." } };
        },
        review: async () => { throw new Error("review should wait for a successful replay"); },
      });
      expect(first.status).toBe("clarification");
      if (first.status !== "clarification") return;
      expect(first.project).toEqual(ambiguous);
      expect(first.project.review.revisions).toHaveLength(1);

      const resumed = await resumeStudioHealingLoop(browser, first.checkpoint, "Start tour", {
        projectDir: fixtureDir,
        artifactDir,
        revisionTimestamp,
        heal: async ({ project, clarification }) => {
          expect(clarification?.answer).toBe("Start tour");
          const edited = structuredClone(project);
          const repair = edited.scenes[0].tracks![0].events[1];
          if (repair.kind !== "click") throw new Error("fixture event must be a click");
          repair.target = { role: "button", name: clarification!.answer };
          return { kind: "edit", project: edited, summary: "Applied the clarified control.", evidence: { summary: "Human selected Start tour." } };
        },
        review: async () => ({ kind: "accept", summary: "Ready.", evidence: { summary: "Replay passed after clarification." } }),
      });
      expect(resumed.status).toBe("human-review");
      if (resumed.status === "human-review") {
        expect(resumed.project.review.revisions.at(-1)?.metadata).toMatchObject({
          automation: { trigger: { clarification: { phase: "heal", answer: "Start tour" } } },
        });
      }

      const missing = loadStudioProject(fixturePath);
      const missingEvent = missing.scenes[0].tracks![0].events[0];
      if (missingEvent.kind !== "type") throw new Error("fixture event must be typing");
      missingEvent.target = { label: "Delete universe" };
      const unrecoverable = await runStudioHealingLoop(browser, missing, {
        projectDir: fixtureDir,
        artifactDir,
        heal: async () => ({ kind: "unrecoverable", reason: "The authored intent has no safe equivalent.", evidence: { summary: "No destructive action exists in the current application." } }),
        review: async () => { throw new Error("review should not run"); },
      });
      expect(unrecoverable).toMatchObject({ status: "unrecoverable", phase: "heal", reason: "The authored intent has no safe equivalent." });
      expect(unrecoverable.project).toEqual(missing);
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  }, 120_000);
});

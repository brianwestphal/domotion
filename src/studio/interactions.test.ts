import type { Locator, Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { compileStudioSemanticTracks, runStudioSemanticStep, StudioInteractionError, type StudioSemanticStep } from "./interactions.js";

const click = (id: string, atMs: number) => ({
  id,
  atMs,
  kind: "click" as const,
  target: { role: "button", name: id },
});

describe("Studio semantic interaction compilation (DM-2683)", () => {
  it("validates tracks and stably merges scene-relative events", () => {
    const plan = compileStudioSemanticTracks([
      { id: "primary", kind: "semantic-interactions", events: [click("first", 10), click("tie-a", 30)] },
      { id: "secondary", kind: "semantic-interactions", events: [click("tie-b", 30), { ...click("last", 50), durationMs: 25 }] },
    ]);

    expect(plan.steps.map((step) => [step.trackId, step.event.id])).toEqual([
      ["primary", "first"],
      ["primary", "tie-a"],
      ["secondary", "tie-b"],
      ["secondary", "last"],
    ]);
    expect(plan.durationMs).toBe(75);
  });

  it.each([
    {
      name: "duplicate event identity",
      tracks: [
        { id: "a", kind: "semantic-interactions", events: [click("same", 0)] },
        { id: "b", kind: "semantic-interactions", events: [click("same", 0)] },
      ],
      message: '$.scenes[2].tracks[1].events[0].id (same): duplicate event id "same"',
    },
    {
      name: "duplicate track identity",
      tracks: [
        { id: "same", kind: "semantic-interactions", events: [] },
        { id: "same", kind: "semantic-interactions", events: [] },
      ],
      message: '$.scenes[2].tracks[1].id: duplicate track id "same"',
    },
    {
      name: "out-of-order time",
      tracks: [{ id: "a", kind: "semantic-interactions", events: [click("late", 20), click("early", 10)] }],
      message: "$.scenes[2].tracks[0].events[1].atMs: must be greater than or equal to the previous event time (20ms)",
    },
    {
      name: "overlap",
      tracks: [{ id: "a", kind: "semantic-interactions", events: [{ ...click("long", 0), durationMs: 30 }, click("overlap", 20)] }],
      message: "$.scenes[2].tracks[0].events[1].atMs: overlaps the previous event, which ends at 30ms",
    },
    {
      name: "text wait without value",
      tracks: [{ id: "a", kind: "semantic-interactions", events: [{ id: "wait", atMs: 0, kind: "waitForState", target: { text: "Ready" }, state: "text" }] }],
      message: "$.scenes[2].tracks[0].events[0].value: a text wait requires `value`",
    },
  ])("reports the exact authored path for $name", ({ tracks, message }) => {
    expect(() => compileStudioSemanticTracks(tracks, { path: "$.scenes[2].tracks" })).toThrow(message);
  });

  it("exposes structured paths and event IDs on compiler failures", () => {
    try {
      compileStudioSemanticTracks([
        { id: "a", kind: "semantic-interactions", events: [click("same", 0)] },
        { id: "b", kind: "semantic-interactions", events: [click("same", 1)] },
      ]);
      throw new Error("expected compilation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(StudioInteractionError);
      expect(error).toMatchObject({ path: "$.tracks[1].events[0].id", eventId: "same" });
    }
  });

  it.each([
    { state: "attached" as const, initialCount: 0 },
    { state: "detached" as const, initialCount: 1 },
    { state: "detached" as const, initialCount: 0 },
  ])("lets a $state lifecycle wait start with $initialCount matches", async ({ state, initialCount }) => {
    const locator = {
      count: vi.fn(async () => initialCount),
      waitFor: vi.fn(async () => {}),
    } as unknown as Locator;
    const page = { locator: vi.fn(() => locator) } as unknown as Page;
    const step: StudioSemanticStep = {
      path: "$.scenes[0].tracks[0].events[0]",
      trackId: "lifecycle",
      event: { id: state, atMs: 0, kind: "waitForState", target: { domId: "target" }, state, timeoutMs: 250 },
    };

    await runStudioSemanticStep(page, step);

    expect(locator.waitFor).toHaveBeenCalledWith({ state, timeout: 250 });
  });

  it("rejects an ambiguous lifecycle target at its authored target path", async () => {
    const locator = { count: vi.fn(async () => 2) } as unknown as Locator;
    const page = { locator: vi.fn(() => locator) } as unknown as Page;
    const step: StudioSemanticStep = {
      path: "$.scenes[4].tracks[1].events[2]",
      trackId: "lifecycle",
      event: { id: "ambiguous-attach", atMs: 0, kind: "waitForState", target: { selector: ".duplicate" }, state: "attached" },
    };

    await expect(runStudioSemanticStep(page, step)).rejects.toMatchObject({
      path: "$.scenes[4].tracks[1].events[2].target",
      eventId: "ambiguous-attach",
      message: expect.stringContaining("ambiguous (2 matches)"),
    });
  });
});

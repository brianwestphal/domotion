import { describe, expect, it } from "vitest";
import { planStudioCursorChoreography, type StudioCursorTargetEvidence } from "./cursor-choreography.js";

const viewport = { width: 800, height: 500 };
const evidence: StudioCursorTargetEvidence[] = [
  { eventId: "click", kind: "click", atMs: 0, path: "$.tracks[0].events[0]", box: { x: 620, y: 70, width: 120, height: 44 }, cursor: "pointer", viewport },
  { eventId: "hover", kind: "hover", atMs: 150, path: "$.tracks[0].events[1]", box: { x: 90, y: 220, width: 180, height: 60 }, cursor: "default", viewport },
  { eventId: "type", kind: "type", atMs: 300, path: "$.tracks[0].events[2]", box: { x: 350, y: 380, width: 220, height: 36 }, cursor: "text", viewport },
  { eventId: "scroll", kind: "scrollTo", atMs: 450, path: "$.tracks[0].events[3]", cursor: "default", viewport },
  { eventId: "drag", kind: "drag", atMs: 600, path: "$.tracks[0].events[4]", box: { x: 40, y: 40, width: 70, height: 50 }, destinationBox: { x: 680, y: 410, width: 90, height: 60 }, cursor: "grab", viewport },
];

describe("Studio natural cursor choreography (DM-2686)", () => {
  it("is seeded, deterministic, bounded, curved, and endpoint-exact", () => {
    const first = planStudioCursorChoreography(evidence, { seed: "tour-42" });
    const repeat = planStudioCursorChoreography(evidence, { seed: "tour-42" });
    const different = planStudioCursorChoreography(evidence, { seed: "tour-43" });
    expect(repeat).toEqual(first);
    expect(different.overlay.events).not.toEqual(first.overlay.events);

    const moves = first.overlay.events.filter((event) => event.type === "move");
    expect(moves.length).toBeGreaterThanOrEqual(evidence.length * 8);
    for (const move of moves) {
      expect(move.to!.x).toBeGreaterThanOrEqual(12);
      expect(move.to!.x).toBeLessThanOrEqual(788);
      expect(move.to!.y).toBeGreaterThanOrEqual(12);
      expect(move.to!.y).toBeLessThanOrEqual(488);
    }
    for (const interaction of first.interactions) {
      expect(moves.some((move) => move.to?.x === interaction.point.x && move.to?.y === interaction.point.y)).toBe(true);
    }
    const click = first.interactions[0];
    const clickMoves = moves.filter((move) => move.t + (move.duration ?? 0) <= click.presentedAtMs);
    const start = (first.overlay.events[0] as Extract<(typeof first.overlay.events)[number], { type: "show" }>);
    const straightSlope = (click.point.y - start.y) / (click.point.x - start.x);
    expect(clickMoves.slice(0, -1).some((move) => Math.abs((move.to!.y - start.y) - straightSlope * (move.to!.x - start.x)) > 1)).toBe(true);
    const segmentDistances = clickMoves.map((move, index) => index === 0
      ? Math.hypot(move.to!.x - start.x, move.to!.y - start.y)
      : Math.hypot(move.to!.x - clickMoves[index - 1].to!.x, move.to!.y - clickMoves[index - 1].to!.y));
    expect(segmentDistances[0]).toBeGreaterThan(segmentDistances.at(-1)!);
    expect(first.interactions.at(-1)!.destinationPoint).toBeDefined();
  });

  it("serializes dense authored actions and honors exact choreography overrides", () => {
    const result = planStudioCursorChoreography(evidence.slice(0, 2), {
      seed: 7,
      start: { x: 20, y: 30 },
      leadInMs: 100,
      overrides: {
        click: { point: { x: 700, y: 80 }, controlPoint: { x: 300, y: 40 }, durationMs: 300, dwellMs: 50, samples: 3 },
      },
    });
    expect(result.overlay.events[0]).toEqual({ type: "show", t: 0, x: 20, y: 30 });
    expect(result.interactions[0]).toMatchObject({ point: { x: 700, y: 80 }, presentedAtMs: 350 });
    expect(result.interactions[1].presentedAtMs).toBeGreaterThan(result.interactions[0].presentedAtMs);
    const firstMoves = result.overlay.events.filter((event) => event.type === "move" && event.t < 300);
    expect(firstMoves).toHaveLength(3);
  });

  it("returns an empty renderer-compatible overlay when no visual actions exist", () => {
    expect(planStudioCursorChoreography([], { leadInMs: 250 })).toEqual({
      overlay: { events: [] }, interactions: [], durationMs: 0, timeOffsetMs: 250,
    });
  });

  it("rejects unsafe numeric overrides instead of emitting invalid SVG timing", () => {
    expect(() => planStudioCursorChoreography(evidence, {
      overrides: { click: { point: { x: Number.NaN, y: 20 } } },
    })).toThrow('override "click" point must contain finite x/y coordinates');
    expect(() => planStudioCursorChoreography(evidence, {
      overrides: { click: { samples: 1 } },
    })).toThrow('override "click" samples must be an integer from 2 to 32');
  });
});

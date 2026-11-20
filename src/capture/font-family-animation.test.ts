import { describe, expect, it } from "vitest";
import {
  chooseFamilyKeyframe,
  keyframeSelectorOffsets,
  withSyntheticFamilyKeyframes,
  type FamilyKeyframe,
} from "./font-family-animation.js";
import { resolveAnimatedFamilyType, type PageFamilyAnimation } from "./font-family-animation-cdp.js";
import type { FamilyKeyframesRule, FamilyResolution } from "./font-family-cascade.js";

const kf = (offset: number, value: string | null, easing = "linear"): FamilyKeyframe => ({ offset, easing, value });

describe("discrete font-family keyframe choice (DM-ZAXD0C)", () => {
  it("flips at local fraction 0.5 inside the containing interval", () => {
    const frames = [kf(0, "Courier"), kf(1, "initial")];
    expect(chooseFamilyKeyframe(frames, 0.4)).toMatchObject({ kind: "value", value: "Courier" });
    expect(chooseFamilyKeyframe(frames, 0.6)).toMatchObject({ kind: "value", value: "initial" });
    // Exactly 0.5 is resolved by Blink (fraction < 0.5 ? start : end) but sits
    // inside the solver tolerance, so it is declined rather than guessed.
    expect(chooseFamilyKeyframe(frames, 0.5)).toMatchObject({ kind: "unknown" });
  });
  it("uses the interval's own local fraction, not the global progress", () => {
    const frames = withSyntheticFamilyKeyframes([kf(0.5, "initial")], "linear");
    expect(frames.map((f) => f.value)).toEqual([null, "initial", null]);
    expect(chooseFamilyKeyframe(frames, 0.3)).toMatchObject({ kind: "value", value: "initial" }); // local 0.6
    expect(chooseFamilyKeyframe(frames, 0.2)).toEqual({ kind: "neutral" }); // local 0.4
    expect(chooseFamilyKeyframe(frames, 0.8)).toEqual({ kind: "neutral" }); // local 0.6 toward the neutral end
  });
  it("applies the START keyframe's easing", () => {
    const steps = [kf(0, "Courier", "steps(1)"), kf(1, "initial")];
    expect(chooseFamilyKeyframe(steps, 0.6)).toMatchObject({ value: "Courier" });
    const easeIn = withSyntheticFamilyKeyframes([kf(0.5, "initial", "ease-in")], "ease-in");
    // local 0.2 → ease-in(0.2) ≈ 0.06 < 0.5 → start side (the authored keyframe)
    expect(chooseFamilyKeyframe(easeIn, 0.6)).toMatchObject({ value: "initial" });
    const late = [kf(0, "Courier", "cubic-bezier(0.9, 0, 1, 0)"), kf(1, "initial")];
    expect(chooseFamilyKeyframe(late, 0.6)).toMatchObject({ value: "Courier" });
    const start = [kf(0, "Courier", "steps(1, start)"), kf(1, "initial")];
    expect(chooseFamilyKeyframe(start, 0.2)).toMatchObject({ value: "initial" });
    const points = [kf(0, "Courier", "linear(0 0%, 1 20%, 1 100%)"), kf(1, "initial")];
    expect(chooseFamilyKeyframe(points, 0.15)).toMatchObject({ value: "initial" });
  });
  it("declines step boundaries whose result depends on the phase limit direction", () => {
    expect(chooseFamilyKeyframe([kf(0, "A", "steps(2)"), kf(1, "initial")], 0.5)).toMatchObject({ kind: "unknown" });
    expect(chooseFamilyKeyframe([kf(0, "A", "nonsense(1)"), kf(1, "initial")], 0.3)).toMatchObject({ kind: "unknown" });
  });
  it("transcribes the coincident-offset and open-ended records", () => {
    // Two keyframes at 0: the first record collapses to the first keyframe for
    // progress < 0, the second applies from 0 on.
    const frames = [kf(0, "A"), kf(0, "initial"), kf(1, "B")];
    expect(chooseFamilyKeyframe(frames, -0.1)).toMatchObject({ value: "A" });
    expect(chooseFamilyKeyframe(frames, 0.2)).toMatchObject({ value: "initial" });
    expect(chooseFamilyKeyframe(frames, 1.3)).toMatchObject({ value: "B" });
    const end = [kf(0, "A"), kf(1, "initial"), kf(1, "B")];
    expect(chooseFamilyKeyframe(end, 1)).toMatchObject({ value: "B" });
    expect(chooseFamilyKeyframe(end, 0.9)).toMatchObject({ value: "initial" });
  });
  it("drops interior keyframes sharing an offset with both neighbors", () => {
    const frames = withSyntheticFamilyKeyframes(
      [kf(0, "A"), kf(0.5, "B"), kf(0.5, "C"), kf(0.5, "D"), kf(1, "E")],
      "linear",
    );
    expect(frames.map((f) => f.value)).toEqual(["A", "B", "D", "E"]);
  });
  it("parses fixed keyframe selectors and refuses timeline ranges", () => {
    expect(keyframeSelectorOffsets("from, 50%, to")).toEqual([0, 0.5, 1]);
    expect(keyframeSelectorOffsets("33.3%")).toEqual([33.3 / 100]);
    expect(keyframeSelectorOffsets("entry 10%")).toBeNull();
  });
});

const rule = (...frames: Array<[string, string | null]>): FamilyKeyframesRule => ({
  animationName: { text: "k" },
  keyframes: frames.map(([keyText, value]) => ({
    keyText: { text: keyText },
    style: { cssProperties: value == null ? [] : [{ name: "font-family", value }] },
  })),
});
const css = (
  progress: number | null,
  frames: PageFamilyAnimation["keyframes"],
  extra: Partial<PageFamilyAnimation> = {},
): PageFamilyAnimation => ({
  kind: "css",
  name: "k",
  playState: "paused",
  playbackRate: 1,
  documentTimeline: true,
  pseudoElement: null,
  progress,
  keyframes: frames,
  ...extra,
});
const frame = (offset: number, fontFamily: string | null, easing = "linear") => ({
  offset,
  easing,
  fontFamily,
  font: false,
  all: false,
});
const classify = async (value: string): Promise<FamilyResolution> =>
  value === "initial"
    ? { type: "standard" }
    : /^[A-Z]/.test(value)
      ? { type: "concrete" }
      : { reason: `unsupported ${value}` };

describe("animated family join (DM-ZAXD0C)", () => {
  it("classifies the authored keyframe, not the lossy computed Times", async () => {
    const page = { computed: "Times", animations: [css(0.6, [frame(0, "Courier"), frame(1, "Times")])] };
    expect(await resolveAnimatedFamilyType(page, [rule(["0%", "Courier"], ["100%", "initial"])], classify)).toEqual({
      type: "standard",
    });
    const before = { computed: "Courier", animations: [css(0.4, [frame(0, "Courier"), frame(1, "Times")])] };
    expect(await resolveAnimatedFamilyType(before, [rule(["0%", "Courier"], ["100%", "initial"])], classify)).toEqual({
      type: "concrete",
    });
    const concrete = { computed: "Times", animations: [css(0.6, [frame(0, "Courier"), frame(1, "Times")])] };
    expect(await resolveAnimatedFamilyType(concrete, [rule(["0%", "Courier"], ["100%", "Times"])], classify)).toEqual({
      type: "concrete",
    });
  });
  it("lets the last same-offset block win and maps synthetic boundaries to the base", async () => {
    const dup = { computed: "Times", animations: [css(0.1, [frame(0, "Times"), frame(1, "Arial")])] };
    expect(
      await resolveAnimatedFamilyType(dup, [rule(["0%", "Courier"], ["0%", "initial"], ["100%", "Arial"])], classify),
    ).toEqual({ type: "standard" });
    const neutral = {
      computed: "Georgia",
      animations: [css(0.2, [frame(0, "Georgia"), frame(0.5, "Times"), frame(1, "Georgia")])],
    };
    expect(await resolveAnimatedFamilyType(neutral, [rule(["50%", "initial"])], classify)).toEqual({ base: true });
  });
  it("negative control: missing or disagreeing keyframe text stays unknown", async () => {
    const page = { computed: "Times", animations: [css(0.6, [frame(0, "Courier"), frame(1, "Times")])] };
    expect(await resolveAnimatedFamilyType(page, undefined, classify)).toMatchObject({ reason: expect.any(String) });
    expect(
      await resolveAnimatedFamilyType(page, [rule(["0%", "Courier"], ["40%", "initial"])], classify),
    ).toMatchObject({
      reason: expect.any(String),
    });
    // A flip-side error would be caught by the computed-value cross-check.
    const wrong = { computed: "Courier", animations: [css(0.6, [frame(0, "Courier"), frame(1, "Times")])] };
    expect(await resolveAnimatedFamilyType(wrong, [rule(["0%", "Courier"], ["100%", "initial"])], classify)).toEqual({
      reason: "chosen keyframe disagrees with the computed family",
    });
  });
  it("takes the topmost non-neutral layer and falls through neutral ones", async () => {
    const lower = css(0.6, [frame(0, "Courier"), frame(1, "Times")]);
    const upper: PageFamilyAnimation = {
      ...css(0.2, [frame(0, "Georgia"), frame(0.5, "Arial"), frame(1, "Georgia")]),
      name: "u",
    };
    const rules = [
      rule(["0%", "Courier"], ["100%", "initial"]),
      { ...rule(["50%", "Arial"]), animationName: { text: "u" } },
    ];
    expect(await resolveAnimatedFamilyType({ computed: "Times", animations: [lower, upper] }, rules, classify)).toEqual(
      {
        type: "standard",
      },
    );
  });
  it("uses specified script keyframes and refuses transitions, timelines and races", async () => {
    const script: PageFamilyAnimation = {
      ...css(0.3, [frame(0, "initial"), frame(1, "initial")]),
      kind: "script",
      name: null,
    };
    expect(await resolveAnimatedFamilyType({ computed: "Times", animations: [script] }, [], classify)).toEqual({
      type: "standard",
    });
    for (const extra of [{ kind: "transition" as const }, { documentTimeline: false }, { pseudoElement: "::before" }])
      expect(
        await resolveAnimatedFamilyType({ computed: "Times", animations: [{ ...script, ...extra }] }, [], classify),
      ).toMatchObject({ reason: expect.any(String) });
    const running = { ...css(0.3, [frame(0, "Courier"), frame(1, "Times")]), playState: "running" };
    expect(
      await resolveAnimatedFamilyType(
        { computed: "Courier", animations: [running] },
        [rule(["0%", "Courier"], ["100%", "initial"])],
        classify,
      ),
    ).toEqual({ reason: "running family animation changes type" });
    expect(
      await resolveAnimatedFamilyType(
        { computed: "Times", animations: [running] },
        [rule(["from,to", "initial"])],
        classify,
      ),
    ).toEqual({ type: "standard" });
  });
});

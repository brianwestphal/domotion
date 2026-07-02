import { describe, it, expect } from "vitest";
import { compareTemplate, revealAnimation, compareOverlayMarkup, compareParamsSchema } from "./compare.js";

const parse = (v: unknown): ReturnType<typeof compareParamsSchema.parse> => compareParamsSchema.parse(v);

describe("compare — clip reveal geometry (DM-1533)", () => {
  it("horizontal directions use clipScaleX with the anchored origin", () => {
    expect(revealAnimation("right", 1000)).toMatchObject({ property: "clipScaleX", from: 0, to: 1, transformOrigin: "left" });
    expect(revealAnimation("left", 1000)).toMatchObject({ property: "clipScaleX", transformOrigin: "right" });
  });

  it("vertical directions use clipScaleY with the anchored origin", () => {
    expect(revealAnimation("down", 1000)).toMatchObject({ property: "clipScaleY", transformOrigin: "top" });
    expect(revealAnimation("up", 1000)).toMatchObject({ property: "clipScaleY", transformOrigin: "bottom" });
  });

  it("the reveal runs from a zero clip over the given duration", () => {
    const a = revealAnimation("right", 1500);
    expect(a.from).toBe(0);
    expect(a.to).toBe(1);
    expect(a.start).toBe(0);
    expect(a.duration).toBe(1500);
  });
});

describe("compare — overlay markup (DM-1533)", () => {
  it("renders only the labels that are provided", () => {
    const both = compareOverlayMarkup(parse({ before: "a.png", after: "b.png", beforeLabel: "Old", afterLabel: "New" }));
    expect(both).toContain(">Old<");
    expect(both).toContain(">New<");
    const none = compareOverlayMarkup(parse({ before: "a.png", after: "b.png" }));
    expect(none).not.toContain("<text");
  });

  it("escapes label text", () => {
    const m = compareOverlayMarkup(parse({ before: "a.png", after: "b.png", beforeLabel: "<b>x</b>" }));
    expect(m).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("wipe mode emits NO divider; slide mode emits a divider line + keyframes", () => {
    const wipe = compareOverlayMarkup(parse({ before: "a.png", after: "b.png", mode: "wipe" }));
    expect(wipe).not.toContain("cmp-div");
    const slide = compareOverlayMarkup(parse({ before: "a.png", after: "b.png", mode: "slide" }));
    expect(slide).toContain("cmp-div");
    expect(slide).toContain("@keyframes cmp-div");
  });

  it("the horizontal divider sweeps translateX 0→W; vertical uses translateY 0→H", () => {
    const right = compareOverlayMarkup(parse({ before: "a.png", after: "b.png", mode: "slide", direction: "right", width: 800 }));
    expect(right).toContain("translateX(0px)");
    expect(right).toContain("translateX(800px)");
    const down = compareOverlayMarkup(parse({ before: "a.png", after: "b.png", mode: "slide", direction: "down", height: 600 }));
    expect(down).toContain("translateY(0px)");
    expect(down).toContain("translateY(600px)");
  });

  it("places each label over the region it describes (after = reveal-origin side)", () => {
    // direction right → after is revealed on the LEFT, before stays on the RIGHT.
    const m = compareOverlayMarkup(parse({ before: "a.png", after: "b.png", direction: "right", beforeLabel: "Old", afterLabel: "New", width: 1000 }));
    // Grab each label's pill x. "New" (after) should sit at the left (small x),
    // "Old" (before) at the right (large x).
    const xOf = (label: string): number => {
      const re = new RegExp(`<rect x="([0-9.]+)"[^>]*/><text[^>]*>${label}<`);
      return Number(re.exec(m)![1]);
    };
    expect(xOf("New")).toBeLessThan(xOf("Old"));
  });

  it("centers the label text in its pill (text-anchor middle)", () => {
    const m = compareOverlayMarkup(parse({ before: "a.png", after: "b.png", beforeLabel: "Old" }));
    expect(m).toContain('text-anchor="middle"');
  });

  it("the divider hold point is the reveal duration as a % of the total", () => {
    // durationMs 1000 of holdMs 4000 → the divider reaches the far edge at 25%.
    const m = compareOverlayMarkup(parse({ before: "a.png", after: "b.png", mode: "slide", durationMs: 1000, holdMs: 4000 }));
    expect(m).toContain("25.00%");
  });
});

describe("compare — template shape (DM-1533)", () => {
  it("is a registered template with before/after required", () => {
    expect(compareTemplate.name).toBe("compare");
    expect(() => compareParamsSchema.parse({ after: "b.png" })).toThrow();
    expect(() => compareParamsSchema.parse({ before: "a.png" })).toThrow();
    expect(() => compareParamsSchema.parse({ before: "a.png", after: "b.png" })).not.toThrow();
  });

  it("defaults to a wipe reveal traveling right", () => {
    const p = compareParamsSchema.parse({ before: "a.png", after: "b.png" });
    expect(p.mode).toBe("wipe");
    expect(p.direction).toBe("right");
  });
});

/**
 * DM-1562 (docs/94 Option 1): `hoverReveal` sugar. Pure config → config
 * expansion (`expandHoverReveal`) plus the schema-validation rules — no browser.
 * The rendered round-trip is the `hover-reveal` animate example golden.
 */
import { describe, it, expect } from "vitest";
import { expandHoverReveal, validateAnimateConfig, type AnimateConfig } from "./animate.js";

const base = { width: 460, height: 320 };

function make(raw: Record<string, unknown>): AnimateConfig {
  return validateAnimateConfig({ ...base, ...raw });
}

describe("expandHoverReveal (DM-1562)", () => {
  it("is a no-op when no frame declares hoverReveal", () => {
    const cfg = make({ frames: [{ input: "./x.html", duration: 1000 }] });
    expect(expandHoverReveal(cfg)).toBe(cfg);
  });

  it("expands a hoverReveal frame into rest + forced-hover continue frames with a crossfade", () => {
    const cfg = make({ frames: [{ input: "./card.html", duration: 1200, hoverReveal: { selector: ".cta" } }] });
    const out = expandHoverReveal(cfg);
    expect(out.frames).toHaveLength(2);
    const [rest, hover] = out.frames;
    // Rest: keeps the input/duration, gains a crossfade INTO the reveal, sheds the sugar.
    expect(rest.input).toBe("./card.html");
    expect(rest.duration).toBe(1200);
    expect(rest.transition).toEqual({ type: "crossfade", duration: 400 });
    expect(rest.hoverReveal).toBeUndefined();
    // Hover: continues the live page and forces :hover on the same selector.
    expect(hover.continue).toBe(true);
    expect(hover.duration).toBe(1200);
    expect(hover.forceState).toEqual([{ selector: ".cta", states: ["hover"] }]);
  });

  it("injects a cursor move during the REST frame so the pointer lands before the hover reveal (DM-1586)", () => {
    const cfg = make({ frames: [{ input: "./card.html", duration: 1000, hoverReveal: { selector: ".cta" } }] });
    const out = expandHoverReveal(cfg);
    // The move is on the rest frame (0), timed to arrive at its end (1000ms rest −
    // the 400ms glide = 600), so the cursor is settled on the element when the hover
    // crossfade begins — not still traveling while the paint reaches full hover.
    expect(out.cursor).toEqual({ events: [{ frame: 0, at: 600, type: "move", selector: ".cta" }] });
  });

  it("times the cursor arrival from the frame's OWN duration, not a fixed value (DM-1586)", () => {
    // A long rest hold → the move starts late enough to arrive at the hold's end
    // (duration − the 400ms glide). This is per-frame, so any real config gets
    // correct arrival timing, not just the demos.
    const long = expandHoverReveal(make({ frames: [{ input: "./x.html", duration: 2000, hoverReveal: { selector: ".b" } }] }));
    expect(long.cursor).toEqual({ events: [{ frame: 0, at: 1600, type: "move", selector: ".b" }] });
    // A hold shorter than the glide clamps to 0 (start gliding immediately).
    const short = expandHoverReveal(make({ frames: [{ input: "./x.html", duration: 300, hoverReveal: { selector: ".b" } }] }));
    expect(short.cursor).toEqual({ events: [{ frame: 0, at: 0, type: "move", selector: ".b" }] });
  });

  it("honors crossfadeMs / hoverMs / states / cursor:false overrides", () => {
    const cfg = make({
      frames: [{ input: "./card.html", duration: 1000, hoverReveal: { selector: "#f", states: ["focus", "focus-visible"], crossfadeMs: 250, hoverMs: 2000, cursor: false } }],
    });
    const out = expandHoverReveal(cfg);
    expect(out.frames[0].transition).toEqual({ type: "crossfade", duration: 250 });
    expect(out.frames[1].duration).toBe(2000);
    expect(out.frames[1].forceState).toEqual([{ selector: "#f", states: ["focus", "focus-visible"] }]);
    expect(out.cursor).toBeUndefined();
  });

  it("carries the frame's own transition out of the reveal pair", () => {
    const cfg = make({
      frames: [
        { input: "./a.html", duration: 1000, hoverReveal: { selector: ".cta" }, transition: { type: "push-left", duration: 300 } },
        { input: "./b.html", duration: 800 },
      ],
    });
    const out = expandHoverReveal(cfg);
    expect(out.frames).toHaveLength(3);
    // The rest frame crossfades INTO the reveal; the reveal frame carries the
    // original push-left OUT to the following frame.
    expect(out.frames[0].transition).toEqual({ type: "crossfade", duration: 400 });
    expect(out.frames[1].transition).toEqual({ type: "push-left", duration: 300 });
    expect(out.frames[2].input).toBe("./b.html");
  });

  it("remaps existing explicit cursor.events through the post-expansion numbering", () => {
    const cfg = make({
      cursor: { events: [{ frame: 1, at: 100, type: "move", to: { x: 10, y: 10 } }] },
      frames: [
        { input: "./a.html", duration: 1000, hoverReveal: { selector: ".cta" } }, // becomes frames 0,1
        { input: "./b.html", duration: 800 }, // old index 1 → new index 2
      ],
    });
    const out = expandHoverReveal(cfg);
    const cursor = out.cursor as { events: Array<{ frame: number }> };
    // The user's event that referenced old frame 1 now points at new frame 2, and
    // the injected hover cursor glides in on the rest frame (new frame 0), arriving
    // at its end (1000 − 400ms glide) so it's on the element before the reveal.
    expect(cursor.events).toContainEqual({ frame: 2, at: 100, type: "move", to: { x: 10, y: 10 } });
    expect(cursor.events).toContainEqual({ frame: 0, at: 600, type: "move", selector: ".cta" });
  });
});

describe("hoverReveal / hoverDetect validation (DM-1562 / DM-1563)", () => {
  it("accepts a hoverReveal frame", () => {
    expect(() => make({ frames: [{ input: "./x.html", duration: 1000, hoverReveal: { selector: ".cta" } }] })).not.toThrow();
  });

  it("rejects hoverReveal combined with forceState", () => {
    expect(() =>
      make({ frames: [{ input: "./x.html", duration: 1000, hoverReveal: { selector: ".cta" }, forceState: [{ selector: ".cta", states: ["hover"] }] }] }),
    ).toThrow(/hoverReveal.*forceState/i);
  });

  it("rejects hoverReveal on a template frame", () => {
    expect(() => make({ frames: [{ template: "lower-third", duration: 1000, hoverReveal: { selector: ".cta" } }] })).toThrow(/hoverReveal.*cast.*template/i);
  });

  it("rejects hoverReveal and hoverDetect on the same frame", () => {
    expect(() =>
      make({ frames: [{ input: "./x.html", duration: 1000, hoverReveal: { selector: ".a" }, hoverDetect: { selector: ".a" } }] }),
    ).toThrow(/hoverReveal.*hoverDetect|both/i);
  });

  it("rejects hoverDetect on a continue frame (needs an input to probe)", () => {
    expect(() =>
      make({ frames: [{ input: "./x.html", duration: 1000 }, { continue: true, duration: 1000, hoverDetect: { selector: ".a" } }] }),
    ).toThrow(/hoverDetect.*requires an .input/i);
  });

  it("accepts a hoverDetect frame with an input", () => {
    expect(() => make({ frames: [{ input: "./x.html", duration: 1000, hoverDetect: { selector: ".cta" } }] })).not.toThrow();
  });
});

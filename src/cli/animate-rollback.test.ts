import { describe, expect, it } from "vitest";
import type { Page } from "@playwright/test";
import { glyphDefCount, withRenderTextMode } from "../render/font-resolution.js";
import { renderTextAsPath } from "../render/text-to-path.js";
import { queryCursorBox, trialGeneration } from "./animate-orchestrator.js";

// A speculative pass that advances the shared glyph generation (the same registry the compressed-run
// size guard's trial composes advance).
function advanceGeneration(): void {
  withRenderTextMode("paths", () =>
    renderTextAsPath("Trial", 0, 20, { fontSize: 20, fontFamily: "sans-serif", fontWeight: "400", fill: "#000" }),
  );
}

describe("trialGeneration — speculative composes never leak generation state", () => {
  it("rolls the glyph generation back after a trial that returns", () => {
    const before = glyphDefCount();
    const size = trialGeneration(() => {
      advanceGeneration();
      expect(glyphDefCount()).toBeGreaterThan(before);
      return 42;
    });
    expect(size).toBe(42);
    expect(glyphDefCount()).toBe(before);
  });

  it("rolls the generation back when the trial throws, and rethrows the original error", () => {
    const before = glyphDefCount();
    const failure = new Error("compose failed mid-trial");
    expect(() =>
      trialGeneration(() => {
        advanceGeneration();
        throw failure;
      }),
    ).toThrow(failure);
    expect(glyphDefCount()).toBe(before);
  });

  it("nests: an inner trial's rollback leaves the outer trial's own additions until it ends", () => {
    const start = glyphDefCount();
    trialGeneration(() => {
      advanceGeneration();
      const afterOuter = glyphDefCount();
      trialGeneration(() => {
        withRenderTextMode("paths", () =>
          renderTextAsPath("Inner text", 0, 20, {
            fontSize: 22,
            fontFamily: "serif",
            fontWeight: "700",
            fill: "#000",
          }),
        );
      });
      expect(glyphDefCount()).toBe(afterOuter);
    });
    expect(glyphDefCount()).toBe(start);
  });

  it("does not disturb a caller's earlier registrations, across repeated success/throw trials", () => {
    advanceGeneration();
    const registered = glyphDefCount();
    for (let i = 0; i < 3; i++) {
      trialGeneration(() => advanceGeneration());
      expect(() =>
        trialGeneration(() => {
          advanceGeneration();
          throw new Error("x");
        }),
      ).toThrow("x");
      expect(glyphDefCount()).toBe(registered);
    }
  });
});

// queryCursorBox measures the auto-cursor's aim point. Only "the selector matches nothing" may read as
// "no target"; a page-context failure must surface instead of silently dropping the pointer.
describe("queryCursorBox", () => {
  const pageWith = (evaluate: (...args: unknown[]) => Promise<unknown>): Page => ({ evaluate }) as unknown as Page;

  it("returns null only when the selector matches no element", async () => {
    const page = pageWith(async () => null); // borderBox's measurement: no element
    await expect(queryCursorBox(page, ".missing")).resolves.toBeNull();
  });

  it("returns the aim point and the element's cursor keyword", async () => {
    const answers = [{ x: 10, y: 20, width: 100, height: 40 }, "pointer"];
    const page = pageWith(async () => answers.shift());
    await expect(queryCursorBox(page, ".btn")).resolves.toEqual({ cx: 60, cy: 40, cursor: "pointer" });
  });

  it("honors the anchor and offset", async () => {
    const answers = [{ x: 10, y: 20, width: 100, height: 40 }, "default"];
    const page = pageWith(async () => answers.shift());
    await expect(queryCursorBox(page, ".btn", "top-left", { dx: 3, dy: 4 })).resolves.toMatchObject({ cx: 13, cy: 24 });
  });

  it.each([
    ["a navigation mid-evaluate", "Execution context was destroyed, most likely because of a navigation"],
    ["a detached frame", "Frame was detached"],
    ["an invalid selector", "SyntaxError: '!!' is not a valid selector"],
  ])("lets %s propagate instead of reading as 'no target'", async (_name, message) => {
    const page = pageWith(async () => {
      throw new Error(message);
    });
    await expect(queryCursorBox(page, ".btn")).rejects.toThrow(message);
  });

  it("propagates a failure of the cursor-style probe after the element was found", async () => {
    let call = 0;
    const page = pageWith(async () => {
      call++;
      if (call === 1) return { x: 0, y: 0, width: 10, height: 10 };
      throw new Error("Target closed");
    });
    await expect(queryCursorBox(page, ".btn")).rejects.toThrow("Target closed");
  });
});

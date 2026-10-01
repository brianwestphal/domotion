import type { Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { calibrateBaselines } from "./index.js";
import type { CapturedElement } from "./types.js";

function textElement(): CapturedElement {
  return {
    tag: "p",
    children: [],
    text: "Hxgy",
    textTop: 20,
    textLeft: 20,
    textWidth: 72,
    textHeight: 36,
    x: 20,
    y: 20,
    width: 72,
    height: 36,
    styles: {
      fontSize: "32px",
      fontFamily: "Arial, sans-serif",
      fontWeight: "400",
      fontStyle: "normal",
      color: "rgb(0, 0, 0)",
    },
  } as CapturedElement;
}

describe("calibrateBaselines result application", () => {
  it("writes a successful browser measurement even when it equals the captured ascent", async () => {
    const text = textElement();
    const empty = { ...textElement(), text: "", fontAscent: 17 };
    let ascent = 29;
    const writes: number[] = [];
    Object.defineProperty(text, "fontAscent", {
      get: () => ascent,
      set: (value: number) => {
        writes.push(value);
        ascent = value;
      },
    });
    const evaluate = vi.fn(async (expression: string) => {
      expect(expression).toContain('"text":"Hxgy"');
      return [{ key: "c0", ascent: 29 }];
    });
    const page = { evaluate } as unknown as Page;

    await calibrateBaselines(page, [text, empty], Buffer.from([0]));

    expect(evaluate).toHaveBeenCalledOnce();
    expect(writes).toEqual([29]);
    expect(text.fontAscent).toBe(29);
    expect(empty.fontAscent).toBe(17);
  });

  it("keeps the captured ascent when the browser reports no usable ink", async () => {
    const text = textElement();
    text.fontAscent = 29;
    const page = { evaluate: vi.fn(async () => [{ key: "c0", ascent: null }]) } as unknown as Page;
    await calibrateBaselines(page, [text], Buffer.from([0]));
    expect(text.fontAscent).toBe(29);
  });
});

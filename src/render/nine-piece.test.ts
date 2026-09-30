import { describe, expect, it } from "vitest";
import type { CapturedElement } from "../capture/types.js";
import { renderBorderImage } from "./borders.js";
import { buildMaskBorder9Slice } from "./mask.js";
import { ninePieceTileAxis, paintNinePiece, parseNinePieceInputs } from "./nine-piece.js";

const source =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/oE8AAAAASUVORK5CYII=";
const box = { x: 10.4, y: 20.6, width: 114, height: 74 };
const borders = { top: 10, right: 10, bottom: 10, left: 10 };
const input = (mode: string) => ({
  box,
  borderWidths: borders,
  sliceRaw: "10 fill",
  widthRaw: "1",
  outsetRaw: "0",
  repeatRaw: mode,
  intrinsic: { width: 30, height: 30 },
});
const element = (mode: string, gradient = false): CapturedElement =>
  ({
    tag: "div",
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    children: [],
    styles: {
      borderTopWidth: "10px",
      borderRightWidth: "10px",
      borderBottomWidth: "10px",
      borderLeftWidth: "10px",
      borderImageSource: gradient ? "linear-gradient(red, blue)" : `url("${source}")`,
      borderImageIntrinsicWidth: 30,
      borderImageIntrinsicHeight: 30,
      borderImageSlice: "10 fill",
      borderImageWidth: "1",
      borderImageOutset: "0",
      borderImageRepeat: mode,
      maskBorderIntrinsicWidth: 30,
      maskBorderIntrinsicHeight: 30,
    },
  }) as unknown as CapturedElement;

describe("shared nine-piece geometry", () => {
  it("snaps mask and border destinations through the same Blink grid", () => {
    const parsed = parseNinePieceInputs(input("stretch"))!;
    expect(parsed.grid).toMatchObject({ x: 10, y: 21, width: 114, height: 74, top: 10, left: 10 });
    const slots: string[] = [];
    paintNinePiece(parsed, {
      stretch: ({ destination }) => slots.push(`${destination.x},${destination.y}`),
      edge: () => {
        throw new Error("stretch should not tile");
      },
      center: () => {
        throw new Error("stretch should not tile");
      },
    });
    expect(slots).toEqual(["10,21", "114,21", "10,85", "114,85", "20,21", "20,85", "10,31", "114,31", "20,31"]);
  });

  it.each(["stretch", "repeat", "round", "space"])("selects every %s slot once", (mode) => {
    const parsed = parseNinePieceInputs(input(mode))!;
    const calls: string[] = [];
    paintNinePiece(parsed, {
      stretch: () => calls.push("stretch"),
      edge: (_slot, axis, repeat) => calls.push(`${axis}:${repeat}`),
      center: (_slot, horizontal, vertical) => calls.push(`center:${horizontal}/${vertical}`),
    });
    expect(calls).toHaveLength(9);
    expect(calls.slice(0, 4)).toEqual(Array(4).fill("stretch"));
    if (mode === "stretch") expect(calls.slice(4)).toEqual(Array(5).fill("stretch"));
    else expect(calls.slice(4)).toEqual([`x:${mode}`, `x:${mode}`, `y:${mode}`, `y:${mode}`, `center:${mode}/${mode}`]);
  });

  it("uses full end gaps for space and centers repeat tiles", () => {
    expect(ninePieceTileAxis(94, 20, "space")).toEqual({ tile: 20, period: 22.8, phase: 2.8 });
    expect(ninePieceTileAxis(94, 20, "repeat")).toEqual({ tile: 20, period: 20, phase: 37 });
  });
});

describe("nine-piece SVG backends", () => {
  it.each(["stretch", "repeat", "round", "space"])("emits URL, gradient, and mask slots for %s", (mode) => {
    const defs: string[] = [];
    const border = renderBorderImage(element(mode), "", "u", defs, 0);
    expect(border.svg).toContain("<image ");
    expect(border.svg).toContain(source);
    expect(border.svg.match(/<(?:image|rect) /g)).toHaveLength(9);
    const gradDefs: string[] = [];
    const gradient = renderBorderImage(element(mode, true), "", "g", gradDefs, 0);
    expect(gradient.svg.split("\n")).toHaveLength(9);
    const mask = buildMaskBorder9Slice(element(mode), source, "10 fill", "1", "0", mode, "m", "m", 0)!;
    expect(mask.def).toContain(source);
    expect(mask.nextClipIdx).toBeGreaterThan(0);
    if (mode !== "stretch") {
      expect(border.svg).toContain("<rect ");
      expect(gradient.svg).toContain("<rect ");
      expect(mask.def).toContain("<pattern ");
    }
  });
});

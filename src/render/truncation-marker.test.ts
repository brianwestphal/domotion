import { measureTruncationMarker } from "@domotion/text-engine/text";
import { describe, expect, it } from "vitest";
import type { CapturedElement } from "../capture/types.js";
import { __paintTruncationMarkerForTest as paintMarker } from "./element-tree-to-svg.js";

/**
 * The text-overflow marker is placed where `LineTruncator` puts it: its width is the shaped advance of the
 * marker rounded up to 1/64 px (`SetupEllipsis`), and it starts at the end of the text that still fits in
 * `content width - marker width` (`EllipsizeChild`). These tests drive `paintTruncationMarker` with a
 * minimal element, since the default pipeline reaches it only for captures that keep the full text.
 */
const FONT = { fontSize: 16, fontFamily: "Courier", fontWeight: "400", fontStyle: "normal", fontStretch: "100%" };

// 20 characters, 10 px each, starting at x=20: edges at 20, 30, ... 220.
const X_OFFSETS = Array.from({ length: 21 }, (_, i) => 20 + i * 10);

function element(overrides: Record<string, unknown> = {}, styles: Record<string, string> = {}): CapturedElement {
  return {
    tag: "div",
    x: 20,
    y: 10,
    width: 120,
    height: 24,
    text: "abcdefghijklmnopqrst",
    textTop: 12,
    textHeight: 19,
    fontAscent: 15,
    fontDescent: 4,
    textSegments: [{ text: "abcdefghijklmnopqrst", width: 200, xOffsets: X_OFFSETS }],
    styles: {
      display: "block",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      overflowX: "hidden",
      fontSize: "16px",
      fontFamily: "Courier",
      fontWeight: "400",
      fontStyle: "normal",
      fontStretch: "100%",
      paddingLeft: "0",
      paddingRight: "0",
      borderLeftWidth: "0",
      borderRightWidth: "0",
      borderTopWidth: "0",
      borderBottomWidth: "0",
      backgroundColor: "rgb(250, 250, 250)",
      ...styles,
    },
    children: [],
    ...overrides,
  } as unknown as CapturedElement;
}

const paint = (el: CapturedElement) => paintMarker(el, { r: 0, g: 0, b: 0, a: 1 } as never, "");

function parse(out: string[]) {
  const rect = /<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="(-?[\d.]+)" height="(-?[\d.]+)"/.exec(out[0] ?? "");
  const text = /<text x="(-?[\d.]+)(?: [^"]*)?" y="(-?[\d.]+)"[^>]*font-family="([^"]+)"[^>]*>([^<]*)<\/text>/.exec(
    out[1] ?? "",
  );
  const label = /aria-label="([^"]+)"/.exec(out[1] ?? "");
  return {
    rect: rect && { x: +rect[1], y: +rect[2], width: +rect[3], height: +rect[4] },
    text: text && { x: +text[1], y: +text[2], family: text[3], content: text[4], label: label?.[1] },
  };
}

describe("paintTruncationMarker", () => {
  it("starts the marker at the end of the last character that fits beside it", () => {
    const measured = measureTruncationMarker(null, FONT)!;
    expect(measured.widthPx).toBeGreaterThan(0);
    // Discriminating input: a monospace "…" is not one em wide, so a width fitted as a multiple of the font
    // size (the previous 1.0 x fontSize) would place the marker at a different edge.
    expect(Math.abs(measured.widthPx - FONT.fontSize)).toBeGreaterThan(1);
    expect(measured.widthPx * 64).toBeCloseTo(Math.round(measured.widthPx * 64), 9); // whole 1/64 px
    const { rect, text } = parse(paint(element()));
    // Content right edge is 20 + 120 = 140; the largest edge <= 140 - width is the marker's left.
    const expectedLeft = [...X_OFFSETS].reverse().find((edge) => edge <= 140 - measured.widthPx)!;
    expect(text!.x).toBeCloseTo(expectedLeft, 2);
    expect(text!.label).toBe(measured.text);
    expect(text!.family).toMatch(/^dmf\d+$/);
    expect(text!.content).not.toBe(measured.text); // the engine emits subset glyph codes
    expect(text!.y).toBe(27); // captured textTop 12 + ascent 15
    // The band that erases the clipped text starts at the marker and runs to the box's right edge.
    expect(rect!.x).toBeCloseTo(expectedLeft, 2);
    expect(rect!.x + rect!.width).toBeCloseTo(140, 2);
  });

  it("sizes the erase band from the captured line box, not a multiple of the font size", () => {
    const { rect } = parse(paint(element()));
    expect(rect!.y).toBe(12);
    expect(rect!.height).toBe(19); // textHeight 19, within the box bottom (10 + 24 - 12 = 22)
    const short = parse(paint(element({ height: 20 })));
    expect(short.rect!.height).toBe(18); // capped at the box bottom: 10 + 20 - 12
    expect(short.rect!.height).toBeLessThan(19);
  });

  it("derives the line-box height from ascent + descent when textHeight is absent", () => {
    const { rect } = parse(paint(element({ textHeight: undefined })));
    expect(rect!.height).toBe(19); // 15 + 4
  });

  it("uses the author's string as the marker and measures THAT string", () => {
    const measured = measureTruncationMarker("[..]", FONT)!;
    const { text } = parse(paint(element({}, { textOverflow: '"[..]"' })));
    expect(text!.label).toBe("[..]");
    expect(text!.family).toMatch(/^dmf\d+$/);
    const expectedLeft = [...X_OFFSETS].reverse().find((edge) => edge <= 140 - measured.widthPx)!;
    expect(text!.x).toBeCloseTo(expectedLeft, 2);
  });

  it("paints nothing when the text fits, wraps, or is not clipped", () => {
    const fits = element({ textSegments: [{ text: "abc", width: 30, xOffsets: [20, 30, 40, 50] }] });
    expect(paint(fits)).toEqual([]);
    expect(paint(element({}, { textOverflow: "clip" }))).toEqual([]);
    expect(paint(element({}, { overflowX: "visible" }))).toEqual([]);
    expect(paint(element({}, { whiteSpace: "normal" }))).toEqual([]);
    const wrapped = element({
      textSegments: [
        { text: "abcdefghij", width: 100, xOffsets: X_OFFSETS.slice(0, 11) },
        { text: "klmnopqrst", width: 100, xOffsets: X_OFFSETS.slice(10) },
      ],
    });
    expect(paint(wrapped)).toEqual([]);
  });

  it("requires a Blink block container rather than an anonymous flex or grid text item", () => {
    for (const display of ["flex", "inline-flex", "grid", "inline-grid", "inline", "contents"]) {
      expect(paint(element({}, { display })), display).toEqual([]);
    }
    for (const display of ["block", "flow-root", "list-item", "inline-block", "table-caption"]) {
      expect(paint(element({}, { display })).length, display).toBeGreaterThan(0);
    }
  });
});

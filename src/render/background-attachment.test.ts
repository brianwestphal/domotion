import { describe, expect, it } from "vitest";

import type { CapturedBackgroundAttachmentGeometry } from "../capture/types.js";
import { resolveBackgroundAttachment } from "./background-attachment.js";

const viewport = { w: 240, h: 170 };
const border = { x: 20, y: 20, width: 160, height: 100 };
const padding = { x: 27, y: 27, width: 146, height: 86 };
const content = { x: 38, y: 40, width: 124, height: 60 };

function geometry(
  overrides: Partial<CapturedBackgroundAttachmentGeometry> = {},
): CapturedBackgroundAttachmentGeometry {
  return {
    source: "blink-box-background-paint-context-v1",
    fixedToViewport: true,
    layoutViewport: { x: 0, y: 0, width: 225, height: 155 },
    ...overrides,
  };
}

describe("Blink background attachment positioning areas", () => {
  it("uses the scrollbar-excluding layout viewport for an effective fixed layer", () => {
    expect(resolveBackgroundAttachment("fixed", border, padding, border, geometry(), viewport)).toEqual({
      attachment: "fixed",
      positioningBox: { x: 0, y: 0, width: 225, height: 155 },
      paintingBox: border,
      localOverflowClipped: false,
    });
  });

  it("treats fixed under an applicable transform as scroll", () => {
    expect(resolveBackgroundAttachment(
      "fixed", border, padding, border, geometry({ fixedToViewport: false }), viewport,
    )).toEqual({
      attachment: "scroll",
      positioningBox: padding,
      paintingBox: border,
      localOverflowClipped: false,
    });
  });

  it("subtracts both snapped scroll axes and uses scroll extent plus borders", () => {
    const resolved = resolveBackgroundAttachment("local", border, padding, content, geometry({
      local: {
        active: true,
        scrollOffsetX: 73,
        scrollOffsetY: 59,
        borderPaintWidth: 344,
        borderPaintHeight: 274,
        overflowClip: { x: 27, y: 27, width: 146, height: 86 },
      },
    }), viewport);
    expect(resolved).toEqual({
      attachment: "local",
      positioningBox: { x: -46, y: -32, width: 330, height: 260 },
      paintingBox: { x: 27, y: 27, width: 146, height: 86 },
      localOverflowClipped: true,
    });
  });

  it("keeps local inert on a non-scroll-container and reacts to mutation records", () => {
    const inert = geometry({ local: {
      active: false,
      scrollOffsetX: 0,
      scrollOffsetY: 0,
      borderPaintWidth: 160,
      borderPaintHeight: 100,
      overflowClip: padding,
    } });
    expect(resolveBackgroundAttachment("local", border, padding, border, inert, viewport).positioningBox).toEqual(padding);

    const moved = geometry({ local: {
      active: true,
      scrollOffsetX: 41,
      scrollOffsetY: 23,
      borderPaintWidth: 300,
      borderPaintHeight: 220,
      overflowClip: padding,
    } });
    expect(resolveBackgroundAttachment("local", border, padding, border, moved, viewport).positioningBox)
      .toEqual({ x: -14, y: 4, width: 286, height: 206 });
  });

  it("uses the root stitched positioning box while painting the canvas", () => {
    const resolved = resolveBackgroundAttachment("scroll", border, padding, border, geometry({
      canvas: {
        owner: "body-propagated",
        positioningRect: { x: 0, y: -91, width: 640, height: 960 },
      },
    }), viewport);
    expect(resolved).toEqual({
      attachment: "scroll",
      positioningBox: { x: 7, y: -84, width: 626, height: 946 },
      paintingBox: { x: 0, y: 0, width: 240, height: 170 },
      localOverflowClipped: false,
    });
  });

  it("falls back compatibly for old captures without the source record", () => {
    expect(resolveBackgroundAttachment("scroll", border, padding, content, undefined, viewport)).toEqual({
      attachment: "scroll",
      positioningBox: padding,
      paintingBox: content,
      localOverflowClipped: false,
    });
  });
});

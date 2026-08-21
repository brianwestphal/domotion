import { describe, expect, it } from "vitest";
import {
  resolveMaskContainCoverRect,
  resolveMaskPosition,
  resolveMaskPositionAxis,
  splitMaskPositionComponents,
} from "./mask-position.js";

describe("Blink mask-position geometry (DM-2379)", () => {
  it("keeps calc components intact and resolves percentage + physical px", () => {
    expect(splitMaskPositionComponents("calc(25% + 7px) calc(75% - 3px)"))
      .toEqual(["calc(25% + 7px)", "calc(75% - 3px)"]);
    expect(resolveMaskPosition("calc(25% + 7px) calc(75% - 3px)", 120, 40))
      .toEqual({ x: 37, y: 27 });
  });

  it("resolves positions against negative free space for cover", () => {
    expect(resolveMaskPosition("25% 75%", -100, -40))
      .toEqual({ x: -25, y: -30 });
    expect(resolveMaskPositionAxis("calc(100% - 13px)", -100)).toBe(-113);
  });

  it("fits contain, then positions at a non-quantized percentage", () => {
    // 200x100 intrinsic in a 180x120 area -> contain tile 180x90, leaving
    // 30px vertically. 73% is 21.9px; the retired SVG YMid bucket was 15px.
    expect(resolveMaskContainCoverRect(
      { x: 10, y: 20, width: 180, height: 120 },
      { w: 200, h: 100 },
      "contain",
      "23% 73%",
    )).toEqual({ x: 10, y: 41.890625, width: 180, height: 90 });
  });

  it("fits cover and retains the independent physical axes", () => {
    // 100x200 intrinsic covers 180x120 as 180x360. The vertical free space
    // is -240px, so calc(25% + 7px) lands at -53px relative to the area.
    expect(resolveMaskContainCoverRect(
      { x: 10, y: 20, width: 180, height: 120 },
      { w: 100, h: 200 },
      "cover",
      "17px calc(25% + 7px)",
    )).toEqual({ x: 27, y: -33, width: 180, height: 360 });
  });

  it("uses Blink's snapped-area and dependent contain-dimension rounding", () => {
    expect(resolveMaskContainCoverRect(
      { x: 0.25, y: 0.25, width: 100.5, height: 80.5 },
      { w: 3, h: 2 },
      "contain",
      "100% 100%",
    )).toEqual({ x: -0.25, y: 13.75, width: 101, height: 67 });
  });

  it("prefers Chromium's measured SVG aspect over integer natural dimensions", () => {
    // A viewBox-only 3:7 SVG reports integer natural dimensions 64x150 in
    // HTMLImageElement, but Blink's StyleImage retains the 3/7 aspect.
    expect(resolveMaskContainCoverRect(
      { x: 0, y: 0, width: 700, height: 700 },
      { w: 64, h: 150, ratio: 3 / 7 },
      "contain",
      "0% 0%",
    )).toEqual({ x: 0, y: 0, width: 300, height: 700 });
  });

  it("treats writing mode as external to physical mask-position axes", () => {
    // Blink FillLayer stores PositionX/PositionY in physical axes. Vertical
    // writing changes fragment strip orientation, not what 17px/75% mean.
    expect(resolveMaskPosition("17px 75%", 80, 40)).toEqual({ x: 17, y: 30 });
  });
});

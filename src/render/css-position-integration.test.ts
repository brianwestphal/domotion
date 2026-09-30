import { describe, expect, it } from "vitest";
import { translateClipPath } from "./clip-path.js";
import { parseBgPositionPx } from "./gradient-defs.js";
import { backgroundPositionOffsetPx } from "./image-pattern.js";
import { resolveMaskPosition } from "./mask-position.js";

describe("shared CSS position grammar", () => {
  it("resolves edge offsets for clip centers, mask tiles, and auto-sized gradients", () => {
    const css = "right 10px bottom 4px";
    expect(backgroundPositionOffsetPx(css, 100, 80)).toEqual({ x: 90, y: 76 });
    expect(resolveMaskPosition(css, 100, 80)).toEqual({ x: 90, y: 76 });
    expect(parseBgPositionPx(css)).toEqual([-10, -4]);
    expect(translateClipPath(`circle(10px at ${css})`, 3, 5, 100, 80)).toContain('cx="93" cy="81"');
  });
});

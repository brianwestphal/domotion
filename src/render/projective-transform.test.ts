import { describe, expect, it, vi } from "vitest";
import { getLastCaptureWarnings, resetLastCaptureWarnings } from "../capture/warnings.js";
import type { CapturedElement } from "../capture/types.js";
import { elementTreeToSvg } from "./element-tree-to-svg.js";

const styles = {
  backgroundColor: "rgb(255,0,0)",
  backgroundImage: "none",
  borderWidth: "0",
  borderColor: "rgb(0,0,0)",
  borderTopWidth: "0",
  borderRightWidth: "0",
  borderBottomWidth: "0",
  borderLeftWidth: "0",
  borderTopStyle: "none",
  borderRightStyle: "none",
  borderBottomStyle: "none",
  borderLeftStyle: "none",
  borderRadius: "0",
  color: "rgb(0,0,0)",
  fontSize: "16px",
  fontFamily: "sans-serif",
  fontWeight: "400",
  fontStyle: "normal",
  opacity: "1",
  transform: "none",
  overflowX: "visible",
  overflowY: "visible",
  display: "block",
  position: "static",
  zIndex: "auto",
  filter: "none",
  backdropFilter: "none",
  mixBlendMode: "normal",
  clipPath: "none",
  mask: "none",
  maskImage: "none",
  boxShadow: "none",
} as unknown as CapturedElement["styles"];

function projected(hidden = false): CapturedElement {
  return {
    tag: "div",
    text: "",
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    children: [],
    styles,
    projectiveTransform: [0.8, 0.1, 12, -0.2, 0.9, 7, 0, 0, 1],
    projectiveHidden: hidden,
  } as CapturedElement;
}

describe("static CSS 3D plane projection", () => {
  it("keeps the painted plane vector and applies its measured relative matrix", () => {
    const svg = elementTreeToSvg([projected()], 200, 120);
    expect(svg).toContain('transform="matrix(0.8 -0.2 0.1 0.9 12 7)"');
    expect(svg).toContain('<rect x="10" y="20" width="100" height="50"');
    expect(svg).not.toContain("<image");
  });

  it("does not paint a reverse-facing hidden plane", () => {
    const svg = elementTreeToSvg([projected(true)], 200, 120);
    expect(svg).not.toContain('fill="rgb(255,0,0)"');
  });
});

describe("atomic projective raster emission", () => {
  it("emits a promoted block-level inline SVG once and suppresses clone descendants", () => {
    const dataUri = "data:image/png;base64,cHJvamVjdGl2ZQ==";
    const owner: CapturedElement = {
      tag: "svg",
      text: "",
      x: 12,
      y: 18,
      width: 140,
      height: 80,
      styles,
      svgContent: '<svg viewBox="0 0 140 80"><rect id="dead-clone" width="140" height="80"/></svg>',
      transformSubtreeRaster: { x: 9, y: 14, width: 151, height: 91, dataUri },
      children: [
        {
          tag: "div",
          text: "dead-child",
          x: 20,
          y: 24,
          width: 30,
          height: 20,
          styles,
          children: [],
        },
      ],
    };

    const svg = elementTreeToSvg([owner], 200, 120);
    expect(svg.split(dataUri).length - 1).toBe(1);
    expect(svg).not.toContain("dead-clone");
    expect(svg).not.toContain("dead-child");
  });

  it("suppresses a Chromium-proved empty owner without falling through", () => {
    const owner: CapturedElement = {
      tag: "svg",
      text: "",
      x: 12,
      y: 18,
      width: 140,
      height: 80,
      styles,
      svgContent: '<svg><rect id="must-not-paint" width="10" height="10"/></svg>',
      transformSubtreeRaster: { x: 0, y: 0, width: 0, height: 0, empty: true },
      children: [],
    };

    expect(elementTreeToSvg([owner], 200, 120)).not.toContain("must-not-paint");
  });

  it("exposes the clone-suppressed-descendant mutation that owner promotion prevents", () => {
    const deadDataUri = "data:image/png;base64,ZGVhZC1kZXNjZW5kYW50";
    const unpromoted: CapturedElement = {
      tag: "svg",
      text: "",
      x: 12,
      y: 18,
      width: 140,
      height: 80,
      styles,
      svgContent: '<svg><rect id="live-clone" width="140" height="80"/></svg>',
      children: [
        {
          tag: "div",
          text: "",
          x: 20,
          y: 24,
          width: 30,
          height: 20,
          styles,
          transformSubtreeRaster: { x: 20, y: 24, width: 30, height: 20, dataUri: deadDataUri },
          children: [],
        },
      ],
    };

    const svg = elementTreeToSvg([unpromoted], 200, 120);
    expect(svg).toContain("live-clone");
    expect(svg).not.toContain(deadDataUri);
  });
});

describe("unowned projective matrix3d fails closed", () => {
  const persp = "matrix3d(0.642788, 0, 0.766044, -0.00383022, 0, 1, 0, 0, -0.766044, 0, 0.642788, 0, 0, 0, 0, 1)";
  const hostWith = (transform: string): CapturedElement =>
    ({
      tag: "div",
      text: "",
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      children: [],
      styles: { ...styles, transform, transformOrigin: "50px 25px" },
    }) as CapturedElement;

  it("hides the subtree and warns instead of painting a six-entry affine", () => {
    resetLastCaptureWarnings([]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const svg = elementTreeToSvg([hostWith(persp)], 200, 120);
    warn.mockRestore();
    expect(svg).toContain("display:none");
    expect(svg).not.toContain("matrix(0.64279");
    expect(getLastCaptureWarnings().some((w) => w.feature === "projective-transform")).toBe(true);
  });

  it("keeps an affine matrix3d as a visible vector transform", () => {
    resetLastCaptureWarnings([]);
    const svg = elementTreeToSvg([hostWith("matrix3d(2,0,0,0, 0,2,0,0, 0,0,1,0, 10,20,0,1)")], 200, 120);
    expect(svg).toContain("matrix(2 0 0 2 10 20)");
    expect(svg).not.toContain("display:none");
    expect(getLastCaptureWarnings().some((w) => w.feature === "projective-transform")).toBe(false);
  });
});

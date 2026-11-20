import { describe, expect, it } from "vitest";

import type { CapturedElement } from "../capture/types.js";
import { capturedElement, capturedStyles } from "../test-support/captured-fixtures.js";
import { elementTreeToSvgInner } from "./element-tree-to-svg.js";

const DATA_URI = "data:image/png;base64,ZnJvemVuLXNwYWNl";
const BASE_STYLES = {
  backgroundColor: "rgba(0, 0, 0, 0)",
  color: "rgb(0, 0, 0)",
  borderColor: "rgba(0, 0, 0, 0)",
  borderWidth: "0px",
  opacity: "1",
  filter: "none",
  mixBlendMode: "normal",
  transformOrigin: "0px 0px",
};

function host(raster: NonNullable<CapturedElement["nativeControlRaster"]>): CapturedElement {
  return capturedElement({
    tag: "input",
    text: "",
    x: 20,
    y: 20,
    width: 40,
    height: 20,
    children: [],
    nativeControlRaster: raster,
    styles: capturedStyles({ ...BASE_STYLES, transform: "none" }),
  });
}

function translated(child: CapturedElement): CapturedElement {
  return capturedElement({
    tag: "div",
    text: "",
    x: 20,
    y: 20,
    width: 100,
    height: 50,
    children: [child],
    styles: capturedStyles({
      ...BASE_STYLES,
      transform: "matrix(1, 0, 0, 1, 10.5, 10)",
      transformOrigin: "0px 0px",
      opacity: "1",
      backgroundColor: "rgba(0, 0, 0, 0)",
    }),
  });
}

describe("frozen-transform raster placement", () => {
  it("counter-maps a viewport-space crop by the CTM open at its emission", () => {
    const svg = elementTreeToSvgInner(
      [translated(host({ x: 29.5, y: 29, width: 42, height: 22, dataUri: DATA_URI, viewportSpace: true }))],
      200,
      100,
    );
    expect(svg).toContain(`<g transform="matrix(1 0 0 1 -10.5 -10)"><image href="${DATA_URI}" x="29.5" y="29"`);
  });

  it("keeps a local crop inside the wrapper without a counter-map", () => {
    const svg = elementTreeToSvgInner(
      [translated(host({ x: 19, y: 19, width: 42, height: 22, dataUri: DATA_URI }))],
      200,
      100,
    );
    expect(svg).toContain(`<image href="${DATA_URI}" x="19" y="19"`);
    expect(svg).not.toContain("matrix(1 0 0 1 -10.5 -10)");
  });

  it("places a viewport-space crop directly when nothing is frozen", () => {
    const svg = elementTreeToSvgInner(
      [host({ x: 19, y: 19, width: 42, height: 22, dataUri: DATA_URI, viewportSpace: true })],
      200,
      100,
    );
    expect(svg).toContain(`<image href="${DATA_URI}" x="19" y="19"`);
    expect(svg).not.toMatch(/<g transform="matrix\(/);
  });
});

import { describe, expect, it } from "vitest";
import { elementTreeToSvgInner } from "./element-tree-to-svg.js";
import { capturedElement } from "../test-support/captured-fixtures.js";

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
function imageTag(fit: string, decoded: boolean, imageSrc = png): string {
  const image = capturedElement({
    tag: "img",
    text: "",
    children: [],
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    imageSrc,
    imageIntrinsic: { w: 60, h: 40 },
    ...(decoded ? { imageDecodedIntrinsic: { w: 120, h: 100 } } : {}),
    styles: {
      backgroundColor: "transparent",
      color: "black",
      borderColor: "black",
      objectFit: fit,
      objectPosition: "25% 75%",
    },
  });
  return elementTreeToSvgInner([image], 200, 100);
}

describe("decoded resource ratio paint authority", () => {
  it.each(["contain", "cover"])("uses the native decoded ratio for %s", (fit) => {
    expect(imageTag(fit, true)).not.toEqual(imageTag(fit, false));
    const sameRatio = capturedElement({
      tag: "img",
      text: "",
      children: [],
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      imageSrc: png,
      imageIntrinsic: { w: 120, h: 100 },
      styles: {
        backgroundColor: "transparent",
        color: "black",
        borderColor: "black",
        objectFit: fit,
        objectPosition: "25% 75%",
      },
    });
    expect(imageTag(fit, true)).toEqual(elementTreeToSvgInner([sameRatio], 200, 100));
  });
  it.each(["none", "scale-down", "fill"])("preserves density-sensitive/ratio-free %s semantics", (fit) => {
    expect(imageTag(fit, true)).toEqual(imageTag(fit, false));
  });
  it("keeps SVG natural sizing ahead of decoded raster-size facts", () => {
    const svg = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><rect width="400" height="100" fill="red"/></svg>')}`;
    expect(imageTag("contain", true, svg)).toEqual(imageTag("contain", false, svg));
  });
});

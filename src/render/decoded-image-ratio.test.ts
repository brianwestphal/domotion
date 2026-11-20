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
  it.each(["none", "fill"])("keeps decoded size out of density-sensitive/ratio-free %s geometry", (fit) => {
    expect(imageTag(fit, true)).toEqual(imageTag(fit, false));
  });
  it("sizes scale-down from the decoded resource, as Blink reverts srcset density", () => {
    // Decoded 120x100 in a 200x100 box: contain would be 120x100, which is not
    // larger than the decoded size, so the reverted size paints.
    const tag = imageTag("scale-down", true);
    expect(tag).not.toEqual(imageTag("scale-down", false));
    expect(tag).toContain('width="120"');
    expect(tag).toContain('height="100"');
  });
  it("paints object-fit:none at the fractional responsive natural size when captured", () => {
    const natural = (layout?: { w: number; h: number }) =>
      elementTreeToSvgInner(
        [
          capturedElement({
            tag: "img",
            text: "",
            children: [],
            x: 0,
            y: 0,
            width: 300,
            height: 300,
            imageSrc: png,
            imageIntrinsic: { w: 389, h: 572 },
            imageDecodedIntrinsic: { w: 396, h: 581 },
            ...(layout != null ? { imageLayoutNatural: layout } : {}),
            styles: {
              backgroundColor: "transparent",
              color: "black",
              borderColor: "black",
              objectFit: "none",
              objectPosition: "50% 50%",
            },
          }),
        ],
        300,
        300,
      );
    const legacy = natural();
    const exact = natural({ w: 389.984375, h: 572.1875 });
    expect(legacy).toContain('width="389"');
    expect(exact).toContain('width="390"');
    expect(exact).toContain('height="572.2"');
    expect(exact).toContain('x="-45"');
    // The decoded physical size never leaks into none.
    expect(exact).not.toContain('width="396"');
  });
  it("ignores the responsive natural size outside object-fit:none", () => {
    for (const fit of ["contain", "cover", "scale-down", "fill"]) {
      const base = capturedElement({
        tag: "img",
        text: "",
        children: [],
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        imageSrc: png,
        imageIntrinsic: { w: 60, h: 40 },
        styles: { backgroundColor: "transparent", color: "black", borderColor: "black", objectFit: fit },
      });
      expect(elementTreeToSvgInner([{ ...base, imageLayoutNatural: { w: 33.5, h: 77.25 } }], 200, 100)).toEqual(
        elementTreeToSvgInner([base], 200, 100),
      );
    }
  });
  it("keeps SVG natural sizing ahead of decoded raster-size facts", () => {
    const svg = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><rect width="400" height="100" fill="red"/></svg>')}`;
    expect(imageTag("contain", true, svg)).toEqual(imageTag("contain", false, svg));
  });
});

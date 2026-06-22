import { describe, expect, it } from "vitest";
import { elementTreeToSvgInner } from "./element-tree-to-svg.js";
import type { CapturedElement } from "../capture/types.js";

// DM-1239: `object-fit: scale-down` = the smaller of `none` and `contain`. With
// the captured <img> intrinsic size we now resolve it concretely: an image that
// fits the content box renders at intrinsic size (like `none`); a larger one is
// shrunk like `contain`. Previously scale-down always behaved as `contain`.

const STYLES = {
  backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none", backgroundSize: "auto",
  backgroundPosition: "0% 0%", backgroundRepeat: "repeat", backgroundClip: "border-box",
  backgroundOrigin: "padding-box", backgroundAttachment: "scroll",
  borderColor: "rgb(0,0,0)", borderWidth: "0", borderRadius: "0",
  borderTopLeftRadius: "0", borderTopRightRadius: "0", borderBottomRightRadius: "0", borderBottomLeftRadius: "0",
  borderTopWidth: "0", borderRightWidth: "0", borderBottomWidth: "0", borderLeftWidth: "0",
  borderTopColor: "rgb(0,0,0)", borderRightColor: "rgb(0,0,0)", borderBottomColor: "rgb(0,0,0)", borderLeftColor: "rgb(0,0,0)",
  borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none",
  color: "rgb(0,0,0)", fontSize: "16px", fontFamily: "sans-serif", fontWeight: "400", fontStyle: "normal",
  lineHeight: "20px", letterSpacing: "normal", textAlign: "left", textTransform: "none",
  whiteSpace: "normal", direction: "ltr", writingMode: "horizontal-tb",
  overflowX: "visible", overflowY: "visible", opacity: "1", transform: "none", transformOrigin: "50% 50%", visibility: "visible",
  objectFit: "scale-down", objectPosition: "50% 50%", display: "inline",
  paddingTop: "0", paddingRight: "0", paddingBottom: "0", paddingLeft: "0", position: "static",
} as unknown as CapturedElement["styles"];

// 1×1 transparent PNG — a valid data URI embedResizedDataUri can pass through.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

function img(intrinsic: { w: number; h: number }): CapturedElement {
  return {
    tag: "img", text: "", x: 0, y: 0, width: 200, height: 100, children: [],
    imageSrc: PNG, imageIntrinsic: intrinsic,
    styles: STYLES,
  } as unknown as CapturedElement;
}
const imageTag = (svg: string): string => /<image\b[^>]*>/.exec(svg)?.[0] ?? "";

describe("object-fit: scale-down (DM-1239)", () => {
  it("renders an image that fits the content box at intrinsic size (like `none`)", () => {
    const tag = imageTag(elementTreeToSvgInner([img({ w: 60, h: 40 })], 200, 100));
    expect(tag).toContain('width="60"');
    expect(tag).toContain('height="40"');
    expect(tag).toContain('preserveAspectRatio="none"'); // intrinsic-size branch
  });

  it("shrinks an image larger than the content box like `contain`", () => {
    const tag = imageTag(elementTreeToSvgInner([img({ w: 400, h: 300 })], 200, 100));
    // contain → image laid into the content box (200×100) with a meet PAR.
    expect(tag).toContain('width="200"');
    expect(tag).toContain('height="100"');
    expect(tag).toMatch(/preserveAspectRatio="[^"]*meet"/);
  });

  it("falls back to contain when intrinsic size is unknown (broken / unloaded)", () => {
    const el = img({ w: 60, h: 40 });
    delete (el as { imageIntrinsic?: unknown }).imageIntrinsic;
    const tag = imageTag(elementTreeToSvgInner([el], 200, 100));
    expect(tag).toMatch(/preserveAspectRatio="[^"]*meet"/); // contain fallback, not intrinsic
  });
});

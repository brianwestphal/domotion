import { describe, expect, it } from "vitest";
import { decodeDataUriText, parseDataUri } from "./data-uri.js";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg"><text>café ✓</text></svg>`;
const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

describe("parseDataUri (Fetch data: URL processor)", () => {
  it("decodes base64 and percent-encoded bodies to the same bytes", () => {
    expect(decodeDataUriText(`data:image/svg+xml;base64,${b64(SVG)}`)).toBe(SVG);
    expect(decodeDataUriText(`data:image/svg+xml,${encodeURIComponent(SVG)}`)).toBe(SVG);
    expect(decodeDataUriText(`data:image/svg+xml;utf8,${SVG}`)).toBe(SVG);
  });

  it("accepts media-type parameters before ;base64", () => {
    const parsed = parseDataUri(`data:image/SVG+xml; charset=utf-8 ;base64,${b64(SVG)}`);
    expect(parsed?.mime).toBe("image/svg+xml");
    expect(parsed?.params).toEqual(["charset=utf-8"]);
    expect(parsed?.base64).toBe(true);
    expect(parsed?.bytes.toString("utf8")).toBe(SVG);
  });

  it("treats base64 as an encoding only when it is the last metadata piece", () => {
    expect(parseDataUri("data:text/plain;base64;charset=utf-8,aGk=")?.base64).toBe(false);
    expect(parseDataUri("data:text/plain;BASE64 ,aGk=")?.bytes.toString()).toBe("hi");
    expect(parseDataUri("data:text/plain;base64x,aGk=")?.base64).toBe(false);
  });

  it("defaults an empty media type to text/plain", () => {
    expect(parseDataUri("data:,hello")).toMatchObject({ mime: "text/plain", params: ["charset=US-ASCII"] });
    expect(parseDataUri("data:;charset=utf-8,hello")).toMatchObject({ mime: "text/plain", params: ["charset=utf-8"] });
    expect(parseDataUri("data:;base64,aGk=")?.bytes.toString()).toBe("hi");
  });

  it("percent-decodes leniently instead of throwing", () => {
    expect(parseDataUri("data:text/plain,100%25 and 50% off %zz")?.bytes.toString()).toBe("100% and 50% off %zz");
    expect(parseDataUri("data:text/plain,%")?.bytes.toString()).toBe("%");
  });

  it("decodes base64 forgivingly (whitespace, missing padding) and rejects invalid input", () => {
    expect(parseDataUri("data:text/plain;base64,aG k\n=")?.bytes.toString()).toBe("hi");
    expect(parseDataUri("data:text/plain;base64,aGk")?.bytes.toString()).toBe("hi");
    expect(parseDataUri("data:text/plain;base64,aGk%3D")?.bytes.toString()).toBe("hi");
    expect(parseDataUri("data:text/plain;base64,a")).toBeNull();
    expect(parseDataUri("data:text/plain;base64,a=b=")).toBeNull();
    expect(parseDataUri("data:text/plain;base64,aGk!")).toBeNull();
  });

  it("returns null for non-data URLs and a missing comma", () => {
    expect(parseDataUri("https://example.test/a.svg")).toBeNull();
    expect(parseDataUri("data:image/png;base64")).toBeNull();
    expect(decodeDataUriText("file:///a.svg")).toBeNull();
  });

  it("is case-insensitive in the scheme", () => {
    expect(parseDataUri("DATA:text/plain,x")?.bytes.toString()).toBe("x");
  });
});

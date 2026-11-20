import { describe, expect, it } from "vitest";
import {
  faceRuleFromFontsUpdatedFace,
  fontsUpdatedFaceFromPayload,
  joinFontsUpdatedFaces,
  type DocumentFontFace,
  type FontsUpdatedFace,
} from "./fonts-updated-faces.js";

const event = (family: string, src: string, over: Partial<FontsUpdatedFace> = {}): FontsUpdatedFace => ({
  fontFamily: family,
  fontStyle: "normal",
  fontWeight: "normal",
  fontStretch: "normal",
  unicodeRange: "U+0-10FFFF",
  src,
  ...over,
});
const doc = (family: string, over: Partial<DocumentFontFace> = {}): DocumentFontFace => ({
  family,
  style: "normal",
  weight: "normal",
  stretch: "normal",
  unicodeRange: "U+0-10FFFF",
  status: "loaded",
  ...over,
});

describe("fontsUpdatedFaceFromPayload", () => {
  it("drops font-less refresh events and malformed payloads", () => {
    expect(fontsUpdatedFaceFromPayload(undefined)).toBeNull();
    expect(fontsUpdatedFaceFromPayload({ fontFamily: "A" })).toBeNull();
    expect(fontsUpdatedFaceFromPayload(event("A", "u"))).toEqual(event("A", "u"));
  });
});

describe("joinFontsUpdatedFaces", () => {
  it("keeps only events with a loaded document.fonts face of the same family and descriptors", () => {
    const join = joinFontsUpdatedFaces(
      [event("Added", "a"), event("Unadded", "b"), event("Pending", "c"), event("Added", "d", { fontWeight: "700" })],
      [doc("Added"), doc("Pending", { status: "loading" })],
    );
    expect(join.matched.map((e) => e.src)).toEqual(["a"]);
    expect(join.unmatched.map((e) => e.src)).toEqual(["b", "c", "d"]);
    expect(join.ambiguous).toEqual([]);
  });

  it("decodes FontFace.family's quoted serialization before comparing", () => {
    const join = joinFontsUpdatedFaces(
      [event("Js Fam", "a"), event('"Quoted"', "b")],
      [doc('"Js Fam"'), doc('"\\"Quoted\\""')],
    );
    expect(join.matched.map((e) => e.src)).toEqual(["a", "b"]);
  });

  it("marks a tuple ambiguous when it has more distinct sources than loaded faces", () => {
    // One face was added, a second with the same descriptors was loaded but not
    // added; nothing says which URL is the added one.
    const join = joinFontsUpdatedFaces([event("F", "a"), event("F", "b")], [doc("F")]);
    expect(join.matched).toEqual([]);
    expect(join.ambiguous.map((e) => e.src)).toEqual(["a", "b"]);
    const both = joinFontsUpdatedFaces([event("F", "a"), event("F", "b")], [doc("F"), doc("F")]);
    expect(both.matched.map((e) => e.src)).toEqual(["a", "b"]);
  });

  it("treats repeated events for one source and tuple as one face", () => {
    // A page that navigates again reloads the same face.
    const join = joinFontsUpdatedFaces([event("F", "a"), event("F", "a")], [doc("F")]);
    expect(join.matched.map((e) => e.src)).toEqual(["a"]);
  });

  it("never merges URL-less (ArrayBuffer) events", () => {
    const join = joinFontsUpdatedFaces([event("F", ""), event("F", "")], [doc("F")]);
    expect(join.ambiguous).toHaveLength(2);
  });
});

describe("faceRuleFromFontsUpdatedFace", () => {
  it("carries the authored family and descriptor text", () => {
    expect(
      faceRuleFromFontsUpdatedFace(
        event("Api", "https://x/f.woff2", {
          fontWeight: "600 800",
          fontStyle: "oblique 0deg 12deg",
          fontStretch: "75% 125%",
          unicodeRange: "U+0-7F",
        }),
      ),
    ).toEqual({
      kind: "font-face",
      family: "Api",
      weight: "600 800",
      style: "oblique 0deg 12deg",
      styleDesc: "oblique 0deg 12deg",
      url: "https://x/f.woff2",
      urls: ["https://x/f.woff2"],
      source: "fonts-updated",
      unicodeRange: [[0, 0x7f]],
      stretch: "75% 125%",
    });
  });

  it("has nothing to fetch for an ArrayBuffer source", () => {
    expect(faceRuleFromFontsUpdatedFace(event("Buf", ""))).toBeNull();
  });
});

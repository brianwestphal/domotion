import { describe, expect, it } from "vitest";
import { fontHasSupportedColorTable } from "./font-resolution.js";

const face = (...tags: string[]) => ({
  directory: { tables: Object.fromEntries(tags.map((tag) => [tag, {}])) },
});

describe("TypefaceHasAnySupportedColorTable transcription", () => {
  it("accepts sbix by itself", () => {
    expect(fontHasSupportedColorTable(face("sbix"))).toBe(true);
  });

  it("requires both members of the COLR/CPAL and CBDT/CBLC pairs", () => {
    expect(fontHasSupportedColorTable(face("COLR", "CPAL"))).toBe(true);
    expect(fontHasSupportedColorTable(face("CBDT", "CBLC"))).toBe(true);
    for (const tag of ["COLR", "CPAL", "CBDT", "CBLC"]) {
      expect(fontHasSupportedColorTable(face(tag)), tag).toBe(false);
    }
  });

  it("does not infer color capability from an author-controlled family name", () => {
    expect(fontHasSupportedColorTable(face("glyf"), "webfont:noto color emoji impostor")).toBe(false);
  });

  it("retains the platform-family fallback only when a native face has no directory", () => {
    expect(fontHasSupportedColorTable({}, "sysfb:AppleColorEmoji")).toBe(true);
    expect(fontHasSupportedColorTable({}, "sysfb:ordinary-face")).toBe(false);
  });
});

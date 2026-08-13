import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const helperSource = readFileSync(resolve(
  "tools/macos-glyph-extractor/Sources/DomotionGlyphPaths/main.swift",
), "utf8");

describe("macOS helper request-scoped font contract", () => {
  it("does not read or populate the persistent cache for a request-scoped base", () => {
    expect(helperSource).toContain("if !requestScoped, let cached = fontCache[key]");
    expect(helperSource).toContain("if !requestScoped { fontCache[key] = entry }");
  });

  it("opens in-memory webfont data for an identical CoreText cascade base", () => {
    expect(helperSource).toContain('spec["fontData"] as? String');
    expect(helperSource).toContain("CTFontManagerCreateFontDescriptorsFromData");
  });
});

describe("macOS helper protected-name contract", () => {
  it("does not send a dot-prefixed file miss through the doomed by-name rescue", () => {
    expect(helperSource).toContain(
      'if !pickedNameMatch, let name = postscriptName, !name.hasPrefix(".")',
    );
  });

  it("rejects a name-only protected face before CoreText can substitute", () => {
    expect(helperSource).toContain('if name.hasPrefix(".")');
    expect(helperSource).toContain("protected system PostScript name");
  });
});

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
});

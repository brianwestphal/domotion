import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (name: string): string =>
  readFileSync(new URL(name, import.meta.url), "utf8");

describe("native glyph-helper module boundaries", () => {
  it("keeps transport, adapter, outline, and Linux strike ownership separate", () => {
    const facade = source("glyph-helper.ts");
    const transport = source("glyph-helper-transport.ts");
    const protocol = source("glyph-helper-protocol.ts");
    const outline = source("glyph-helper-outline.ts");
    const adapter = source("glyph-helper-font.ts");
    const strike = source("linux-target-strike.ts");

    expect(facade).not.toContain("node:child_process");
    expect(facade).not.toContain("const linuxTargetStrikeCache");
    expect(facade).not.toContain("function createGlyphHelperFont");

    expect(transport).toContain('from "node:child_process"');
    expect(transport).toContain("export function clearGlyphHelperTransport");
    expect(protocol).toContain("export interface HelperRequest");
    expect(outline).toContain("export function parseSvgPath");
    expect(adapter).toContain("export function createGlyphHelperFont");
    expect(strike).toContain("const linuxTargetStrikeCache");
  });
});

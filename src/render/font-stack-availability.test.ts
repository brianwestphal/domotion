import { describe, expect, it } from "vitest";
import { withHostPlatform } from "./host-platform.js";
import { resolveFont } from "./font-resolution.js";

describe("CSS family-stack availability", () => {
  it("continues after a recognized family has no loadable host face (DM-2275)", () => {
    const face = withHostPlatform("linux", () =>
      resolveFont('"Playfair Display", Times, serif', 400, 32));

    expect(face).not.toBeNull();
    expect(face?.postscriptName?.toLowerCase()).toContain("times");
  });
});

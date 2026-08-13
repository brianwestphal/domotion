import { describe, expect, it } from "vitest";
import { CROSS_ORIGIN_PAGE, INNER_CARD } from "../examples/iframe-recursion.js";

describe("iframe recursion example fixtures", () => {
  it("uses explicit deterministic sans-serif stacks in both frame documents", () => {
    for (const html of [INNER_CARD, CROSS_ORIGIN_PAGE]) {
      expect(html).toContain("font-family:Arial,sans-serif");
      expect(html).not.toContain("-apple-system");
      expect(html).not.toContain("'Segoe UI'");
    }
  });

  it("keeps the cross-origin scene self-contained and visually substantive", () => {
    expect(CROSS_ORIGIN_PAGE).toContain("Orbit Analytics");
    expect(CROSS_ORIGIN_PAGE).toContain("Monthly recurring revenue");
    expect(CROSS_ORIGIN_PAGE).not.toMatch(/https?:\/\//);
    expect(CROSS_ORIGIN_PAGE).not.toContain("<img");
  });
});

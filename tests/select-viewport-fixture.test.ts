import { expect, it } from "vitest";
import { resolveSelectViewportScroll } from "./select-viewport-fixture.js";

it("keeps the same viewport precondition across upstream layout and existing-scroll differences", () => {
  // Actual retained Windows and macOS source positions differ by 37px.
  for (const top of [451, 414]) {
    const next = resolveSelectViewportScroll(900, { top, height: 44 }, 727, "bottom");
    const viewportTop = top + 727 - next;
    expect(viewportTop).toBe(384);
    expect(900 - viewportTop - 44 - viewportTop).toBe(88);
    expect(next).toBeGreaterThan(0);
  }
  expect(resolveSelectViewportScroll(900, { top: 451, height: 44 }, 727, "bottom")).toBe(
    resolveSelectViewportScroll(900, { top: 1178, height: 44 }, 0, "bottom"),
  );
});

it("inverts available space for the real top-placement negative control", () => {
  const next = resolveSelectViewportScroll(900, { top: 451, height: 44 }, 727, "top");
  const viewportTop = 451 + 727 - next;
  expect(viewportTop).toBe(472);
  expect(viewportTop - (900 - viewportTop - 44)).toBe(88);
  // Fractional native trigger dimensions still select the intended side after
  // integer document-scroll rounding; no platform font constants are involved.
  const fractional = resolveSelectViewportScroll(1300, { top: 578.25, height: 43.5 }, 600, "bottom");
  const positioned = 1178.25 - fractional;
  expect(1300 - positioned - 43.5).toBeGreaterThan(positioned);
});

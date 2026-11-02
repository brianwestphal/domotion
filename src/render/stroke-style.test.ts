import { describe, expect, it } from "vitest";
import {
  closedDashArray,
  DOUBLE_MIN_WIDTH,
  DOT_EPSILON,
  isThinDotted,
  openDashArray,
  THIN_DOTTED_MAX_WIDTH,
} from "./stroke-style.js";

describe("shared Blink stroke geometry", () => {
  it("fits open dashed sides and closed contours with the same thickness rules", () => {
    expect(openDashArray("dashed", 2, 4)).toBe("");
    expect(openDashArray("dashed", 2, 13)).toBe("4.875 3.25");
    expect(openDashArray("dashed", 2, 16)).toBe("6 4");
    expect(closedDashArray("dashed", 2, 12)).toBe("");
    expect(closedDashArray("dashed", 2, 20)).toBe("6 4");
    expect(openDashArray("dashed", 3, 18)).toBe("6 6");
  });

  it("keeps thin dots square and thick dots round with the endpoint epsilon", () => {
    expect(isThinDotted(THIN_DOTTED_MAX_WIDTH)).toBe(true);
    expect(isThinDotted(3.6)).toBe(false);
    expect(openDashArray("dotted", 2, 40)).toBe("2 2");
    expect(closedDashArray("dotted", 2, 40)).toBe("2 2");
    expect(openDashArray("dotted", 5, 8)).toBe("0.01 9.99");
    expect(openDashArray("dotted", 5, 30)).toContain(`${DOT_EPSILON} `);
    // Blink's thick-dotted interval is {0, gap + width - kEpsilon}: the 4px
    // side of length 100 fits 13 dots with gap 4, so the period is 7.99 and the
    // 13th dot lands 0.12px inside the line end instead of exactly on it.
    const [dash, gap] = openDashArray("dotted", 4, 100).split(" ").map(Number);
    expect(dash).toBe(DOT_EPSILON);
    expect(dash + gap).toBeCloseTo(7.99, 9);
    expect(DOUBLE_MIN_WIDTH).toBe(3);
  });

  it("omits dash attributes for unstyled and empty paths", () => {
    expect(openDashArray("solid", 2, 30)).toBe("");
    expect(closedDashArray("double", 2, 30)).toBe("");
    expect(openDashArray("dashed", 2, 0)).toBe("");
  });
});

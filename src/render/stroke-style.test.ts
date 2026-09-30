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
    expect(openDashArray("dashed", 2, 13)).toBe("4.9 3.3");
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
    expect(openDashArray("dotted", 5, 8)).toBe("0.01 10");
    expect(openDashArray("dotted", 5, 30)).toContain(`${DOT_EPSILON} `);
    expect(DOUBLE_MIN_WIDTH).toBe(3);
  });

  it("omits dash attributes for unstyled and empty paths", () => {
    expect(openDashArray("solid", 2, 30)).toBe("");
    expect(closedDashArray("double", 2, 30)).toBe("");
    expect(openDashArray("dashed", 2, 0)).toBe("");
  });
});

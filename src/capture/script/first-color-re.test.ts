import { describe, expect, it } from "vitest";
import { firstColorRe } from "./utils.js";

// DM-1236: the background-shorthand color extractor used to match only 9 popular
// named colors, dropping the color layer for any other spec-valid name. It now
// covers the full CSS Color 4 named-color set (mirrors render-side NAMED_COLORS).
const firstColor = (s: string): string | null => { const m = s.match(firstColorRe); return m ? m[1] : null; };

describe("firstColorRe (DM-1236)", () => {
  it("extracts extended named colors out of a background shorthand", () => {
    expect(firstColor("rebeccapurple linear-gradient(90deg, red, blue)")).toBe("rebeccapurple");
    expect(firstColor("cornflowerblue url(x.png)")).toBe("cornflowerblue");
    expect(firstColor("darkslategray")).toBe("darkslategray");
  });

  it("does not mis-match a longer name as a shorter one (darkgray ≠ gray)", () => {
    expect(firstColor("darkgray url(x.png)")).toBe("darkgray");
    expect(firstColor("lightgreen")).toBe("lightgreen");
  });

  it("still handles hex / rgba / hsla / currentColor / the original common names", () => {
    expect(firstColor("#1a2b3c url(x)")).toBe("#1a2b3c");
    expect(firstColor("rgba(1, 2, 3, 0.5) linear-gradient(red, blue)")).toBe("rgba(1, 2, 3, 0.5)");
    expect(firstColor("hsl(200, 50%, 40%)")).toBe("hsl(200, 50%, 40%)");
    expect(firstColor("currentColor")).toBe("currentColor");
    expect(firstColor("red")).toBe("red");
  });

  it("returns null when the shorthand carries no color layer", () => {
    expect(firstColor("url(x.png) repeat")).toBeNull();
    expect(firstColor("linear-gradient(45deg, var(--a), var(--b))")).toBeNull();
  });
});

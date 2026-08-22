import { describe, expect, it } from "vitest";
import { wrapPseudoPaintEffects } from "./pseudo-filter.js";

const box = { x: 10, y: 20, width: 80, height: 40 };

describe("wrapPseudoPaintEffects", () => {
  it("leaves an unfiltered pseudo paint unchanged", () => {
    expect(wrapPseudoPaintEffects({ ...box, filter: "none" }, "<rect/>"))
      .toBe("<rect/>");
  });

  it.each([
    "blur(0px)",
    "brightness(1.25)",
    "contrast(0.7)",
    "drop-shadow(rgb(10, 20, 30) 2px 3px 4px)",
    "grayscale(0.4)",
    "hue-rotate(47deg)",
    "invert(0.25)",
    "opacity(1)",
    "saturate(2.2)",
    "sepia(0.8)",
  ])("preserves the computed CSS function %s", (filter) => {
    const result = wrapPseudoPaintEffects({ ...box, filter }, "<rect/>");
    expect(result).toBe(`<g style="filter:${filter}"><rect/></g>`);
    expect(result).not.toContain("<fe");
  });

  it("preserves function-list order and escaped CSS attribute text", () => {
    const first = "opacity(0.35) drop-shadow(rgb(0, 0, 0) 2px 4px 3px)";
    const second = "drop-shadow(rgb(0, 0, 0) 2px 4px 3px) opacity(0.35)";
    expect(wrapPseudoPaintEffects({ ...box, filter: first }, "<path/>")).toContain(first);
    expect(wrapPseudoPaintEffects({ ...box, filter: second }, "<path/>")).toContain(second);
    expect(
      wrapPseudoPaintEffects({ ...box, filter: 'url("#a&b")' }, "<path/>"),
    ).toContain("url(&quot;#a&amp;b&quot;)");
  });

  it("nests filter inside transform inside opacity", () => {
    expect(
      wrapPseudoPaintEffects(
        {
          ...box,
          filter: "blur(2px) saturate(1.4)",
          transform: "rotate(12deg)",
          transformOrigin: "5px 7px",
          opacity: 0.6,
        },
        "<rect/>",
      ),
    ).toBe(
      '<g opacity="0.6"><g transform="translate(15 27) rotate(12deg) translate(-15 -27)"><g style="filter:blur(2px) saturate(1.4)"><rect/></g></g></g>',
    );
  });

  it("does not round captured group opacity", () => {
    expect(wrapPseudoPaintEffects({ ...box, opacity: 0.45 }, "<rect/>"))
      .toBe('<g opacity="0.45"><rect/></g>');
  });

  it("uses the border-box center for an unavailable transform origin", () => {
    expect(
      wrapPseudoPaintEffects(
        { ...box, transform: "scale(2)", transformOrigin: "not-resolved" },
        "<rect/>",
      ),
    ).toBe(
      '<g transform="translate(50 40) scale(2) translate(-50 -40)"><rect/></g>',
    );
  });

  it("retains identity filters because they still establish an effect node", () => {
    expect(wrapPseudoPaintEffects({ ...box, filter: "blur(0px)" }, "<rect/>"))
      .not.toBe("<rect/>");
    expect(wrapPseudoPaintEffects({ ...box, filter: "opacity(1)" }, "<rect/>"))
      .not.toBe("<rect/>");
  });
});

import { describe, expect, it } from "vitest";
import {
  complexSpecificity,
  decideHas,
  matchesSelectorList,
  parseImageElementTree,
  parseSelectorList,
  type ImageElement,
} from "./svg-image-selector-engine.js";

const DOC = `<?xml version="1.0"?><!-- c --><!DOCTYPE svg [ <!ENTITY e "x"> ]>
<svg xmlns="http://www.w3.org/2000/svg" class="r">
  <g class="dark" id="g1"><rect id="a" data-k="A b"/><circle/></g>
  <foreignObject/>
  <text><![CDATA[hi]]></text>
  <path class="&e;"/>
  <g id="empty"></g>
</svg>`;

const tree = (): ImageElement => parseImageElementTree(DOC)!;
const byId = (root: ImageElement, id: string): ImageElement => {
  const stack = [root];
  while (stack.length > 0) {
    const el = stack.pop()!;
    if (el.attributes.get("id") === id) return el;
    stack.push(...el.children);
  }
  throw new Error(id);
};

describe("parseImageElementTree", () => {
  it("builds the element tree, skipping the prolog, comments and doctype", () => {
    const root = tree();
    expect(root.name).toBe("svg");
    expect(root.children.map((c) => c.name)).toEqual(["g", "foreignObject", "text", "path", "g"]);
    expect(root.children[0].children.map((c) => c.attributes.get("id") ?? null)).toEqual(["a", null]);
    expect(byId(root, "a").attributes.get("data-k")).toBe("A b");
    // A DTD-defined entity leaves the value unknown.
    expect(root.children[3].attributes.get("class")).toBeNull();
    expect(root.children[2].texts).toEqual(["hi"]);
  });

  it("rejects markup that is not a well-formed element tree", () => {
    expect(parseImageElementTree("<svg><g></svg>")).toBeNull();
    expect(parseImageElementTree("<svg/><svg/>")).toBeNull();
  });
});

describe("matching against the image DOM", () => {
  const m = (el: ImageElement, sel: string, root: ImageElement): boolean | null =>
    matchesSelectorList(el, parseSelectorList(sel)!, root);

  it("handles every combinator and compound", () => {
    const root = tree();
    const a = byId(root, "a");
    expect(m(a, "svg > g rect", root)).toBe(true);
    expect(m(a, "svg > rect", root)).toBe(false);
    expect(m(a, ".dark > #a[data-k~=b]", root)).toBe(true);
    expect(m(a.parent!.children[1], "rect + circle", root)).toBe(true);
    expect(m(root.children[4], "g ~ g:last-child", root)).toBe(true);
    expect(m(root.children[4], ":empty", root)).toBe(true);
    // Whitespace text makes an element non-empty in Blink.
    expect(m(root, ":empty", root)).toBe(false);
    expect(m(root.children[1], "foreignobject", root)).toBe(false);
    expect(m(root.children[1], "foreignObject:nth-child(2):nth-last-of-type(1)", root)).toBe(true);
    expect(m(a, ":root rect:is(:first-child):not(:hover)", root)).toBe(true);
    // A DTD-defined class list is unknown.
    expect(m(root.children[3], ".x", root)).toBeNull();
  });

  it("rejects what it cannot decide", () => {
    expect(parseSelectorList("rect::before")).toBeNull();
    expect(parseSelectorList("svg|rect")).toBeNull();
    expect(parseSelectorList("rect:lang(en)")).toBeNull();
    expect(parseSelectorList("svg:has(g:has(rect))")).toBeNull();
  });
});

describe("decideHas", () => {
  it("matches relative selectors from the anchor", () => {
    const root = tree();
    expect(decideHas("> g.dark", root, root)).toEqual({ match: true, specificity: [0, 1, 1] });
    expect(decideHas("> rect", root, root)?.match).toBe(false);
    expect(decideHas("rect", root, root)?.match).toBe(true);
    expect(decideHas("g > circle, #zzz", root, root)).toEqual({ match: true, specificity: [1, 0, 0] });
    // The document element has no siblings.
    expect(decideHas("+ g", root, root)?.match).toBe(false);
    expect(decideHas("~ *", root, root)?.match).toBe(false);
    // `:root` is never a descendant of itself.
    expect(decideHas(":root", root, root)?.match).toBe(false);
    expect(decideHas("> g > rect + circle", root, root)?.match).toBe(true);
    expect(decideHas("> g rect + rect", root, root)?.match).toBe(false);
    expect(decideHas("path.zz", root, root)).toBeNull();
  });

  it("counts :has() specificity as its most specific argument", () => {
    expect(complexSpecificity(parseSelectorList("svg:has(> g.dark, #a)")![0])).toEqual([1, 0, 1]);
  });
});

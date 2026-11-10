import { describe, expect, it } from "vitest";
import { cascadeRootStylesheetTransform } from "./svg-image-root-stylesheet.js";
import { IMAGE_ROOT_ATTR } from "./svg-image-style-scope.js";
import { inlineImgSvg, flattenImgSvg, readSvgOpeningTag } from "./svg-inline.js";
import { resolveImageNamespace } from "./svg-image-namespace.js";

it("retains image fallback for geometricPrecision metric transforms in all root declaration sources", () => {
  const placement = { x: 0, y: 0, w: 100, h: 100, par: "none", documentViewport: true, idPrefix: "rendering-" };
  for (const source of [
    `<svg width="100" height="100" text-rendering="geometricPrecision" style="transform:translateY(1lh)"/>`,
    `<svg width="100" height="100" style="text-rendering:geometricPrecision;transform:translateY(1lh)"/>`,
    `<svg width="100" height="100"><style>svg{text-rendering:geometricPrecision;transform:translateY(1lh)}</style></svg>`,
  ]) {
    expect(inlineImgSvg(source, placement)).toBeNull();
    expect(flattenImgSvg(source, placement)).toBeNull();
  }
});

function cascade(
  svg: string,
  viewport: { w: number; h: number } | null = null,
  preferredColorScheme: "light" | "dark" | null = null,
) {
  const tag = readSvgOpeningTag(svg)!;
  const attributes = [...tag.attributes.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m): [string, string] => [m[1], m[2]]);
  const attr = (name: string): string | null => attributes.find(([n]) => n === name)?.[1] ?? null;
  return cascadeRootStylesheetTransform(
    svg,
    tag.end,
    { tag: tag.name, id: attr("id"), className: attr("class"), attributes },
    viewport,
    { preferredColorScheme },
  );
}

const valueOf = (r: ReturnType<typeof cascade>, prop: string): string | undefined =>
  r != null && r !== "unsupported" ? r.declarations.get(prop)?.value : undefined;

describe("cascadeRootStylesheetTransform", () => {
  it("cascades root font declarations without removing them from the sheet", () => {
    const r = cascade(
      `<svg id="r"><style>@font-face { font-family: Face; src: local(Arial) } ` +
        `svg { font-family: serif; font-size: 24px; font-weight: 500; font-style: italic; line-height: 36px } ` +
        `#r { font-size: 30px }</style><rect/></svg>`,
    );
    if (r == null || r === "unsupported") throw new Error("expected a font cascade");
    expect(valueOf(r, "font-family")).toBe("serif");
    expect(valueOf(r, "font-size")).toBe("30px");
    expect(valueOf(r, "font-weight")).toBe("500");
    expect(valueOf(r, "font-style")).toBe("italic");
    expect(valueOf(r, "line-height")).toBe("36px");
    expect(r.source).toContain(`@font-face { font-family: Face; src: local(Arial) }`);
    expect(r.source).toContain(`font-size: 24px`);
    expect(r.source).toContain(`#r { font-size: 30px }`);
  });

  it("keeps known transforms when a separate root font selector is undecidable", () => {
    const r = cascade(
      `<svg><style>svg { transform: rotate(10deg) } svg:lang(en) { font-size: 30px }</style><rect/></svg>`,
    );
    if (r == null || r === "unsupported") throw new Error("expected a transform cascade");
    expect(r.declarations.get("transform")?.value).toBe("rotate(10deg)");
    expect(r.fontUnresolved).toBe(true);
  });

  it("returns null without a sheet or without a transform-family declaration reaching the root", () => {
    expect(cascade(`<svg><rect/></svg>`)).toBeNull();
    expect(cascade(`<svg><style>rect { transform: rotate(1deg) } svg { fill: red }</style><rect/></svg>`)).toBeNull();
    // A combinator can never match the parentless root.
    expect(cascade(`<svg><style>g svg { transform: rotate(1deg) }</style><g/></svg>`)).toBeNull();
  });

  it("matches type, :root, #id and .class compounds and strips the applied declarations", () => {
    const r = cascade(
      `<svg id="r" class="a b"><style>svg { transform: rotate(10deg); fill: red } :root { transform-origin: 0 0 } #r.a { scale: 2 } .b { rotate: 5deg }</style><rect/></svg>`,
    );
    expect(r).not.toBeNull();
    expect(r).not.toBe("unsupported");
    expect(valueOf(r, "transform")).toBe("rotate(10deg)");
    expect(valueOf(r, "transform-origin")).toBe("0 0");
    expect(valueOf(r, "scale")).toBe("2");
    expect(valueOf(r, "rotate")).toBe("5deg");
    if (r == null || r === "unsupported") return;
    expect(r.source).toContain("fill: red");
    expect(r.source).not.toMatch(/transform|scale:|rotate:/);
  });

  it("ranks by importance, then specificity, then order", () => {
    const sheet = `svg { transform: rotate(1deg) } #r { transform: rotate(2deg) } svg { transform: rotate(3deg) }`;
    expect(valueOf(cascade(`<svg id="r"><style>${sheet}</style><rect/></svg>`), "transform")).toBe("rotate(2deg)");
    const later = `svg { transform: rotate(1deg) } svg { transform: rotate(3deg) }`;
    expect(valueOf(cascade(`<svg><style>${later}</style><rect/></svg>`), "transform")).toBe("rotate(3deg)");
    const imp = `svg { transform: rotate(1deg) !important } #r { transform: rotate(2deg) }`;
    expect(valueOf(cascade(`<svg id="r"><style>${imp}</style><rect/></svg>`), "transform")).toBe("rotate(1deg)");
  });

  it("keeps the transform for other selectors in the same rule, and for other elements of a shared selector", () => {
    const r = cascade(
      `<svg class="c"><style>svg, rect { transform: rotate(4deg) } .c { scale: 2 }</style><rect class="c"/></svg>`,
    );
    if (r == null || r === "unsupported") throw new Error("expected a cascade");
    expect(r.source).toContain(`svg, rect {} rect {transform: rotate(4deg)}`);
    expect(r.source).toContain(`.c {} .c:not([${IMAGE_ROOT_ATTR}]) {scale: 2}`);
    expect(valueOf(r, "scale")).toBe("2");
  });

  it("decides attribute selectors, :not / :is / :where and never-matching dynamic pseudo-classes", () => {
    const svg = (rule: string) => `<svg width="90" data-k="a b" lang="en-US"><style>${rule}</style><rect/></svg>`;
    expect(valueOf(cascade(svg(`svg[width] { transform: rotate(1deg) }`)), "transform")).toBe("rotate(1deg)");
    expect(valueOf(cascade(svg(`[data-k~="b"][lang|=en] { rotate: 2deg }`)), "rotate")).toBe("2deg");
    expect(valueOf(cascade(svg(`[width^="9"][width$="0"][width*="0"] { scale: 3 }`)), "scale")).toBe("3");
    expect(valueOf(cascade(svg(`[lang="EN-us" i] { scale: 4 }`)), "scale")).toBe("4");
    expect(cascade(svg(`svg[height] { transform: rotate(1deg) }`))).toBeNull();
    expect(cascade(svg(`svg:hover { transform: rotate(1deg) }`))).toBeNull();
    expect(valueOf(cascade(svg(`svg:not(:hover, .x) { rotate: 5deg }`)), "rotate")).toBe("5deg");
    expect(cascade(svg(`svg:not([width]) { rotate: 5deg }`))).toBeNull();
    expect(valueOf(cascade(svg(`:is(g svg, svg[data-k]) { rotate: 6deg }`)), "rotate")).toBe("6deg");
    // :where() adds no specificity; :is() takes its argument's.
    const order = svg(
      `:where(svg[width]) { rotate: 1deg } svg { rotate: 2deg } :is([width]) { scale: 1 } svg { scale: 2 }`,
    );
    expect(valueOf(cascade(order), "rotate")).toBe("2deg");
    expect(valueOf(cascade(order), "scale")).toBe("1");
  });

  it("evaluates @media against the image viewport and strips non-matching blocks too", () => {
    const svg = `<svg><style>@media (min-width: 150px) { svg { rotate: 1deg } } @media (max-width: 150px) and (orientation: landscape) { svg { scale: 2 } } @media (100px < width <= 200px), print { svg { translate: 3px } }</style><rect/></svg>`;
    const narrow = cascade(svg, { w: 120, h: 80 });
    if (narrow == null || narrow === "unsupported") throw new Error("expected a cascade");
    expect(narrow.declarations.get("rotate")).toBeUndefined();
    expect(narrow.declarations.get("scale")?.value).toBe("2");
    expect(narrow.declarations.get("translate")?.value).toBe("3px");
    expect(narrow.source).not.toMatch(/rotate|scale|translate/);
    expect(narrow.source).toContain("@media (min-width: 150px) { svg {} }");
    expect(valueOf(cascade(svg, { w: 300, h: 80 }), "rotate")).toBe("1deg");
    // Without a known viewport, or with an unsupported feature, it is undecidable.
    expect(cascade(svg)).toBe("unsupported");
    expect(
      cascade(`<svg><style>@media (prefers-color-scheme: dark) { svg { rotate: 1deg } }</style></svg>`, { w: 1, h: 1 }),
    ).toBe("unsupported");
  });

  it("decides structural pseudo-classes for the sibling-less document root", () => {
    const svg = (rule: string, body = "<rect/>") => `<svg><style>${rule}</style>${body}</svg>`;
    for (const pc of [
      "first-child",
      "last-child",
      "only-child",
      "first-of-type",
      "last-of-type",
      "only-of-type",
      "scope",
    ]) {
      expect(valueOf(cascade(svg(`svg:${pc} { rotate: 1deg }`)), "rotate")).toBe("1deg");
    }
    expect(valueOf(cascade(svg(`svg:nth-child(odd) { rotate: 2deg }`)), "rotate")).toBe("2deg");
    expect(valueOf(cascade(svg(`svg:nth-last-of-type(-n + 3) { rotate: 3deg }`)), "rotate")).toBe("3deg");
    expect(cascade(svg(`svg:nth-child(2n) { rotate: 4deg }`))).toBeNull();
    expect(valueOf(cascade(svg(`svg:nth-child(1 of svg) { rotate: 5deg }`)), "rotate")).toBe("5deg");
    expect(cascade(svg(`svg:nth-child(1 of rect) { rotate: 6deg }`))).toBeNull();
    expect(cascade(svg(`svg:empty { rotate: 7deg }`))).toBeNull();
    expect(valueOf(cascade(`<svg><style>svg:empty { rotate: 8deg }</style> </svg>`), "rotate")).toBe(undefined);
    // nth-child(… of S) adds the MOST specific selector of S, matching or not
    // (CSSSelector::Specificity, core/css/css_selector.cc:233-236): svg.x
    // makes it (0,2,2), beating svg:first-child (0,1,1).
    const spec = svg(`svg:nth-child(1 of svg.x, svg) { scale: 1 } svg:first-child { scale: 2 }`);
    expect(valueOf(cascade(spec), "scale")).toBe("1");
  });

  it("decides environment media features in the image document", () => {
    const svg = `<svg><style>@media (prefers-color-scheme: dark) { svg { rotate: 1deg } } @media (hover: hover) { svg { scale: 2 } }</style><rect/></svg>`;
    const dark = cascade(svg, null, "dark");
    if (dark == null || dark === "unsupported") throw new Error("expected a cascade");
    expect(dark.declarations.get("rotate")?.value).toBe("1deg");
    expect(dark.declarations.get("scale")).toBeUndefined();
    expect(dark.source).not.toMatch(/rotate|scale/);
    expect(valueOf(cascade(svg, null, "light"), "rotate")).toBeUndefined();
  });

  // ContainerQueryEvaluator finds no container for the parentless root.
  it("never applies @container rules to the root, and strips them", () => {
    const r = cascade(
      `<svg><style>@container (min-width: 0px) { svg { rotate: 9deg } } @container style(--x: 1) { :root { scale: 3 } }</style><rect/></svg>`,
    );
    if (r == null || r === "unsupported") throw new Error("expected a cascade");
    expect(r.declarations.size).toBe(0);
    expect(r.source).not.toMatch(/rotate|scale/);
  });

  // Cascade 5: later layers win, unlayered last; reversed for !important;
  // a layer's sublayers precede its own rules; statements fix the order.
  it("orders @layer blocks and statements in the cascade before specificity", () => {
    const layered = (css: string) => cascade(`<svg id="r"><style>${css}</style><rect/></svg>`);
    expect(valueOf(layered(`@layer a { #r { rotate: 1deg } } svg { rotate: 2deg }`), "rotate")).toBe("2deg");
    expect(
      valueOf(layered(`@layer b, a; @layer a { svg { rotate: 1deg } } @layer b { #r { rotate: 2deg } }`), "rotate"),
    ).toBe("1deg");
    expect(
      valueOf(layered(`@layer a { svg { rotate: 1deg !important } } svg { rotate: 2deg !important }`), "rotate"),
    ).toBe("1deg");
    expect(valueOf(layered(`@layer a { svg { rotate: 1deg } @layer b { #r { rotate: 2deg } } }`), "rotate")).toBe(
      "1deg",
    );
    expect(valueOf(layered(`@layer a.b { #r { rotate: 3deg } } @layer a { svg { rotate: 4deg } }`), "rotate")).toBe(
      "4deg",
    );
    expect(valueOf(layered(`@layer { #r { rotate: 5deg } } @layer { svg { rotate: 6deg } }`), "rotate")).toBe("6deg");
    const r = layered(`@layer a { svg { rotate: 1deg; fill: red } }`);
    if (r == null || r === "unsupported") throw new Error("expected a cascade");
    expect(r.source).toContain("@layer a { svg {fill: red} }");
  });

  it("compares selectors with CSS escapes against the root's decoded XML attribute values", () => {
    const svg = (attrs: string, rule: string) => `<svg${attrs}><style>${rule}</style><rect/></svg>`;
    expect(valueOf(cascade(svg(` data-k="a&amp;b"`, `[data-k="a&b"] { rotate: 1deg }`)), "rotate")).toBe("1deg");
    expect(valueOf(cascade(svg(` data-k="&#x41;&#66;"`, `[data-k=AB] { rotate: 2deg }`)), "rotate")).toBe("2deg");
    expect(valueOf(cascade(svg(` data-k="x"`, `[data-k="\\78"] { rotate: 3deg }`)), "rotate")).toBe("3deg");
    expect(valueOf(cascade(svg(` id="1a"`, `#\\31 a { rotate: 4deg }`)), "rotate")).toBe("4deg");
    expect(valueOf(cascade(svg(` class="a&#x2e;b"`, `.a\\.b { rotate: 5deg }`)), "rotate")).toBe("5deg");
    // Literal whitespace in an XML attribute value becomes a space.
    expect(valueOf(cascade(svg(` data-k="a	b"`, `[data-k="a b"] { rotate: 6deg }`)), "rotate")).toBe("6deg");
    // The i flag folds ASCII only.
    expect(valueOf(cascade(svg(` data-k="ABC"`, `[data-k="abc" i] { rotate: 7deg }`)), "rotate")).toBe("7deg");
    // Sheet text outside CDATA is XML character data; inside CDATA it is literal.
    expect(valueOf(cascade(svg(` data-k="a&amp;b"`, `[data-k="a&amp;b"] { rotate: 10deg }`)), "rotate")).toBe("10deg");
    expect(
      valueOf(cascade(svg(` data-k="a&amp;b"`, `<![CDATA[ [data-k="a&amp;b"] { rotate: 11deg } ]]>`)), "rotate"),
    ).toBeUndefined();
    // A DTD-defined entity leaves the value unknown.
    expect(cascade(svg(` data-k="&ns;"`, `[data-k="x"] { rotate: 8deg }`))).toBe("unsupported");
    expect(valueOf(cascade(svg(` data-k="&ns;"`, `[data-k] { rotate: 9deg }`)), "rotate")).toBe("9deg");
  });

  it("is unsupported for an undecidable compound or a transform inside another at-rule", () => {
    expect(cascade(`<svg><style>svg:lang(en) { transform: rotate(1deg) }</style><rect/></svg>`)).toBe("unsupported");
    expect(
      cascade(`<svg><style>@supports (display: grid) { svg { transform: rotate(1deg) } }</style><rect/></svg>`),
    ).toBe("unsupported");
  });

  it("decides :has() against the image's own element tree", () => {
    const doc = (sheet: string): string =>
      `<svg><style>${sheet}</style><g class="dark"><rect id="a"/></g><circle/></svg>`;
    expect(valueOf(cascade(doc(`svg:has(> g.dark) { rotate: 1deg }`)), "rotate")).toBe("1deg");
    expect(cascade(doc(`svg:has(> rect) { rotate: 2deg }`))).toBeNull();
    expect(valueOf(cascade(doc(`:root:has(g > #a + *) { rotate: 3deg }`)), "rotate")).toBeUndefined();
    expect(valueOf(cascade(doc(`:root:has(g > #a, circle) { rotate: 3deg }`)), "rotate")).toBe("3deg");
    // The root has no siblings, so `+` / `~` never match.
    expect(cascade(doc(`svg:has(+ g) { rotate: 4deg }`))).toBeNull();
    expect(valueOf(cascade(doc(`svg:not(:has(path)) { rotate: 5deg }`)), "rotate")).toBe("5deg");
    // Specificity is the most specific argument: #a (1,0,0) beats .dark (0,1,0).
    expect(
      valueOf(cascade(doc(`svg:has(#a) { rotate: 6deg } svg:has(.dark):has(rect) { rotate: 7deg }`)), "rotate"),
    ).toBe("6deg");
    // Nested :has() and pseudo-elements are left undecided.
    expect(cascade(doc(`svg:has(g:has(rect)) { rotate: 8deg }`))).toBe("unsupported");
    expect(cascade(doc(`svg:has(::before) { rotate: 8deg }`))).toBe("unsupported");
  });

  it("preserves a CDATA wrapper and comments outside the rewritten rule", () => {
    const r = cascade(`<svg><style><![CDATA[ /* x */ svg { transform: rotate(1deg) } ]]></style><rect/></svg>`);
    if (r == null || r === "unsupported") throw new Error("expected a cascade");
    expect(r.source).toContain("<![CDATA[ /* x */ svg {}");
    expect(r.source).toContain("]]></style>");
  });
});

describe("<img> SVG root transform from the document's own <style>", () => {
  const P = { x: 0, y: 0, w: 100, h: 100, par: "none", documentViewport: true, idPrefix: "S-" };
  const prefix = resolveImageNamespace(P.idPrefix).sourcePrefix;

  it("composes the sheet transform around the root and removes it from the inlined sheet", () => {
    const out = inlineImgSvg(
      `<svg viewBox="0 0 100 100"><style>svg { transform: rotate(20deg) }</style><rect width="100" height="40"/></svg>`,
      P,
    )!;
    expect(out).toContain(`translate(50 50) rotate(20) translate(-50 -50)`);
    expect(out).toContain(
      `<style>svg:where([${IMAGE_ROOT_ATTR}="${prefix}"], [${IMAGE_ROOT_ATTR}="${prefix}"] *) {}</style>`,
    );
  });

  it("uses the cascaded root font size and line height for transform units", () => {
    const out = inlineImgSvg(
      `<svg viewBox="0 0 100 100"><style>svg { font-size: 30px; line-height: 40px; transform: translate(2em, 1lh) }</style><rect width="10" height="10"/></svg>`,
      P,
    )!;
    expect(out).toContain("translate(60 40)");
    expect(out).toContain("font-size: 30px");
    expect(out).toContain("line-height: 40px");
  });

  it.each([
    ["small", "13"],
    ["150%", "24"],
    ["2em", "32"],
    ["2rem", "32"],
    ["calc(2em + 1px)", "33"],
    ["calc(1em + calc(1em + 1px))", "33"],
    ["min(2em, 20px)", "20"],
    ["max(1em, 20px)", "20"],
    ["clamp(20px, 1em, 10px)", "20"],
    ["inherit", "16"],
  ])("resolves parentless root font-size %s against the image initial size", (size, expected) => {
    const out = inlineImgSvg(
      `<svg viewBox="0 0 100 100"><style>svg { font-size: ${size}; transform: translateX(1em) }</style><rect width="10" height="10"/></svg>`,
      P,
    )!;
    expect(out).toContain(`translate(${expected} 0)`);
  });

  it("expands a static font shorthand in sheet declaration order", () => {
    const svg = (declarations: string): string =>
      `<svg viewBox="0 0 100 100"><style>svg { ${declarations}; transform: translate(1em, 1lh) }</style><rect/></svg>`;
    expect(inlineImgSvg(svg("font-size: 30px; font: italic bold 20px/1.5 Georgia"), P)).toContain("translate(20 30)");
    expect(inlineImgSvg(svg("font: italic bold 20px/1.5 Georgia; font-size: 30px"), P)).toContain("translate(30 45)");
  });

  it("resolves case-sensitive custom properties from the root cascade", () => {
    const svg = `<svg viewBox="0 0 100 100" style="--Size:24px"><style>@layer defaults { svg { --Size:20px; --size:10px } } svg { font-size:var(--Size); transform:translateX(1em) }</style><rect/></svg>`;
    expect(inlineImgSvg(svg, P)).toContain("translate(24 0)");
    expect(inlineImgSvg(svg.replace("--Size:24px", "--Size:32px !important"), P)).toContain("translate(32 0)");
    expect(
      inlineImgSvg(
        `<svg viewBox="0 0 100 100" font-size="var(--Size)" style="--Size:24px;transform:translateX(1em)"><rect/></svg>`,
        P,
      ),
    ).toContain("translate(24 0)");
    expect(
      inlineImgSvg(
        `<svg viewBox="0 0 100 100"><style>svg{--Font:small-caps 550 clamp(12px, 2em, 24px) serif; font:var(--Font);transform:translateX(1em)}</style><rect/></svg>`,
        P,
      ),
    ).toContain("translate(24 0)");
  });

  it("falls back for unavailable root font data only when the transform needs it", () => {
    const svg = (declarations: string, transform: string) =>
      `<svg viewBox="0 0 100 100" style="${declarations};transform:${transform}"><rect/></svg>`;
    expect(inlineImgSvg(svg("font-size:var(--missing)", "translateX(1em)"), P)).toBeNull();
    expect(inlineImgSvg(svg("--s:20px;--s:;font-size:var(--s)", "translateX(1em)"), P)).toBeNull();
    expect(inlineImgSvg(svg("font-size:var(--missing)", "rotate(20deg)"), P)).toContain("rotate(20)");
    expect(inlineImgSvg(svg("font-size:var(--missing, 20px)", "translateX(1em)"), P)).toContain("translate(20 0)");
    const registered = `<svg viewBox="0 0 100 100" style="font-size:var(--size,20px);transform:translateX(1em)"><style>@property --size{syntax:'*';inherits:true;initial-value:30px}</style><rect/></svg>`;
    expect(inlineImgSvg(registered, P)).toBeNull();
    expect(inlineImgSvg(registered.replace("font-size:var(--size,20px)", "font-size:20px"), P)).toContain(
      "translate(20 0)",
    );
  });

  it("ranks inline font shorthand and longhand against important sheet declarations", () => {
    const svg = (inline: string, sheet: string): string =>
      `<svg viewBox="0 0 100 100" style="${inline}; transform: translateX(1em)"><style>svg { ${sheet} }</style><rect/></svg>`;
    expect(inlineImgSvg(svg("font-size: 25px; font: 20px serif", "font-size: 30px"), P)).toContain("translate(20 0)");
    expect(inlineImgSvg(svg("font: 20px serif; font-size: 25px", "font-size: 30px"), P)).toContain("translate(25 0)");
    expect(inlineImgSvg(svg("font: 20px serif", "font-size: 30px !important"), P)).toContain("translate(30 0)");
  });

  it("ranks sheet font-size against the root style attribute", () => {
    const svg = (sheet: string): string =>
      `<svg viewBox="0 0 100 100" style="font-size: 10px; transform: translate(1em)"><style>svg { font-size: ${sheet} }</style><rect/></svg>`;
    expect(inlineImgSvg(svg("20px"), P)).toContain("translate(10 0)");
    expect(inlineImgSvg(svg("20px !important"), P)).toContain("translate(20 0)");
  });

  it("lets the style attribute beat a normal sheet rule, and an important sheet rule beat it", () => {
    const inline = inlineImgSvg(
      `<svg id="r" viewBox="0 0 100 100" style="transform: rotate(30deg)"><style>#r { transform: scale(0.6) }</style><rect/></svg>`,
      P,
    )!;
    expect(inline).toContain("rotate(30)");
    expect(inline).not.toContain("scale(0.6)");
    const important = inlineImgSvg(
      `<svg id="r" viewBox="0 0 100 100" style="transform: rotate(30deg)"><style>#r { transform: scale(0.6) !important }</style><rect/></svg>`,
      P,
    )!;
    expect(important).toContain("scale(0.6 0.6)");
  });

  it("applies a sheet transform-origin to the transform attribute", () => {
    const out = inlineImgSvg(
      `<svg viewBox="0 0 100 100" transform="rotate(15)"><style>:root { transform-origin: 0 0 }</style><rect/></svg>`,
      P,
    )!;
    expect(out).toContain(`translate(0 0) rotate(15) translate(0 0)`);
  });

  it("marks the root when a shared selector keeps its transform for other elements", () => {
    const out = inlineImgSvg(
      `<svg class="c" viewBox="0 0 100 100"><style>.c { transform: rotate(-25deg) }</style><rect class="c"/></svg>`,
      P,
    )!;
    expect(out).toContain(`${IMAGE_ROOT_ATTR}="${prefix}"`);
    expect(out).toContain(
      `.${prefix}c:not([${IMAGE_ROOT_ATTR}]:where([${IMAGE_ROOT_ATTR}="${prefix}"], [${IMAGE_ROOT_ATTR}="${prefix}"] *))`,
    );
    expect(out).toContain("rotate(-25)");
  });

  it("flattenImgSvg applies a .class sheet transform once (the group does not re-apply it)", () => {
    const out = flattenImgSvg(
      `<svg class="k" viewBox="0 0 100 100"><style>.k { transform: rotate(10deg) }</style><rect/></svg>`,
      P,
    )!;
    expect(out).toContain("rotate(10)");
    expect(out).toContain(`.${prefix}k {}`);
  });
});

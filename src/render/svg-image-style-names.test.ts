import { describe, expect, it } from "vitest";
import { namespaceImageStyleNames } from "./svg-image-style-names.js";
import { inlineImgSvg } from "./svg-inline.js";
import { resolveImageNamespace } from "./svg-image-namespace.js";

describe("isolated SVG image CSS names", () => {
  it.each(['font-family="&quot; Face &quot;"', 'style="fill:red"'])(
    "DM-N80HJW retains source ownership across unproved original font attribute data: %s",
    (attribute) => {
      const source = `<svg ${attribute}><style>@font-face{font-family:" Face ";src:local("Arial")}svg{font-family:" Face "}</style></svg>`;
      expect(namespaceImageStyleNames(source, "I-")).toBeNull();
    },
  );
  it("DM-N80HJW keeps escaped trailing family-token whitespace from PostCSS raws", () => {
    const source = String.raw`<svg><style>@font-face{font-family:" Face ";src:local("Arial")}svg{font:20px \ Face\ ;transform:translate(2ch,0)}</style></svg>`;
    const out = namespaceImageStyleNames(source, "I-");
    expect(out).not.toBeNull();
    expect(out).toContain('font-family:"I- Face "');
    expect(out).toContain(String.raw`font:20px I-\ Face\ ;`);
  });
  it("DM-N80HJW recovers escaped family data at rule end and in local variable values", () => {
    for (const body of [String.raw`font:20px \ Face\ `, String.raw`--face:\ Face\ ;font:20px var(--face)`]) {
      const source = String.raw`<svg><style>@font-face{src:local("Arial");font-family:\ Face\ }svg{${body}}</style></svg>`;
      const out = namespaceImageStyleNames(source, "I-");
      expect(out).not.toBeNull();
      expect(out).toContain(String.raw`font-family:I-\ Face\ `);
      expect(out).toMatch(/font:20px +I-\\ Face\\ /);
    }
  });
  it("does not rename a genuine generic to a same-named literal font face", () => {
    const out = namespaceImageStyleNames(
      `<svg><style>@font-face{font-family:'serif';src:local(serif)}.a{font:20px SERIF}.b{font:20px 'serif'}</style></svg>`,
      "A-",
    );
    expect(out).toContain("font-family:'A-serif'");
    expect(out).toContain(".a{font:20px serif}");
    expect(out).toContain(".b{font:20px 'A-serif'}");
  });
  it("matches commented/escaped literal families without changing unrelated variable strings", () => {
    const out = namespaceImageStyleNames(
      `<svg><style>@font-face{font-family:Foo/**/Bar;src:local(serif)}.a{--note:'Foo/**/Bar';font:20px Foo/**/Bar}</style></svg>`,
      "A-",
    );
    expect(out).toContain("font-family:A-Foo Bar");
    expect(out).toContain("font:20px A-Foo Bar");
    expect(out).toContain("--note:'Foo/**/Bar'");
  });
  it("decodes XML font references before CSS and preserves unrelated DOM strings", () => {
    const out = namespaceImageStyleNames(
      `<svg style="--unrelated:'A &amp; B';font:20px &quot;A &amp; B&quot;"><style><![CDATA[@font-face{font-family:'A & B';src:local(serif)}]]></style><text font-family="&quot;A &amp; B&quot;">A</text></svg>`,
      "X-",
    );
    expect(out).toContain("font:20px &quot;X-A &amp; B&quot;");
    expect(out).toContain('font-family="&quot;X-A &amp; B&quot;"');
    expect(out).toContain("--unrelated:'A &amp; B'");
  });
  it("refuses an XML font reference whose DTD-defined value is unknown", () => {
    expect(
      namespaceImageStyleNames(
        `<svg font-family="&own;"><style>@font-face{font-family:A;src:local(serif)}</style></svg>`,
        "X-",
      ),
    ).toBeNull();
  });
  it.each(["calc(12px + 2px)", "min(12px, 2em)", "max(10px, calc(1em + 2px))", "clamp(10px, 2em, 24px)"])(
    "scopes families after dynamic size %s (DM-2K0K01)",
    (size) => {
      const out = namespaceImageStyleNames(
        `<svg><style>@font-face{font-family:Pair;src:local(serif)} text{font:italic ${size}/1.5 Pair, serif}</style></svg>`,
        "A-",
      );
      expect(out).toContain(`font:italic ${size}/1.5 A-Pair, serif`);
    },
  );

  it("expands a constant local font variable without changing unrelated custom-property values", () => {
    const out = namespaceImageStyleNames(
      `<svg><style>@font-face{font-family:Pair;src:local(serif)} text{--font:20px Pair;--unrelated:'Pair';font:var(--font)}</style></svg>`,
      "A-",
    );
    expect(out).toContain("--font:20px Pair");
    expect(out).toContain("--unrelated:'Pair'");
    expect(out).toMatch(/font:\s*20px A-Pair/);
  });

  it("falls back for font variables with unresolved or competing definitions", () => {
    expect(
      namespaceImageStyleNames(
        `<svg font-family="var(--family)"><style>@font-face{font-family:Pair;src:local(serif)} svg{--family:Pair}</style></svg>`,
        "A-",
      ),
    ).toBeNull();
    expect(
      namespaceImageStyleNames(
        `<svg><style>@font-face{font-family:Pair;src:local(serif)} text{--font:20px Pair;font:var(--font,10px Pair)} .other{--font:30px Pair}</style></svg>`,
        "A-",
      ),
    ).toBeNull();
    expect(
      namespaceImageStyleNames(
        `<svg><style>@font-face{font-family:Pair;src:local(serif)} @property --font{syntax:'*';inherits:true;initial-value:20px Pair} text{font:var(--font,10px Pair)}</style></svg>`,
        "A-",
      ),
    ).toBeNull();
    expect(
      namespaceImageStyleNames(
        `<svg><style>@font-face{font-family:Pair;src:local(serif)} text{font:var(--font)}</style></svg>`,
        "A-",
      ),
    ).toBeNull();
    expect(
      inlineImgSvg(
        `<svg viewBox="0 0 10 10"><style>@font-face{font-family:Pair;src:local(serif)} text{--font:20px Pair;font:var(--font)} .other{--font:30px Pair}</style><text>x</text></svg>`,
        { x: 0, y: 0, w: 10, h: 10, par: "none", idPrefix: "A-" },
      ),
    ).toBeNull();
  });
  it("can use the fallback of a truly absent font variable", () => {
    expect(
      namespaceImageStyleNames(
        `<svg><style>@font-face{font-family:Pair;src:local(serif)} text{font:var(--missing,20px Pair)}</style></svg>`,
        "A-",
      ),
    ).toMatch(/font:\s*20px A-Pair/);
  });
  it("prefixes definitions and references across sheets, attributes and CDATA", () => {
    const source = `<svg viewBox="0 0 10 10" font-family="Shared Face" style="animation-name: spin; --tone: blue">
      <style><![CDATA[/* kept */ @font-face { font-family: "Shared Face"; src: local("Georgia") }
        @keyframes spin { to { opacity: .4 } }
        @property --tone { syntax: "<color>"; inherits: false; initial-value: red }
        @counter-style marks { system: cyclic; symbols: "•"; fallback: decimal }
      ]]></style>
      <style>text { font: 12px "Shared Face", serif; animation: spin 1s linear;
        fill: var(--tone); content: counter(item, marks); list-style: marks inside }
      </style>
      <text style="font-family: 'Shared Face'; animation-name: spin; --tone: green">x</text>
    </svg>`;
    const out = namespaceImageStyleNames(source, "I-");
    expect(out).toContain(`@font-face { font-family: "I-Shared Face"; src: local("Georgia") }`);
    expect(out).toContain(`@keyframes I-spin {`);
    expect(out).toContain(`@property --I-tone {`);
    expect(out).toContain(`@counter-style I-marks {`);
    expect(out).toContain(`font: 12px "I-Shared Face", serif`);
    expect(out).toContain(`animation: I-spin 1s linear`);
    expect(out).toContain(`fill: var(--I-tone)`);
    expect(out).toContain(`content: counter(item, I-marks)`);
    expect(out).toContain(`list-style: I-marks inside`);
    expect(out).toContain(`font-family="I-Shared Face"`);
    expect(out).toContain(`style="animation-name: I-spin; --I-tone: blue"`);
    expect(out).toContain(`font-family: 'I-Shared Face'; animation-name: I-spin; --I-tone: green`);
    expect(out).toContain(`<![CDATA[/* kept */`);
  });

  it("does not rewrite strings, URLs or unrelated names", () => {
    const source = `<svg><style>@keyframes spin { to { opacity: 0 } } @property --tone { syntax: "<color>"; inherits: false; initial-value: red }
      @counter-style marks { system: cyclic; symbols: "*" }
      rect { content: "counter(item, marks) var(--tone)" counter(item, marks); background: url("--tone.svg"); animation-name: other; fill: var(--tone) }
    </style></svg>`;
    const out = namespaceImageStyleNames(source, "I-");
    expect(out).toContain(`content: "counter(item, marks) var(--tone)" counter(item, I-marks)`);
    expect(out).toContain(`url("--tone.svg")`);
    expect(out).toContain(`animation-name: other`);
    expect(out).toContain(`fill: var(--I-tone)`);
  });

  it("keeps same-named definitions from two inlined images distinct", () => {
    const svg = `<svg viewBox="0 0 10 10"><style>@font-face{font-family:Pair;src:local("Menlo")} @keyframes pulse{to{opacity:0}} text{font-family:Pair;animation:pulse 1s}</style><text>x</text></svg>`;
    const placement = { x: 0, y: 0, w: 100, h: 100, par: "xMidYMid meet" };
    const first = inlineImgSvg(svg, { ...placement, idPrefix: "A-" })!;
    const second = inlineImgSvg(svg, { ...placement, idPrefix: "B-" })!;
    const a = resolveImageNamespace("A-").sourcePrefix;
    const b = resolveImageNamespace("B-").sourcePrefix;
    expect(first).toContain(`@font-face{font-family:${a}Pair`);
    expect(first).toContain(`@keyframes ${a}pulse`);
    expect(first).toContain(`font-family:${a}Pair;animation:${a}pulse 1s`);
    expect(second).toContain(`@font-face{font-family:${b}Pair`);
    expect(second).toContain(`@keyframes ${b}pulse`);
    expect(second).toContain(`font-family:${b}Pair;animation:${b}pulse 1s`);
  });

  it("recognizes escaped custom-property references and leaves comments alone", () => {
    const source = `<svg><style>@property --tone { syntax: "<color>"; inherits: false; initial-value: red }
      @container style(--tone: red) { rect { fill: var(--t\\6f ne); /* --tone */ } }
    </style></svg>`;
    const out = namespaceImageStyleNames(source, "I-");
    expect(out).toContain(`@container style(--I-tone: red)`);
    expect(out).toContain(`var(--I-t\\6f ne)`);
    expect(out).toContain(`/* --tone */`);
  });
});

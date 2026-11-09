import { describe, expect, it } from "vitest";
import { namespaceImageStyleNames } from "./svg-image-style-names.js";
import { inlineImgSvg } from "./svg-inline.js";

describe("isolated SVG image CSS names", () => {
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
    expect(first).toContain(`@font-face{font-family:A-Pair`);
    expect(first).toContain(`@keyframes A-pulse`);
    expect(first).toContain(`font-family:A-Pair;animation:A-pulse 1s`);
    expect(second).toContain(`@font-face{font-family:B-Pair`);
    expect(second).toContain(`@keyframes B-pulse`);
    expect(second).toContain(`font-family:B-Pair;animation:B-pulse 1s`);
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

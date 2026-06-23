import { describe, expect, it } from "vitest";
import { namespaceEmbeddedAnimatedSvg } from "./embed-namespace.js";

// DM-1287 (doc 73): `namespaceEmbeddedAnimatedSvg` prefixes every document-global
// name in a nested animated-SVG document so it can't collide with the outer
// animation (or sibling template frames) once concatenated into one document.

describe("namespaceEmbeddedAnimatedSvg", () => {
  it("prefixes element ids and every reference (url / href)", () => {
    const svg = `<svg><defs><clipPath id="viewport-clip"><rect/></clipPath>` +
      `<linearGradient id="f0-bg0"/></defs>` +
      `<g clip-path="url(#viewport-clip)"><rect fill="url(#f0-bg0)"/>` +
      `<use xlink:href="#f0-bg0"/><use href="#viewport-clip"/></g></svg>`;
    const out = namespaceEmbeddedAnimatedSvg(svg, "tf1_");
    expect(out).toContain(`id="tf1_viewport-clip"`);
    expect(out).toContain(`id="tf1_f0-bg0"`);
    expect(out).toContain(`url(#tf1_viewport-clip)`);
    expect(out).toContain(`fill="url(#tf1_f0-bg0)"`);
    expect(out).toContain(`xlink:href="#tf1_f0-bg0"`);
    expect(out).toContain(`href="#tf1_viewport-clip"`);
    // No bare (unprefixed) id definitions survive.
    expect(out).not.toMatch(/\sid="viewport-clip"/);
    expect(out).not.toMatch(/url\(#f0-bg0\)/);
  });

  it("prefixes embedded-font families in @font-face and font-family attrs", () => {
    const svg = `<svg><style>@font-face { font-family: "dmf0"; src: url(data:font/ttf;base64,AAAA) }` +
      `@font-face { font-family: "dmf1"; src: url(data:font/ttf;base64,BBBB) }</style>` +
      `<text font-family="dmf0">hi</text><text font-family="dmf1">yo</text></svg>`;
    const out = namespaceEmbeddedAnimatedSvg(svg, "tf2_");
    expect(out).toContain(`font-family: "tf2_dmf0"`);
    expect(out).toContain(`font-family: "tf2_dmf1"`);
    expect(out).toContain(`font-family="tf2_dmf0"`);
    expect(out).toContain(`font-family="tf2_dmf1"`);
    // The base64 payload is untouched (no bare global dmfN replace).
    expect(out).toContain(`base64,AAAA`);
  });

  it("prefixes frame/anim classes in both selectors and class attrs without mangling .f vs .f-0", () => {
    const svg = `<svg><style>.f { opacity: 0; } .f-0 { animation: fv-0 2s infinite; }` +
      `.anim-f0a0 { animation: f0-f0a0-0 2s; }</style>` +
      `<g class="f f-0"><g class="anim-f0a0"/></g></svg>`;
    const out = namespaceEmbeddedAnimatedSvg(svg, "tf3_");
    // Selectors
    expect(out).toContain(`.tf3_f {`);
    expect(out).toContain(`.tf3_f-0 {`);
    expect(out).toContain(`.tf3_anim-f0a0 {`);
    // The `.f` selector rename must NOT also rewrite the `.f-0` selector's `.f`
    // (which would double-prefix it into `.tf3_f-tf3_0` or similar).
    expect(out).not.toMatch(/\.tf3_f-tf3_/);
    expect(out).not.toMatch(/\.f-0 \{/);
    // Class attrs (each token prefixed)
    expect(out).toContain(`class="tf3_f tf3_f-0"`);
    expect(out).toContain(`class="tf3_anim-f0a0"`);
  });

  it("prefixes @keyframes names and their animation references, keeping them matched", () => {
    const svg = `<svg><style>@keyframes fv-0 { 0% {opacity:0} }` +
      `@keyframes f0-f0a0-0 { 0% {opacity:0} }` +
      `.f-0 { animation: fv-0 2s infinite; } .anim-f0a0 { animation: f0-f0a0-0 2s ease-out; }</style></svg>`;
    const out = namespaceEmbeddedAnimatedSvg(svg, "tf4_");
    expect(out).toContain(`@keyframes tf4_fv-0 {`);
    expect(out).toContain(`@keyframes tf4_f0-f0a0-0 {`);
    expect(out).toContain(`animation: tf4_fv-0 2s infinite`);
    expect(out).toContain(`animation: tf4_f0-f0a0-0 2s ease-out`);
    // No bare (unprefixed) keyframe definition survives.
    expect(out).not.toMatch(/@keyframes fv-0 /);
  });

  it("does NOT touch CSS decimals / percentages when renaming the .f class", () => {
    const svg = `<svg><style>.f { opacity: 0; }` +
      `@keyframes k { 22.500% { transform: scale(0.22); } }` +
      `.anim-x { animation: k 2s cubic-bezier(0.22,1,0.36,1); }</style>` +
      `<g class="f"/></svg>`;
    const out = namespaceEmbeddedAnimatedSvg(svg, "tf5_");
    // The decimal `0.22` and percentage `22.500%` are preserved verbatim.
    expect(out).toContain(`22.500%`);
    expect(out).toContain(`scale(0.22)`);
    expect(out).toContain(`cubic-bezier(0.22,1,0.36,1)`);
    expect(out).toContain(`.tf5_f {`);
  });

  it("prefixes the --scene-dur custom property declaration and var() refs", () => {
    const svg = `<svg><style>:root { --scene-dur: 2.00s; } .x { animation-duration: var(--scene-dur); }</style></svg>`;
    const out = namespaceEmbeddedAnimatedSvg(svg, "tf6_");
    expect(out).toContain(`--scene-dur-tf6_: 2.00s`);
    expect(out).toContain(`var(--scene-dur-tf6_)`);
    expect(out).not.toMatch(/--scene-dur:/);
  });

  it("two distinct tokens never collide on the same input", () => {
    const svg = `<svg><style>@font-face{font-family:"dmf0";src:url(x)}.f-0{animation:fv-0 2s}` +
      `@keyframes fv-0{0%{opacity:0}}</style><g class="f f-0"><text font-family="dmf0">a</text></g></svg>`;
    const a = namespaceEmbeddedAnimatedSvg(svg, "tf0_");
    const b = namespaceEmbeddedAnimatedSvg(svg, "tf1_");
    // The two namespaced copies share no global name.
    for (const name of ["tf0_dmf0", "tf0_fv-0", "tf0_f-0"]) expect(a).toContain(name);
    for (const name of ["tf1_dmf0", "tf1_fv-0", "tf1_f-0"]) expect(b).toContain(name);
    expect(a).not.toContain("tf1_");
    expect(b).not.toContain("tf0_");
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";
import { getFontInstance, registerWebfont, renderTextAsPath, withRenderTextMode } from "../src/render/text-to-path.js";
import { renderFixtureSvgInner, resetFeatureFixtureState } from "./feature-fixture-state.js";

afterEach(() => resetFeatureFixtureState(new Set()));

describe("feature fixture state boundary", () => {
  it("clears a real registered webfont and browser font URL accumulator between fixtures", () => {
    const font = readFileSync(resolve("packages/text-engine/assets/fonts/fixture/DomotionFixtureSerif-Regular.ttf"));
    expect(registerWebfont("FixtureBefore", 400, "normal", font)).toBe(true);
    expect(getFontInstance("webfont:fixturebefore", 400, 16)).not.toBeNull();
    const urls = new Set(["https://example.test/font.woff2"]);
    resetFeatureFixtureState(urls);
    expect(getFontInstance("webfont:fixturebefore", 400, 16)).toBeNull();
    expect(urls.size).toBe(0);
  });

  // DM-KCNHF7: the feature harness renders fixtures concurrently in one
  // process, so another worker can register glyph defs between a fixture's
  // start-of-test reset and its render. Those defs leaked, unreferenced, into
  // the fixture's <defs> and made the emitted SVG scheduling-dependent.
  it("renders a fixture as its own generation, without another worker's glyph defs", () => {
    const font = readFileSync(resolve("packages/text-engine/assets/fonts/fixture/DomotionFixtureSerif-Regular.ttf"));
    // Another worker's fixture rendering text in paths mode registers defs.
    const registerForeignDef = () =>
      withRenderTextMode("paths", () =>
        renderTextAsPath("A", 0, 16, { fontSize: 16, fontFamily: "ForeignFixture", fill: "#000" }),
      );
    resetFeatureFixtureState(new Set());
    expect(registerWebfont("ForeignFixture", 400, "normal", font)).toBe(true);
    expect(registerForeignDef()).toContain('href="#g0"');
    // The hazard the helper closes: a render that only shares the registry
    // emits the foreign def.
    expect(withRenderTextMode("paths", () => elementTreeToSvgInner([], 40, 20))).toContain('<path id="g0"');
    registerForeignDef();
    const svg = renderFixtureSvgInner([], 40, 20);
    expect(svg).not.toContain("<path id=");
    expect(renderFixtureSvgInner([], 40, 20)).toBe(svg);
  });
});

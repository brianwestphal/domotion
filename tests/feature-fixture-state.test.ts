import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";
import { registerTextEngineWebfont } from "../src/render/text-engine.js";
import {
  clearWebfonts,
  getFontInstance,
  registerWebfont,
  renderTextAsPath,
  withRenderTextMode,
} from "../src/render/text-to-path.js";
import { renderFixtureDocument, renderFixtureSvgInner, resetFeatureFixtureState } from "./feature-fixture-state.js";

const font = readFileSync(resolve("packages/text-engine/assets/fonts/fixture/DomotionFixtureSerif-Regular.ttf"));

afterEach(() => clearWebfonts());

describe("feature fixture state boundary", () => {
  it("starts each fixture with an empty font-URL accumulator and a session without another fixture's webfonts", () => {
    const urls = new Set(["https://example.test/font.woff2"]);
    const first = resetFeatureFixtureState(urls);
    expect(urls.size).toBe(0);
    expect(registerTextEngineWebfont(first, "FixtureBefore", 400, "normal", font)).toBe(true);
    expect(renderFixtureDocument(first, () => getFontInstance("webfont:fixturebefore", 400, 16))).not.toBeNull();
    const second = resetFeatureFixtureState(urls);
    expect(renderFixtureDocument(second, () => getFontInstance("webfont:fixturebefore", 400, 16))).toBeNull();
    // A session registration never reaches the ambient registry either.
    expect(getFontInstance("webfont:fixturebefore", 400, 16)).toBeNull();
  });

  // DM-CD5ZX6: the harness worker pool runs fixtures concurrently in one
  // process. Worker B starting a fixture between worker A's discovery and its
  // render used to clear the process-global registry and drop A's webfonts.
  it("keeps a fixture's discovered webfonts when another worker starts a fixture before it renders", () => {
    // The hazard: an ambient registration does not survive the next fixture's
    // start-of-test clear.
    expect(registerWebfont("FixtureAmbient", 400, "normal", font)).toBe(true);
    clearWebfonts();
    expect(getFontInstance("webfont:fixtureambient", 400, 16)).toBeNull();

    const fixtureA = resetFeatureFixtureState(new Set());
    expect(registerTextEngineWebfont(fixtureA, "FixtureA", 400, "normal", font)).toBe(true);
    // Worker B starts its fixture and discovers its own face, during A's awaits.
    const fixtureB = resetFeatureFixtureState(new Set());
    expect(registerTextEngineWebfont(fixtureB, "FixtureB", 400, "normal", font)).toBe(true);
    clearWebfonts();
    expect(renderFixtureDocument(fixtureA, () => getFontInstance("webfont:fixturea", 400, 16))).not.toBeNull();
    expect(renderFixtureDocument(fixtureA, () => getFontInstance("webfont:fixtureb", 400, 16))).toBeNull();
    expect(renderFixtureDocument(fixtureB, () => getFontInstance("webfont:fixtureb", 400, 16))).not.toBeNull();
  });

  // DM-KCNHF7: another worker can register glyph defs between a fixture's
  // start and its render. Those defs leaked, unreferenced, into the fixture's
  // <defs> and made the emitted SVG scheduling-dependent.
  it("renders a fixture as its own generation, without another worker's glyph defs", () => {
    // Another worker's fixture rendering text in paths mode registers defs.
    const registerForeignDef = () =>
      withRenderTextMode("paths", () =>
        renderTextAsPath("A", 0, 16, { fontSize: 16, fontFamily: "ForeignFixture", fontWeight: 400, fill: "#000" }),
      );
    const session = resetFeatureFixtureState(new Set());
    expect(registerWebfont("ForeignFixture", 400, "normal", font)).toBe(true);
    expect(registerForeignDef()).toContain('href="#g0"');
    // The hazard the helper closes: a render that only shares the registry
    // emits the foreign def.
    expect(withRenderTextMode("paths", () => elementTreeToSvgInner([], 40, 20))).toContain('<path id="g0"');
    registerForeignDef();
    const svg = renderFixtureSvgInner(session, [], 40, 20);
    expect(svg).not.toContain("<path id=");
    expect(renderFixtureSvgInner(session, [], 40, 20)).toBe(svg);
  });
});

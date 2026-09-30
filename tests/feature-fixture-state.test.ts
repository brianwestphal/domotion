import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getFontInstance, registerWebfont } from "../src/render/text-to-path.js";
import { resetFeatureFixtureState } from "./feature-fixture-state.js";

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
});

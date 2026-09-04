import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as fkNs from "fontkit";
import { describe, expect, it } from "vitest";

import { WINDOWS_PROFILE_FIXTURE_FAMILIES } from "../tools/generic-profile-target-oracle.js";

const fontkit = (fkNs as { default?: typeof fkNs }).default ?? fkNs;
const fixture = (name: "One" | "Two"): Buffer => readFileSync(
  `assets/fonts/fixture/DomotionProfileDevanagari${name}-Regular.ttf`,
);

describe("Windows generic profile/target system-font fixtures", () => {
  it("provide two distinct named faces that cover the oracle's Devanagari scalar", () => {
    const fonts = (["One", "Two"] as const).map((name) => ({
      bytes: fixture(name),
      font: fontkit.create(fixture(name)),
    }));

    expect(fonts.map(({ font }) => font.familyName)).toEqual([...WINDOWS_PROFILE_FIXTURE_FAMILIES]);
    expect(new Set(fonts.map(({ font }) => font.postscriptName)).size).toBe(2);
    expect(fonts.every(({ font }) => font.glyphForCodePoint(0x0905).id !== 0)).toBe(true);
    expect(fonts.every(({ font }) => font.glyphForCodePoint(0x0041).id === 0)).toBe(true);
    expect(fonts.map(({ bytes }) => createHash("sha256").update(bytes).digest("hex"))).toEqual([
      "a7e458ecaa8406fc16cfbf42d06b3b161da696a5c3ee17ba60aebaed259f45c6",
      "2bd31cb3d7daf3ab86fd1afdc5b835b527cf9b259ca3e8d57a2358224bfdfb9b",
    ]);
  });
});

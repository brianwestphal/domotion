import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  chooseLinuxSystemFamilies,
  launchModeIds,
  logicalIdentity,
  selectedLaunchModeIds,
  systemUiProbeCases,
} from "../tools/system-ui-preference-route-oracle.js";

describe("DM-2504 system-ui preference route oracle contract", () => {
  it("crosses the four required browser launches with route-relevant UI styles", () => {
    expect(launchModeIds()).toEqual([
      "pinned-headless",
      "pinned-headed",
      "full-chrome-headless",
      "full-chrome-headed",
    ]);
    const cases = systemUiProbeCases();
    expect(new Set(cases.map((row) => row.id)).size).toBe(cases.length);
    expect(cases.map((row) => row.size)).toContain(13);
    expect(cases.map((row) => row.size)).toContain(20);
    expect(cases.map((row) => row.weight)).toContain(700);
    expect(cases.some((row) => row.italic)).toBe(true);
    expect(cases.map((row) => row.stretch)).toEqual(expect.arrayContaining([75, 125]));
  });

  it("defaults local automation to headless modes and requires explicit headed opt-in", () => {
    expect(selectedLaunchModeIds([])).toEqual([
      "pinned-headless",
      "full-chrome-headless",
    ]);
    expect(selectedLaunchModeIds(["--allow-headed-browser"])).toEqual(launchModeIds());
    expect(() => selectedLaunchModeIds(["--modes=full-chrome-headed"]))
      .toThrow("headed browser modes require --allow-headed-browser");
    expect(selectedLaunchModeIds([
      "--allow-headed-browser",
      "--modes=full-chrome-headed",
    ])).toEqual(["full-chrome-headed"]);
  });

  it("joins PostScript identity when available and family identity only as the explicit fallback", () => {
    expect(logicalIdentity(
      { familyName: "Live Family", postScriptName: "Live-Face" },
      { familyName: "Live Family", postscriptName: "LiveFace" },
    )).toEqual({ kind: "postscript", browser: "Live-Face", domotion: "LiveFace", exact: true });
    expect(logicalIdentity(
      { familyName: "Live Family", postScriptName: null },
      { familyName: "Live Family", postscriptName: "DifferentFace" },
    )).toEqual({ kind: "family", browser: "Live Family", domotion: "Live Family", exact: true });
    expect(logicalIdentity(
      { familyName: "Live Family", postScriptName: "FaceA" },
      { familyName: "Live Family", postscriptName: "FaceB" },
    ).exact).toBe(false);
  });

  it("derives the Linux preference mutation from live matches and rejects an inert candidate", () => {
    const selected = chooseLinuxSystemFamilies([
      { query: "sans", family: "Measured Sans", postscriptName: "MeasuredSans", path: "/fonts/sans.ttf" },
      { query: "serif", family: "Measured Sans", postscriptName: "MeasuredSans", path: "/fonts/sans.ttf" },
      { query: "monospace", family: "Measured Mono", postscriptName: "MeasuredMono", path: "/fonts/mono.ttf" },
    ]);
    expect(selected.baseline.query).toBe("sans");
    expect(selected.mutation.query).toBe("monospace");
  });

  it("contains no committed platform answer table or pixel adjudication path", () => {
    const source = readFileSync("tools/system-ui-preference-route-oracle.ts", "utf8");
    expect(source).not.toMatch(/Segoe UI|San Francisco|DejaVu|Liberation/);
    expect(source).not.toContain("page.screenshot");
    expect(source).not.toMatch(/pixelmatch|toMatchSnapshot|threshold\s*:/);
    expect(source).toContain("CSS.getPlatformFontsForNode");
    expect(source).toContain("resolveSystemUiFontFace");
  });
});

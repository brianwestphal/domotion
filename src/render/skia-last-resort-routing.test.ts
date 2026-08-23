// Common-Skia last-resort ownership (DM-2517), with no raster comparison.
//
// Chromium's source decision is descriptor-wide: after every declared family
// and browser-settings value is exhausted, `GetFallbackFontFamily` reads
// `FontDescription::GenericFamily` before the common Skia Sans/Arial/unnamed
// tail (`alternate_font_family.h:107-123`, `font_cache_skia.cc:146-259`, rev
// 7d859f27). The cassette below is deliberately adversarial, repository-owned
// matcher input: the concrete Courier stand-in rejects, unnamed and serif
// converge on one fixture face, and monospace selects the repository's
// all-scalar LastResort fixture so a real `.notdef` requeue discriminates.
// It proves our decision and cache ownership given those exact answers; it is
// not a host snapshot and contains no pixel/tolerance assertion.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import * as fontkit from "fontkit";
import type { BlinkGenericFamily } from "./font-resolution.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CASSETTE = resolve(HERE, "..", "..", "tests", "cassettes", "skia-last-resort-linux.json");
const REPLAYER = resolve(HERE, "..", "..", "tools", "font-env-cassette.mjs");

// Availability is memoized when the glyph-helper module loads, so install the
// deterministic replay boundary before dynamically importing the renderer.
process.env.DOMOTION_HELPER_PATH = REPLAYER;
process.env.FONT_CASSETTE = CASSETTE;
process.env.FONT_CASSETTE_MODE = "replay";

type FontResolutionMod = typeof import("./font-resolution.js");
type ClusterFallbackMod = typeof import("./cluster-fallback.js");
type HostPlatformMod = typeof import("./host-platform.js");

let fr: FontResolutionMod;
let cluster: ClusterFallbackMod;
let host: HostPlatformMod;

beforeAll(async () => {
  fr = await import("./font-resolution.js");
  cluster = await import("./cluster-fallback.js");
  host = await import("./host-platform.js");
});

describe("common-Skia descriptor-owned last resort", () => {
  it("transcribes the legacy-generic initial family and non-occupying controls", () => {
    const cases: Array<[string, BlinkGenericFamily, string]> = [
      ["Courier", "none", ""],
      ["monospace", "monospace", "monospace"],
      ["serif", "serif", "serif"],
      ["system-ui", "none", ""],
      ["math", "none", ""],
      ["monospace, system-ui, math", "monospace", "monospace"],
    ];

    for (const [stack, expectedGeneric, expectedInitial] of cases) {
      const context = fr.createFontFallbackSemanticContext(stack);
      expect(context.genericFamily, stack).toBe(expectedGeneric);
      expect(fr.skiaLastResortInitialFamily(context.genericFamily), stack).toBe(expectedInitial);
    }
  });

  it("preserves Chromium's raw last-resort family-question order on all three platforms", () => {
    expect(fr.skiaLastResortFamilyQuestionOrder("monospace", "linux")).toEqual([
      "monospace", "Sans", "Arial", "<unnamed>",
    ]);
    expect(fr.skiaLastResortFamilyQuestionOrder("none", "linux")).toEqual([
      "<unnamed-default>", "Sans", "Arial", "<unnamed>",
    ]);
    expect(fr.skiaLastResortFamilyQuestionOrder("serif", "win32")).toEqual([
      "serif",
      "Sans",
      "Arial",
      "MS UI Gothic",
      "Microsoft Sans Serif",
      "Segoe UI",
      "Calibri",
      "Times New Roman",
      "Courier New",
      "<locale-space-match>",
      "<unnamed>",
    ]);
    expect(fr.skiaLastResortFamilyQuestionOrder("monospace", "darwin"))
      .toEqual(["Times", "Lucida Grande"]);
    expect(fr.skiaLastResortFamilyQuestionOrder("none", "darwin"))
      .toEqual(["Times", "Lucida Grande"]);
  });

  it("puts the source-selected generic ahead of each platform's existing terminal tail", () => {
    const named = fr.createFontFallbackSemanticContext("Courier");
    const mono = fr.createFontFallbackSemanticContext("monospace");
    const serif = fr.createFontFallbackSemanticContext("serif");
    const systemUi = fr.createFontFallbackSemanticContext("system-ui");
    const math = fr.createFontFallbackSemanticContext("math");
    const monoThenControls = fr.createFontFallbackSemanticContext("monospace, system-ui, math");

    expect(cluster.__skiaLastResortKeysForTest(named, "linux")).toEqual(["helvetica"]);
    expect(cluster.__skiaLastResortKeysForTest(systemUi, "linux")).toEqual(["helvetica"]);
    expect(cluster.__skiaLastResortKeysForTest(math, "linux")).toEqual(["helvetica"]);
    expect(cluster.__skiaLastResortKeysForTest(mono, "linux")).toEqual(["courier", "helvetica"]);
    expect(cluster.__skiaLastResortKeysForTest(monoThenControls, "linux"))
      .toEqual(["courier", "helvetica"]);
    expect(cluster.__skiaLastResortKeysForTest(serif, "linux")).toEqual(["times", "helvetica"]);

    expect(cluster.__skiaLastResortKeysForTest(named, "win32")).toEqual(["arial"]);
    expect(cluster.__skiaLastResortKeysForTest(mono, "win32")).toEqual(["courier", "arial"]);
    expect(cluster.__skiaLastResortKeysForTest(serif, "win32")).toEqual(["times", "arial"]);

    // macOS has its own terminal and never consults the common-Skia generic.
    expect(cluster.__skiaLastResortKeysForTest(named, "darwin"))
      .toEqual(["times", "lucida-grande"]);
    expect(cluster.__skiaLastResortKeysForTest(mono, "darwin"))
      .toEqual(["times", "lucida-grande"]);

    // Exact description-blind mutation: named/non-occupying controls agree
    // with the old tail, while the two legacy generics must move ahead of it.
    const descriptionBlindLinux = ["helvetica"];
    expect(cluster.__skiaLastResortKeysForTest(named, "linux")).toEqual(descriptionBlindLinux);
    expect(cluster.__skiaLastResortKeysForTest(systemUi, "linux")).toEqual(descriptionBlindLinux);
    expect(cluster.__skiaLastResortKeysForTest(math, "linux")).toEqual(descriptionBlindLinux);
    expect(cluster.__skiaLastResortKeysForTest(mono, "linux")).not.toEqual(descriptionBlindLinux);
    expect(cluster.__skiaLastResortKeysForTest(serif, "linux")).not.toEqual(descriptionBlindLinux);
  });

  it("keeps exhausted terminal cache entries descriptor-sensitive in both request orders", () => {
    const forward = [
      "Courier",
      "monospace",
      "serif",
      "system-ui",
      "math",
      "monospace, system-ui, math",
    ];
    const expected: Record<string, string> = {
      Courier: "IBMPlexSerif-Regular",
      monospace: "LastResortHE-Regular",
      serif: "IBMPlexSerif-Regular",
      "system-ui": "IBMPlexSerif-Regular",
      math: "IBMPlexSerif-Regular",
      "monospace, system-ui, math": "LastResortHE-Regular",
    };

    host.withHostPlatform("linux", () => {
      for (const order of [forward, [...forward].reverse()]) {
        fr.clearFontResolutionCaches();
        const instances = new Map<string, NonNullable<ReturnType<FontResolutionMod["getFontInstance"]>>>();

        for (const stack of order) {
          const instance = fr.getFontInstance(
            "courier", 411, 18, 0, undefined, 100, false, undefined,
            fr.createFontFallbackSemanticContext(stack),
          );
          expect(instance, stack).not.toBeNull();
          instances.set(stack, instance!);
        }

        expect(Object.fromEntries(
          [...instances].map(([stack, instance]) => [stack, instance.postscriptName]),
        )).toEqual(expected);
        expect(fr.__primaryCutCacheSizesForTest().linux).toBe(3); // empty / monospace / serif

        // Once both descriptor routes select the same physical face, the
        // ordinary face/style cache stays generic-agnostic.
        expect(instances.get("Courier")).toBe(instances.get("system-ui"));
        expect(instances.get("Courier")).toBe(instances.get("math"));
        expect(instances.get("Courier")).toBe(instances.get("serif"));
        expect(instances.get("Courier")).not.toBe(instances.get("monospace"));
      }
    });
  });

  it("activates the shaped .notdef terminal and preserves non-occupying controls", () => {
    const opened = fontkit.openSync("assets/fonts/fixture/DomotionFixtureSerif-Regular.ttf");
    const primary = ("fonts" in opened
      ? (opened as unknown as { fonts: Array<typeof opened> }).fonts[0]
      : opened) as Parameters<ClusterFallbackMod["splitTextIntoFontRunsShaped"]>[1];
    const text = "\uE000"; // absent from the primary/serif fixture; present in LastResortHE
    const forward = [
      "Courier",
      "monospace",
      "serif",
      "system-ui",
      "math",
      "monospace, system-ui, math",
    ];
    const expected = {
      Courier: "dm2517-unopenable:first-candidate-notdef",
      monospace: "courier:last-resort",
      serif: "dm2517-unopenable:first-candidate-notdef",
      "system-ui": "dm2517-unopenable:first-candidate-notdef",
      math: "dm2517-unopenable:first-candidate-notdef",
      "monospace, system-ui, math": "courier:last-resort",
    };

    host.withHostPlatform("linux", () => {
      for (const order of [forward, [...forward].reverse()]) {
        fr.clearFontResolutionCaches();
        const actual: Record<string, string> = {};
        for (const stack of order) {
          const semanticContext = fr.createFontFallbackSemanticContext(stack);
          const runs = cluster.splitTextIntoFontRunsShaped(
            text, primary, "dm2517-unopenable", 411, 18, 0,
            undefined, undefined, ["dm2517-unopenable"], false, 100,
            undefined, stack, { semanticContext },
          );
          expect(runs, stack).toHaveLength(1);
          actual[stack] = `${runs[0].fontKey}:${runs[0].routeMechanism}`;
        }
        expect(actual).toEqual(expected);
      }
    });
  });
});

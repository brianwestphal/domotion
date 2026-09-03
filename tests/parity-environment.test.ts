import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fingerprintComplete,
  parityEnvironment,
  sourceAuthorityPinsFromManifest,
} from "../tools/parity-environment.js";

afterEach(() => vi.unstubAllEnvs());

describe("parity environment source provenance", () => {
  it("reads revisions from the materialized source-authority manifest", () => {
    expect(sourceAuthorityPinsFromManifest(JSON.stringify({
      pins: {
        chromium: "chromium-materialized-pin",
        harfbuzz: "harfbuzz-materialized-pin",
        skia: "skia-materialized-pin",
        icu: "icu-materialized-pin",
      },
    }))).toEqual({
      chromium: "chromium-materialized-pin",
      harfbuzz: "harfbuzz-materialized-pin",
      skia: "skia-materialized-pin",
      icu: "icu-materialized-pin",
    });
    expect(sourceAuthorityPinsFromManifest("not-json")).toEqual({});
  });

  it("uses explicit audited source pins when CI omits the large checkouts", () => {
    vi.stubEnv("DOMOTION_CHROMIUM_REVISION", "chromium-pin");
    vi.stubEnv("DOMOTION_HARFBUZZ_REVISION", "harfbuzz-pin");
    vi.stubEnv("DOMOTION_SKIA_REVISION", "skia-pin");
    vi.stubEnv("DOMOTION_ICU_SOURCE_REVISION", "icu-pin");
    const environment = parityEnvironment({
      chromium: "package-pinned",
      launchFlags: [],
      deviceScaleFactor: 1,
      zoom: 1,
      writingMode: "horizontal-tb",
      direction: "ltr",
      corpusIdentity: "test",
      sampleIdentity: "test-row",
    });
    expect(environment.runtimes).toMatchObject({
      chromiumSource: "chromium-pin",
      harfbuzzSource: "harfbuzz-pin",
      skiaPinned: "skia-pin",
      icuSource: "icu-pin",
    });
    expect(fingerprintComplete(environment)).toBe(true);
  });
});

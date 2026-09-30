import { describe, expect, it } from "vitest";
import {
  getSessionGenericFamilyOverrides,
  setSessionGenericFamilyOverrides,
  setTextRunProvenanceEnabled,
  textRunProvenanceEnabled,
} from "@domotion/text-engine/testing";
import {
  getSystemFallbackResolution,
  setSystemFallbackResolution,
} from "../packages/text-engine/src/render/text-to-path.js";
import {
  hostPlatform,
  hostPlatformIsOverridden,
  withHostPlatform,
} from "../packages/text-engine/src/render/host-platform.js";
import { getFlattenNestedSvg, setFlattenNestedSvg } from "../src/render/svg-inline.js";
import { getRenderTextMode, setRenderTextMode } from "../src/render/text-to-path.js";

const baseline = {
  mode: getRenderTextMode(),
  fallback: getSystemFallbackResolution(),
  generic: getSessionGenericFamilyOverrides(),
  flatten: getFlattenNestedSvg(),
  provenance: textRunProvenanceEnabled(),
};

describe("E2E process-global cleanup", () => {
  it("allows a case to alter every harness setter", () => {
    setRenderTextMode("paths");
    setSystemFallbackResolution(!baseline.fallback);
    setSessionGenericFamilyOverrides({ common: new Map([["serif", "Fake"]]), byScript: new Map() });
    setFlattenNestedSvg(!baseline.flatten);
    setTextRunProvenanceEnabled(!baseline.provenance);
    expect(() =>
      withHostPlatform("linux", () => {
        throw new Error("probe");
      }),
    ).toThrow("probe");
    expect(hostPlatform()).toBe(process.platform);
  });

  it("starts the next case with the previous state restored", () => {
    expect(getRenderTextMode()).toBe(baseline.mode);
    expect(getSystemFallbackResolution()).toBe(baseline.fallback);
    expect(getSessionGenericFamilyOverrides()).toBe(baseline.generic);
    expect(getFlattenNestedSvg()).toBe(baseline.flatten);
    expect(textRunProvenanceEnabled()).toBe(baseline.provenance);
    expect(hostPlatformIsOverridden()).toBe(false);
  });
});

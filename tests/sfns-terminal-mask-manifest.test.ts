import { describe, expect, it } from "vitest";
import {
  SFNS_TERMINAL_MASK_CONTROL_IDS,
  SFNS_TERMINAL_MASK_MANIFEST,
  SFNS_TERMINAL_MASK_MANIFEST_ABI,
  SFNS_TERMINAL_MASK_SCENARIO_IDS,
  sfnsTerminalMaskCase,
  sfnsTerminalMaskManifestDigest,
} from "../tools/sfns-terminal-mask-manifest.js";

describe("source-owned SFNS terminal-mask manifest", () => {
  it("pins five scenarios, six controls, the authenticated corpus, and a stable digest", () => {
    expect(SFNS_TERMINAL_MASK_MANIFEST).toMatchObject({
      schemaVersion: 1,
      abi: SFNS_TERMINAL_MASK_MANIFEST_ABI,
      corpus: {
        text: "zoom2!",
        sourceFontByteLength: 7_872_432,
        sourceFontSha256: "44890958f3e0b997028121ed7c7a789f3f5cce227c7a93ce8f86ec0db26da571",
        decodedFontByteLength: 7_867_744,
        decodedFontSha256: "e2165f571fe3a383b57123a1a91234b2b2a2859f0510af2b97e3ef129a352226",
        collectionIndex: 0,
        glyphIds: [970, 816, 816, 795, 1312, 1379],
      },
    });
    expect(SFNS_TERMINAL_MASK_MANIFEST.cases.map((entry) => entry.id)).toEqual([
      ...SFNS_TERMINAL_MASK_SCENARIO_IDS,
      ...SFNS_TERMINAL_MASK_CONTROL_IDS.map((id) => `control-${id}`),
    ]);
    expect(sfnsTerminalMaskManifestDigest()).toBe("5b13e7e12bd037af96b50695a4a5408fbd5085fb65a0ca427a60510a6373bbff");
  });

  it("contains requests only, never cross-arm derived rendering results", () => {
    const keys = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value != null && typeof value === "object") {
        for (const [key, entry] of Object.entries(value)) {
          keys.add(key);
          visit(entry);
        }
      }
    };
    visit(SFNS_TERMINAL_MASK_MANIFEST);
    for (const forbidden of [
      "shapedAdvance",
      "shapedOffset",
      "sourcePosition",
      "deviceOrigin",
      "packedId",
      "phase",
      "rawRec",
      "filteredRec",
      "coreTextMetrics",
      "maskBytes",
      "bytesBase64",
    ])
      expect(keys).not.toContain(forbidden);
  });

  it("pins Chromium-exact white-paint and full live-matrix requests", () => {
    for (const entry of SFNS_TERMINAL_MASK_MANIFEST.cases) {
      expect(entry.request).toMatchObject({
        paint: { color: 0xffff_ffff, style: "fill" },
        surface: { flags: 0, textContrast: 0, textGamma: 0 },
        scalerContextFlags: 3,
        font: {
          scaleX: 1,
          skewX: 0,
          subpixel: true,
          linearMetrics: true,
          embeddedBitmaps: false,
        },
      });
      expect(entry.request.run.liveDeviceMatrix).toHaveLength(9);
      expect(entry.request.run.sourceStart).toEqual([0, 0]);
    }
    expect(sfnsTerminalMaskCase("transform-scale-2").request).toMatchObject({
      fontSize: 13,
      run: { liveDeviceMatrix: [2, 0, 0, 0, 2, 26, 0, 0, 1] },
    });
    expect(sfnsTerminalMaskCase("zoom-2-transform-half").request).toMatchObject({
      fontSize: 26,
      run: { liveDeviceMatrix: [0.5, 0, 0, 0, 0.5, 12.5, 0, 0, 1] },
    });
  });
});

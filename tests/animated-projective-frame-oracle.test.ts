import { describe, expect, it } from "vitest";
import {
  adjudicateAnimatedProjectiveFrame,
  type AnimatedProjectiveFrameExpectation,
  type AnimatedProjectiveFrameObservation,
  type ProjectiveComputedFrame,
} from "../tools/animated-projective-frame-oracle.js";

const computed: ProjectiveComputedFrame = {
  transform: "matrix3d(.8,0,-.6,0,0,1,0,0,.6,0,.8,0,0,0,0,1)",
  translate: "none",
  rotate: "none",
  scale: "none",
  transformOrigin: "56px 41px",
  transformStyle: "preserve-3d",
  perspective: "500px",
  perspectiveOrigin: "120px 90px",
  overflowX: "visible",
  overflowY: "visible",
};

const expected: AnimatedProjectiveFrameExpectation = {
  sampleTimeMs: 250,
  stateRequired: true,
  sourceQuad: [20, 20, 122, 25, 113, 101, 27, 98],
  sourceResidual: 16.155494,
  sourceComputed: computed,
  animationCount: 9,
  ownerId: "rotate3d-plane",
};

const observation: AnimatedProjectiveFrameObservation = {
  state: {
    source: "chromium-cdp-content-quad-v1",
    sampleTimeMs: 250,
    animationCount: 9,
    role: "html-box",
    influenced: true,
    contentQuad: [...expected.sourceQuad],
    borderQuad: [...expected.sourceQuad],
    residual: expected.sourceResidual,
    nonAffine: true,
    ownsRasterBoundary: true,
    computed,
  },
  ownerId: "rotate3d-plane",
  ownerCount: 1,
  rasterMaterialized: true,
  noProjective2dApproximation: true,
};

describe("animated projective frame adjudication", () => {
  it("accepts one exact source quad/composition/raster-owner sample", () => {
    expect(adjudicateAnimatedProjectiveFrame(expected, observation).pass).toBe(true);
  });

  it("kills stale time, shifted quad, dropped owner, 2D fitting, and composition collapse", () => {
    const mutations: AnimatedProjectiveFrameObservation[] = [
      { ...observation, state: { ...observation.state!, sampleTimeMs: 251 } },
      { ...observation, state: { ...observation.state!, contentQuad: [21, 20, 122, 25, 113, 101, 27, 98] } },
      { ...observation, ownerId: null, ownerCount: 0, rasterMaterialized: false },
      { ...observation, noProjective2dApproximation: false },
      { ...observation, state: { ...observation.state!, computed: { ...computed, transform: "matrix(1, 0, 0, 1, 0, 0)" } } },
    ];
    expect(mutations.map((actual) => adjudicateAnimatedProjectiveFrame(expected, actual).pass)).toEqual([
      false, false, false, false, false,
    ]);
  });

  it("requires an affine/inactive sample to stay vector-owned without a fabricated frame record", () => {
    const affineExpected = { ...expected, stateRequired: false, ownerId: null };
    const affineActual = {
      ...observation,
      state: undefined,
      ownerId: null,
      ownerCount: 0,
      rasterMaterialized: false,
    };
    expect(adjudicateAnimatedProjectiveFrame(affineExpected, affineActual).pass).toBe(true);
  });
});

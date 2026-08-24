import { describe, expect, it } from "vitest";

import {
  COLLAPSED_BORDER_FRAGMENT_SOURCE_PINS,
  REQUIRED_COLLAPSED_BORDER_FRAGMENT_DISCRIMINATORS,
  validateCollapsedBorderFragmentationCorpus,
} from "../tools/collapsed-border-fragmentation-oracle.js";

describe("authenticated collapsed-border physical section-fragment corpus", () => {
  it("pins the Blink layout/paint boundary and complete logical discriminator set", () => {
    expect(validateCollapsedBorderFragmentationCorpus()).toEqual([]);
    expect(COLLAPSED_BORDER_FRAGMENT_SOURCE_PINS.chromium).toBe("7d859f271cbda744098ac69f44978d4edfa62be3");
    expect(REQUIRED_COLLAPSED_BORDER_FRAGMENT_DISCRIMINATORS).toEqual([
      "whole-row-break-paints-half-edge",
      "continued-row-omits-inline-edge",
      "adjacent-sections-share-one-edge",
      "repeated-header-alias-fails-closed",
      "repeated-footer-alias-fails-closed",
      "oversize-header-authenticates-nonrepeat",
      "span-interior-remains-unfilled",
      "vertical-lr-rtl-uses-physical-x-block-axis",
      "vertical-rl-ltr-uses-physical-x-block-axis",
      "print-pagination-is-not-screen-cssom-fragmentation",
      "eligible-records-carry-physical-fragment-provenance",
      "records-bind-cssom-and-cdp-in-neutral-plane",
      "caption-first-fragments-preserve-child-paint-slots",
      "multiple-tbody-global-rows-remain-consecutive",
      "fractional-span-column-offsets-remain-exact",
    ]);
  });
});

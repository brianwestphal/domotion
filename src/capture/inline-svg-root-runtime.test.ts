import { expect, it } from "vitest";
import { inlineSvgRootRuntimeForBrowser } from "./inline-svg-root-runtime.js";

const revision = "@6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050";
const shell = "chrome-headless-shell";
const disableTrials = "--disable-field-trial-config";
const feature = "SvgInlineRootPixelSnappingScaleAdjustment";
const enable = `--enable-blink-features=${feature}`;
const disable = `--disable-blink-features=${feature}`;

it("authenticates the pinned headless default and explicit Blink overrides", () => {
  expect(inlineSvgRootRuntimeForBrowser(revision, [shell, disableTrials])).toBe("unscaled");
  expect(inlineSvgRootRuntimeForBrowser(revision, [shell, disableTrials, enable])).toBe("shrink");
  expect(inlineSvgRootRuntimeForBrowser(revision, [shell, disableTrials, disable, enable])).toBe("unscaled");
  expect(
    inlineSvgRootRuntimeForBrowser(revision, [shell, disableTrials, enable, "--enable-blink-features=IdleDetection"]),
  ).toBe("unscaled");
  expect(inlineSvgRootRuntimeForBrowser(revision, [shell, disableTrials, "--", enable])).toBe("unscaled");
});

it("preserves uncertainty on runtime paths without an authenticated shrink mode", () => {
  expect(inlineSvgRootRuntimeForBrowser("unknown", [shell, disableTrials])).toBeUndefined();
  expect(inlineSvgRootRuntimeForBrowser(revision, [])).toBe("pinned-unknown");
  expect(inlineSvgRootRuntimeForBrowser(revision, ["chrome", disableTrials])).toBe("pinned-unknown");
  expect(inlineSvgRootRuntimeForBrowser(revision, [shell])).toBe("pinned-unknown");
  expect(inlineSvgRootRuntimeForBrowser(revision, [shell, disableTrials, "--enable-blink-test-features"])).toBe(
    "pinned-unknown",
  );
  expect(inlineSvgRootRuntimeForBrowser(revision, [shell, disableTrials, `--enable-features=${feature}<Trial`])).toBe(
    "pinned-unknown",
  );
});

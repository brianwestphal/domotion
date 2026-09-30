import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Browser } from "@playwright/test";

const { openOwnedBrowser } = vi.hoisted(() => ({ openOwnedBrowser: vi.fn() }));
vi.mock("../tools/lib/browser.js", () => ({ openOwnedBrowser }));

import { launchHarnessBrowsers } from "./harness-browsers.js";

const originalCaptureFlags = process.env.DOMOTION_CAPTURE_FLAGS;
const originalRasterFlags = process.env.DOMOTION_RASTER_FLAGS;

beforeEach(() => {
  openOwnedBrowser.mockReset();
  process.env.DOMOTION_CAPTURE_FLAGS = "--capture";
  process.env.DOMOTION_RASTER_FLAGS = "--raster";
});

afterEach(() => {
  if (originalCaptureFlags == null) delete process.env.DOMOTION_CAPTURE_FLAGS;
  else process.env.DOMOTION_CAPTURE_FLAGS = originalCaptureFlags;
  if (originalRasterFlags == null) delete process.env.DOMOTION_RASTER_FLAGS;
  else process.env.DOMOTION_RASTER_FLAGS = originalRasterFlags;
});

it("closes the first browser if the asymmetric raster launch fails", async () => {
  const captureClose = vi.fn().mockResolvedValue(undefined);
  openOwnedBrowser
    .mockResolvedValueOnce({ browser: {} as Browser, close: captureClose })
    .mockRejectedValueOnce(new Error("raster launch failed"));

  await expect(launchHarnessBrowsers()).rejects.toThrow("raster launch failed");
  expect(openOwnedBrowser).toHaveBeenCalledTimes(2);
  expect(captureClose).toHaveBeenCalledOnce();
});

it("shares one owned browser when capture and raster flags match", async () => {
  process.env.DOMOTION_RASTER_FLAGS = "--capture";
  const close = vi.fn().mockResolvedValue(undefined);
  const browser = {} as Browser;
  openOwnedBrowser.mockResolvedValue({ browser, close });

  const owner = await launchHarnessBrowsers();
  expect(owner).toMatchObject({ capture: browser, raster: browser, asymmetric: false });
  expect(openOwnedBrowser).toHaveBeenCalledOnce();
  await owner.close();
  expect(close).toHaveBeenCalledOnce();
});

it("closes both asymmetric browsers after the harness run", async () => {
  const captureClose = vi.fn().mockResolvedValue(undefined);
  const rasterClose = vi.fn().mockResolvedValue(undefined);
  const capture = {} as Browser;
  const raster = {} as Browser;
  openOwnedBrowser
    .mockResolvedValueOnce({ browser: capture, close: captureClose })
    .mockResolvedValueOnce({ browser: raster, close: rasterClose });

  const owner = await launchHarnessBrowsers();
  expect(owner).toMatchObject({ capture, raster, asymmetric: true });
  await owner.close();
  expect(rasterClose).toHaveBeenCalledOnce();
  expect(captureClose).toHaveBeenCalledOnce();
  expect(rasterClose.mock.invocationCallOrder[0]).toBeLessThan(captureClose.mock.invocationCallOrder[0]);
});

it("still closes capture when raster close rejects", async () => {
  const captureClose = vi.fn().mockResolvedValue(undefined);
  const rasterClose = vi.fn().mockRejectedValue(new Error("raster close failed"));
  openOwnedBrowser
    .mockResolvedValueOnce({ browser: {} as Browser, close: captureClose })
    .mockResolvedValueOnce({ browser: {} as Browser, close: rasterClose });

  const owner = await launchHarnessBrowsers();
  await expect(owner.close()).rejects.toThrow("raster close failed");
  expect(captureClose).toHaveBeenCalledOnce();
});

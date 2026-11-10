import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import { capturedElement } from "../src/test-support/captured-fixtures.js";
import { observeNativeDecorationFrame } from "./native-decoration-frame-probe.js";

const keys = {
  sourceNodeKey: "fixture-source",
  decorationNodeKey: "fixture-parts",
  restoreKey: "fixture-restore",
  rows: [],
};

it("retains the identical existing frame/options and distinguishes an empty crop without another screenshot", async () => {
  const png = await sharp({
    create: { width: 430, height: 260, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();
  const facts = [{ connected: true, fingerprintMatches: true }];
  const evaluate = vi
    .fn()
    .mockResolvedValueOnce(facts)
    .mockResolvedValueOnce({ moment: "post-shot", host: { hover: false } });
  const screenshot = vi.fn().mockResolvedValue(png);
  // This fixture supplies only the two Page methods the probe wraps.
  const page = { evaluate, screenshot } as unknown as Page;
  const probe = observeNativeDecorationFrame(page);
  const options = { clip: { x: 0, y: 0, width: 430, height: 260 }, omitBackground: true };
  expect(await page.evaluate(() => true, keys)).toBe(facts);
  expect(await page.screenshot(options)).toBe(png);
  expect(screenshot).toHaveBeenCalledTimes(1);
  expect(screenshot.mock.calls[0][0]).toBe(options);
  expect(evaluate).toHaveBeenCalledTimes(2);
  expect(screenshot.mock.invocationCallOrder[0]).toBeLessThan(evaluate.mock.invocationCallOrder[1]);
  const directory = mkdtempSync(join(tmpdir(), "native-frame-probe-"));
  try {
    await probe.write(
      directory,
      "fixture",
      capturedElement({
        tag: "input",
        nativeControlDecorationRaster: {
          x: 39.25,
          y: 159.5,
          width: 282,
          height: 46,
          kinds: ["inner-spin-button"],
          empty: true,
        },
      }),
      { fixture: true },
    );
    expect(readFileSync(join(directory, "fixture-0-isolation.png")).equals(png)).toBe(true);
    const result: unknown = JSON.parse(readFileSync(join(directory, "fixture.json"), "utf8"));
    expect(result).toMatchObject({
      records: [
        {
          bytes: png.length,
          isolationFacts: facts,
          pixelCrop: { left: 39, top: 159, width: 283, height: 47 },
          alpha: { opaque: 0, translucent: 0, transparent: 13301 },
        },
      ],
    });
  } finally {
    probe.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
  expect(page.evaluate).toBe(evaluate);
  expect(page.screenshot).toBe(screenshot);
});

it("preserves the original screenshot failure and contains a post-frame observer failure", async () => {
  const original = Error("original screenshot failure");
  const evaluate = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(Error("observer failure"));
  const png = Buffer.from("original PNG bytes");
  const screenshot = vi.fn().mockRejectedValueOnce(original).mockResolvedValue(png);
  const page = { evaluate, screenshot } as unknown as Page;
  const probe = observeNativeDecorationFrame(page);
  try {
    await page.evaluate(() => true, keys);
    await expect(page.screenshot()).rejects.toBe(original);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(await page.screenshot()).toBe(png);
    expect(evaluate).toHaveBeenCalledTimes(1);
    await page.evaluate(() => true, keys);
    expect(await page.screenshot()).toBe(png);
    expect(screenshot).toHaveBeenCalledTimes(3);
  } finally {
    probe.dispose();
  }
  expect(page.screenshot).toBe(screenshot);
});

it.each([
  { name: "a different active owner", rows: [{ index: 0 }], registry: true, expected: false },
  { name: "the actual number owner", rows: [{ index: 1 }], registry: true, expected: true },
  { name: "an unavailable registry", rows: [{ index: 1 }], registry: false, expected: null },
  {
    name: "an omitted owner beyond the cap",
    rows: Array.from({ length: 17 }, () => ({ index: 0 })),
    registry: true,
    expected: null,
  },
])("correlates $name without inferring ownership from an empty crop", async ({ rows, registry, expected }) => {
  class ProbeElement {
    matches() {
      return false;
    }
    getBoundingClientRect() {
      return { x: 40, y: 160, width: 280, height: 44 };
    }
  }
  const number = Object.assign(new ProbeElement(), { [keys.decorationNodeKey]: [] });
  vi.stubGlobal("Element", ProbeElement);
  vi.stubGlobal("document", { querySelector: () => number, activeElement: null });
  vi.stubGlobal("getComputedStyle", () => ({
    visibility: "hidden",
    opacity: "0",
    display: "block",
    pointerEvents: "none",
    appearance: "auto",
  }));
  vi.stubGlobal(keys.sourceNodeKey, registry ? [new ProbeElement(), number] : undefined);
  const directory = mkdtempSync(join(tmpdir(), "native-owner-probe-"));
  const png = await sharp({
    create: { width: 430, height: 260, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();
  const evaluate = vi.fn(async (fn: unknown, arg: unknown) => {
    if (typeof fn !== "function") throw new Error("Expected fixture callback");
    return (fn as (value: unknown) => unknown)(arg);
  });
  const screenshot = vi.fn().mockResolvedValue(png);
  const page = { evaluate, screenshot } as unknown as Page;
  const probe = observeNativeDecorationFrame(page);
  try {
    await page.evaluate(() => [], { ...keys, rows });
    expect(await page.screenshot()).toBe(png);
    await probe.write(
      directory,
      "owner",
      capturedElement({
        tag: "input",
        nativeControlDecorationRaster: {
          x: 39,
          y: 159,
          width: 283,
          height: 47,
          kinds: ["inner-spin-button"],
          empty: true,
        },
      }),
      { fixture: true },
    );
    const result: unknown = JSON.parse(readFileSync(join(directory, "owner.json"), "utf8"));
    expect(result).toMatchObject({
      records: [
        {
          postScreenshotState: {
            isolationOwners: {
              numberIsActiveOwner: expected,
              count: rows.length,
              observedCount: Math.min(16, rows.length),
              truncated: rows.length > 16,
            },
          },
          alpha: { opaque: 0, translucent: 0 },
        },
      ],
    });
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(screenshot).toHaveBeenCalledTimes(1);
  } finally {
    probe.dispose();
    vi.unstubAllGlobals();
    rmSync(directory, { recursive: true, force: true });
  }
});

import { describe, expect, it, vi } from "vitest";

const seenOverrides = vi.hoisted(() => [] as unknown[]);

vi.mock("./script-segmentation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./script-segmentation.js")>();
  return {
    ...actual,
    bidiLevelsFor(text: string, override?: unknown) {
      seenOverrides.push(override);
      return actual.bidiLevelsFor(text, override as Parameters<typeof actual.bidiLevelsFor>[1]);
    },
  };
});

import { splitTextIntoFontRunsShaped } from "./cluster-fallback.js";
import { resolveFont, resolveFontKey, resolveFontKeyChain } from "./font-resolution.js";

describe("shaped fallback bidi override", () => {
  it("threads the captured CSS override into Blink-style run segmentation", () => {
    const family = "serif";
    const font = resolveFont(family, 400, 16, 0);
    expect(font).not.toBeNull();
    const override = { direction: "ltr" as const, unicodeBidi: "bidi-override" };

    splitTextIntoFontRunsShaped(
      "שלום",
      font!,
      resolveFontKey(family),
      400,
      16,
      0,
      undefined,
      undefined,
      resolveFontKeyChain(family),
      false,
      100,
      undefined,
      family,
      { bidiOverride: override },
    );

    expect(seenOverrides).toContainEqual(override);
  });
});

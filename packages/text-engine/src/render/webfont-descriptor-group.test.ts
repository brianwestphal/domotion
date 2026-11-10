import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearWebfonts,
  pickWebfontVariantForCodepoint,
  registerWebfont,
  resolveFont,
  resolveFontForCodepoint,
  resolveFontKeyChain,
} from "./font-resolution.js";
import { glyphIdForCp } from "./font-instance.js";
import { buildVariableHintedFont } from "./synth-test-fonts.js";

const mono = readFileSync(new URL("../../assets/fonts/fixture/DomotionFixtureMono-Regular.ttf", import.meta.url));
const serif = readFileSync(new URL("../../assets/fonts/fixture/DomotionFixtureSerif-Regular.ttf", import.meta.url));
const A: Array<[number, number]> = [[0x41, 0x41]];
const ZERO: Array<[number, number]> = [[0x30, 0x30]];
const add = (
  family: string,
  bytes: Buffer,
  weight = "400",
  style = "normal",
  stretch = "100%",
  ranges?: Array<[number, number]>,
) => expect(registerWebfont(family, parseFloat(weight), style, bytes, ranges, stretch, weight, style)).toBe(true);
const select = (family: string, cp: number, weight = 400, slant = 0, stretch = 100) =>
  pickWebfontVariantForCodepoint(family, weight, 20, slant, cp, undefined, stretch);
const walk = (stack: string, cp: number, weight = 400, slant = 0, stretch = 100) => {
  const primary = resolveFont(stack, weight, 20, slant, undefined, stretch)!;
  const chain = resolveFontKeyChain(stack, undefined, { weight, size: 20, slant, stretch });
  return resolveFontForCodepoint(cp, primary, chain[0], weight, 20, slant, undefined, undefined, chain, false, stretch);
};

beforeEach(() => clearWebfonts());
afterEach(() => clearWebfonts());

describe("descriptor group before unicode-range", () => {
  it.each([false, true])("skips a selected weight group without borrowing another weight (reversed=%s)", (reverse) => {
    const faces = [
      () => add("Metric Group", mono, "400", "normal", "100%", A),
      () => add("Metric Group", mono, "700", "normal", "100%", ZERO),
    ];
    for (const register of reverse ? faces.reverse() : faces) register();
    expect(select("Metric Group", 0x30)).toBeNull();
    expect(select("Metric Group", 0x30, 700)).not.toBeNull();
    const primary = resolveFont("Metric Group", 400, 20, 0);
    expect(primary?.webfontUnicodeRange).toEqual(A);
    expect(primary?.webfontFace?.declaredWeightCaps).toEqual([400, 400]);
    add("Metric Fallback", serif);
    expect(walk('"Metric Group", "Metric Fallback"', 0x30).key).toBe("webfont:metric fallback");
  });

  it("does not use a Latin primary from a different weight group", () => {
    add("Latin Bias", mono, "400", "normal", "100%", ZERO);
    add("Latin Bias", serif, "700", "normal", "100%", A);
    expect(resolveFont("Latin Bias", 400, 20, 0)?.webfontUnicodeRange).toEqual(ZERO);
  });

  it("does not borrow another weight when the excluded family is secondary in the CSS stack", () => {
    add("Missing First", buildVariableHintedFont({ firstCodePoint: 0x41, withOs2: true }));
    add("Metric Group", mono, "400", "normal", "100%", A);
    add("Metric Group", mono, "700", "normal", "100%", ZERO);
    add("Metric Fallback", serif);
    expect(walk('"Missing First", "Metric Group", "Metric Fallback"', 0x30).key).toBe("webfont:metric fallback");
  });

  it.each([
    {
      name: "style",
      requestSlant: 14,
      requestStretch: 100,
      firstStyle: "italic",
      firstStretch: "100%",
      secondStyle: "normal",
      secondStretch: "100%",
    },
    {
      name: "stretch",
      requestSlant: 0,
      requestStretch: 75,
      firstStyle: "normal",
      firstStretch: "75%",
      secondStyle: "normal",
      secondStretch: "100%",
    },
  ])(
    "does not cross the selected $name group after a range miss",
    ({ requestSlant, requestStretch, firstStyle, firstStretch, secondStyle, secondStretch }) => {
      add("Axis Group", mono, "400", firstStyle, firstStretch, A);
      add("Axis Group", mono, "400", secondStyle, secondStretch, ZERO);
      expect(select("Axis Group", 0x30, 400, requestSlant, requestStretch)).toBeNull();
      expect(select("Axis Group", 0x30)).not.toBeNull();
      add("Metric Fallback", serif);
      expect(walk('"Axis Group", "Metric Fallback"', 0x30, 400, requestSlant, requestStretch).key).toBe(
        "webfont:metric fallback",
      );
    },
  );

  it("keeps partitions in the same selected group and returns the actual primary partition override", () => {
    add("Partitions", mono, "400", "normal", "100%", A);
    add("Partitions", serif, "400", "normal", "100%", ZERO);
    const selected = select("Partitions", 0x30);
    expect(selected?.webfontBuffer).toEqual(serif);
    const result = walk('"Partitions"', 0x30);
    expect(result.key).toBe("webfont:partitions");
    expect(result.fontOverride?.webfontBuffer).toEqual(serif);
  });

  it.each([false, true])("uses reverse declarations only inside the chosen group (reversed=%s)", (reverse) => {
    const bytes = reverse ? [serif, mono] : [mono, serif];
    for (const data of bytes) add("Overlap", data, "400", "normal", "100%", ZERO);
    add("Overlap", mono, "700", "normal", "100%", ZERO);
    expect(select("Overlap", 0x30)?.webfontBuffer).toEqual(bytes[1]);
  });

  it("distinguishes a range exclusion from an in-range missing glyph", () => {
    add(
      "Missing Glyph",
      buildVariableHintedFont({ firstCodePoint: 0x41, withOs2: true }),
      "400",
      "normal",
      "100%",
      ZERO,
    );
    add("Missing Glyph", mono, "700", "normal", "100%", ZERO);
    const selected = select("Missing Glyph", 0x30);
    expect(selected).not.toBeNull();
    expect(glyphIdForCp(selected!, 0x30)).toBe(0);
    add("Metric Fallback", serif);
    expect(walk('"Missing Glyph", "Metric Fallback"', 0x30).key).toBe("webfont:metric fallback");
  });
});

import { describe, expect, it } from "vitest";
import { fontFamilyCanBeInitial } from "./font-family-default.js";

describe("possible initial font-family value", () => {
  it.each([
    ["Times", "Times"],
    ['"Times New Roman"', '"Times New Roman"'],
    ["times", "Times"],
    ['"Times"', "Times"],
  ])("accepts equivalent single concrete family %s", (computed, initial) => {
    expect(fontFamilyCanBeInitial(computed, initial)).toBe(true);
  });

  it.each([
    ['sohne-var, "SF Pro Display", sans-serif', "Times"],
    ["Times, serif", "Times"],
    ["Georgia", "Times"],
    ["Arial", '"Times New Roman"'],
    ["serif", "serif"],
    ["", "Times"],
    ["Times", ""],
    ["Times", "Times, serif"],
  ])("rejects a stack, distinct family or unavailable initial value %s", (computed, initial) => {
    expect(fontFamilyCanBeInitial(computed, initial)).toBe(false);
  });
});

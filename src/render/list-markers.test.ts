/**
 * DM-1114: non-decimal `list-style-type` numbering systems.
 *
 * Before this, armenian / georgian / hebrew / cjk-decimal / arabic-indic all
 * fell through `formatListMarker`'s `default: String(n)` and painted plain
 * `1 2 3` where Chrome paints the script's numerals (e.g. `Ա Բ Գ`, `一、二、`).
 */

import { describe, it, expect } from "vitest";
import { formatListMarker, listMarkerSuffix, collapseMarkerWhitespace } from "./element-tree-to-svg.js";

describe("formatListMarker — non-decimal counter systems (DM-1114)", () => {
  it("keeps the existing decimal / alpha / roman / greek systems", () => {
    expect(formatListMarker("decimal", 7)).toBe("7");
    expect(formatListMarker("decimal-leading-zero", 7)).toBe("07");
    expect(formatListMarker("lower-alpha", 1)).toBe("a");
    expect(formatListMarker("upper-roman", 4)).toBe("IV");
    expect(formatListMarker("lower-greek", 1)).toBe("α");
  });

  it("renders Armenian numerals (additive)", () => {
    expect(formatListMarker("armenian", 1)).toBe("Ա");
    expect(formatListMarker("armenian", 2)).toBe("Բ");
    expect(formatListMarker("armenian", 3)).toBe("Գ");
    // 1988 = 1000 + 900 + 80 + 8 = Ռ Ջ Ձ Ը
    expect(formatListMarker("upper-armenian", 1988)).toBe("ՌՋՁԸ");
    // lower-armenian is the uppercase set shifted +0x30
    expect(formatListMarker("lower-armenian", 1)).toBe("ա");
  });

  it("renders Georgian numerals (additive)", () => {
    expect(formatListMarker("georgian", 1)).toBe("ა");
    expect(formatListMarker("georgian", 2)).toBe("ბ");
    expect(formatListMarker("georgian", 3)).toBe("გ");
    // 12 = 10 + 2 = ი ბ
    expect(formatListMarker("georgian", 12)).toBe("იბ");
  });

  it("renders Hebrew numerals with the 15/16 divine-name exceptions", () => {
    expect(formatListMarker("hebrew", 1)).toBe("א");
    expect(formatListMarker("hebrew", 2)).toBe("ב");
    expect(formatListMarker("hebrew", 3)).toBe("ג");
    // 15 → טו (9+6), NOT יה (10+5); 16 → טז (9+7), NOT יו (10+6).
    expect(formatListMarker("hebrew", 15)).toBe("טו");
    expect(formatListMarker("hebrew", 16)).toBe("טז");
    // 11 = 10 + 1 = יא (no exception)
    expect(formatListMarker("hebrew", 11)).toBe("יא");
  });

  it("renders arabic-indic and cjk-decimal as positional digit substitutions", () => {
    expect(formatListMarker("arabic-indic", 1)).toBe("١");
    expect(formatListMarker("arabic-indic", 23)).toBe("٢٣");
    expect(formatListMarker("cjk-decimal", 1)).toBe("一");
    expect(formatListMarker("cjk-decimal", 2)).toBe("二");
    expect(formatListMarker("cjk-decimal", 10)).toBe("一〇");
    expect(formatListMarker("cjk-decimal", 20)).toBe("二〇");
  });

  it("falls back to decimal for unknown types and out-of-range additive values", () => {
    expect(formatListMarker("nonsense", 5)).toBe("5");
    expect(formatListMarker("armenian", 0)).toBe("0");
    expect(formatListMarker("armenian", 99999)).toBe("99999");
  });
});

describe("listMarkerSuffix — per-style marker suffix (DM-1114)", () => {
  it("uses the ideographic comma for CJK styles and a period otherwise", () => {
    expect(listMarkerSuffix("cjk-decimal")).toBe("、");
    expect(listMarkerSuffix("decimal")).toBe(".");
    expect(listMarkerSuffix("armenian")).toBe(".");
    expect(listMarkerSuffix("hebrew")).toBe(".");
  });
});

describe("collapseMarkerWhitespace — white-space:normal marker (DM-1119)", () => {
  it("collapses a doubled @counter-style suffix space to one, like Chrome", () => {
    // `domo-step` has `prefix: "Step "`, `suffix: ":  "` (two spaces) and
    // `pad: 2 "0"` → label "Step 01:  ". Chrome's ::marker is white-space:normal
    // so it paints a single space; preserving both slid the marker left.
    expect(collapseMarkerWhitespace("Step 01:  ")).toBe("Step 01: ");
    expect(collapseMarkerWhitespace("a\t \tb")).toBe("a b");
  });

  it("leaves single-space suffixes (e.g. the emoji bullet) untouched", () => {
    expect(collapseMarkerWhitespace("🔵 ")).toBe("🔵 ");
    expect(collapseMarkerWhitespace("1. ")).toBe("1. ");
  });
});

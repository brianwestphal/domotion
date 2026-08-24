import { describe, expect, it } from "vitest";

import {
  REQUIRED_PAGED_COLLAPSED_TABLE_MATRIX,
  validatePagedCollapsedTableCorpus,
} from "../tools/paged-collapsed-table-ownership-audit.js";
import {
  PAGED_COLLAPSED_TABLE_SOURCE_PINS,
  REQUIRED_PAGED_COLLAPSED_TABLE_FACTS,
} from "../src/capture/paged-collapsed-table-record.js";

describe("paged collapsed-table ownership audit corpus", () => {
  it("pins the source boundary and complete fail-closed matrix", () => {
    expect(validatePagedCollapsedTableCorpus()).toEqual([]);
    expect(PAGED_COLLAPSED_TABLE_SOURCE_PINS.chromium)
      .toBe("7d859f271cbda744098ac69f44978d4edfa62be3");
    expect(REQUIRED_PAGED_COLLAPSED_TABLE_FACTS).toHaveLength(14);
    expect(REQUIRED_PAGED_COLLAPSED_TABLE_MATRIX).toEqual([
      "whole-row",
      "continued-row",
      "repeated-header-footer",
      "caption",
      "span-joint",
      "vertical-lr-positive",
      "vertical-rl-negative",
      "empty-terminal-page",
    ]);
  });
});

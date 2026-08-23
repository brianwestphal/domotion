import { describe, expect, it } from "vitest";
import type { CapturedElement, CapturedSessionGenericFamilies } from "../capture/types.js";
import { capturedSessionGenericFamilies } from "./element-tree-to-svg.js";
import {
  getSessionGenericFamilyOverrides,
  setSessionGenericFamilyOverrides,
  withSessionGenericFamilyOverrides,
} from "./font-resolution.js";

const root = (record?: CapturedSessionGenericFamilies): CapturedElement => ({
  tag: "div",
  text: "",
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  children: [],
  styles: {},
  sessionGenericFamilies: record,
} as unknown as CapturedElement);

const record = (serif: string, reverse = false): CapturedSessionGenericFamilies => {
  const common = reverse
    ? { serif, standard: serif }
    : { standard: serif, serif };
  const script = reverse
    ? { serif, standard: serif }
    : { standard: serif, serif };
  const byScript = reverse
    ? { DEVANAGARI: script, LATIN: script }
    : { LATIN: script, DEVANAGARI: script };
  return { source: "chromium-platform-fonts-v1", common, byScript };
};

describe("captured generic-family preference ownership", () => {
  it("accepts equivalent JSON records independent of object insertion order", () => {
    const captured = capturedSessionGenericFamilies([
      root(record("Page A")),
      root(JSON.parse(JSON.stringify(record("Page A", true))) as CapturedSessionGenericFamilies),
    ]);
    expect(captured?.common.get("serif")).toBe("Page A");
  });

  it("rejects partial or conflicting multi-root authority", () => {
    expect(() => capturedSessionGenericFamilies([root(record("Page A")), root()]))
      .toThrow("with and without generic-family preference authority");
    expect(() => capturedSessionGenericFamilies([root(record("Page A")), root(record("Page B"))]))
      .toThrow("different generic-family preference sessions");
  });

  it("renders serialized A/B records in either order without global contamination", () => {
    const prior = { common: new Map([["serif", "Explicit prior"]]), byScript: new Map() };
    const a = capturedSessionGenericFamilies([root(JSON.parse(JSON.stringify(record("Page A"))))])!;
    const b = capturedSessionGenericFamilies([root(JSON.parse(JSON.stringify(record("Page B"))))])!;
    setSessionGenericFamilyOverrides(prior);
    try {
      expect(withSessionGenericFamilyOverrides(a, () => getSessionGenericFamilyOverrides()?.common.get("serif")))
        .toBe("Page A");
      expect(withSessionGenericFamilyOverrides(b, () => getSessionGenericFamilyOverrides()?.common.get("serif")))
        .toBe("Page B");
      expect(withSessionGenericFamilyOverrides(b, () => getSessionGenericFamilyOverrides()?.common.get("serif")))
        .toBe("Page B");
      expect(withSessionGenericFamilyOverrides(a, () => getSessionGenericFamilyOverrides()?.common.get("serif")))
        .toBe("Page A");
      expect(getSessionGenericFamilyOverrides()).toBe(prior);
    } finally {
      setSessionGenericFamilyOverrides(null);
    }
  });
});

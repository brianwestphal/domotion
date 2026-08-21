import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { splitTextIntoFontRunsShaped } from "./cluster-fallback.js";
import {
  clearWebfonts,
  registerWebfont,
  resolveFont,
  resolveFontKey,
  resolveFontKeyChain,
  type FontRun,
} from "./font-resolution.js";

const FAMILY = "DM Bidi Boundary";
const FONT_PATH = "assets/fonts/LastResortHE-Regular.ttf";

function split(text: string, bidiOverride?: { direction: "ltr" | "rtl"; unicodeBidi: string }): FontRun[] {
  const font = resolveFont(FAMILY, 400, 16, 0);
  expect(font).not.toBeNull();
  const runs = splitTextIntoFontRunsShaped(
    text,
    font!,
    resolveFontKey(FAMILY),
    400,
    16,
    0,
    undefined,
    undefined,
    resolveFontKeyChain(FAMILY),
    false,
    100,
    undefined,
    FAMILY,
    { bidiOverride },
  );
  expect(runs).not.toBeNull();
  return runs!;
}

/** The deleted-boundary mutant: this is the production assembly predicate
 * before the fix, deliberately omitting shaping-item identity/direction. */
function mergeIgnoringShapingItems(runs: FontRun[]): FontRun[] {
  const out: FontRun[] = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (last != null && last.fontKey === run.fontKey && last.font === run.font
        && last.endIdx === run.startIdx && last.routeMechanism === run.routeMechanism) {
      last.text += run.text;
      last.endIdx = run.endIdx;
    } else {
      out.push({ ...run });
    }
  }
  return out;
}

describe("shaped fallback preserves Blink bidi items", () => {
  beforeAll(() => {
    // One deterministic, repo-owned face covers Latin and Hebrew on every host.
    // The test therefore isolates item assembly rather than platform fallback.
    registerWebfont(FAMILY, 400, "normal", readFileSync(FONT_PATH));
  });
  afterAll(() => clearWebfonts());

  it("keeps adjacent same-face LTR, RTL, and LTR items as distinct directed runs", () => {
    const runs = split("AאבB");
    expect(runs.map((run) => ({
      text: run.text,
      start: run.startIdx,
      end: run.endIdx,
      direction: run.shapingDirection,
      key: run.fontKey,
    }))).toEqual([
      { text: "A", start: 0, end: 1, direction: "ltr", key: "webfont:dm bidi boundary" },
      { text: "אב", start: 1, end: 3, direction: "rtl", key: "webfont:dm bidi boundary" },
      { text: "B", start: 3, end: 4, direction: "ltr", key: "webfont:dm bidi boundary" },
    ]);
    expect(new Set(runs.map((run) => run.font)).size).toBe(1);
  });

  it("still coalesces adjacent same-face clusters inside one LTR item", () => {
    expect(split("AB12").map((run) => ({ text: run.text, direction: run.shapingDirection }))).toEqual([
      { text: "AB12", direction: "ltr" },
    ]);
  });

  it("carries a CSS override's resolved direction instead of re-inferring it from Hebrew", () => {
    expect(split("AאבB", { direction: "ltr", unicodeBidi: "bidi-override" })
      .map((run) => run.shapingDirection)).toEqual(["ltr", "ltr", "ltr"]);
  });

  it("mutation control: deleting the item-boundary guard collapses the positive case", () => {
    const runs = split("AאבB");
    const mutated = mergeIgnoringShapingItems(runs);
    expect(mutated).toHaveLength(1);
    expect(mutated[0]).toMatchObject({ text: "AאבB", shapingDirection: "ltr" });
    expect(mutated[0].shapingDirection).not.toBe(runs[1].shapingDirection);
  });
});

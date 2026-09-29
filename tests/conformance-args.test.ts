import { describe, expect, it } from "vitest";
import { finiteFlag, intFlag } from "../tools/lib/conformance-args.js";
import { parseArgs as parseShapingArgs } from "../tools/shaping-conformance.js";

describe("conformance numeric arguments", () => {
  it("accepts safe integers and a documented zero exception", () => {
    expect(intFlag("--batch", "8")).toBe(8);
    expect(intFlag("--reset-every", "0", 0)).toBe(0);
    for (const raw of ["", "abc", "1x", "0", "-1", "1.5", "9007199254740993"]) {
      expect(() => intFlag("--batch", raw)).toThrow(/needs an integer/);
    }
  });

  it("rejects non-finite shaping tolerance and malformed run counts", () => {
    expect(finiteFlag("--tolerance", "0.5")).toBe(0.5);
    expect(() => parseShapingArgs(["--max-runs", "abc"])).toThrow(/needs an integer/);
    expect(() => parseShapingArgs(["--batch", "0"])).toThrow(/needs an integer/);
    expect(() => parseShapingArgs(["--tolerance", "NaN"])).toThrow(/finite number/);
    expect(() => parseShapingArgs(["--tolerance", "Infinity"])).toThrow(/finite number/);
    expect(parseShapingArgs(["--tolerance", "0"]).tolerance).toBe(0);
  });
});

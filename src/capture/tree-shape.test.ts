import { describe, expect, it } from "vitest";
import { assertCapturedTreeShape } from "./tree-shape.js";

describe("assertCapturedTreeShape", () => {
  it("accepts the script's result shapes", () => {
    const withWarnings = { tree: [], warnings: [{ selector: "a", feature: "f", detail: "d" }] };
    expect(assertCapturedTreeShape(withWarnings)).toBe(withWarnings);
    expect(assertCapturedTreeShape({ tree: [] })).toEqual({ tree: [] });
    expect(assertCapturedTreeShape({ tree: [], warnings: [] })).toEqual({ tree: [], warnings: [] });
  });

  it.each([
    [undefined, "returned undefined"],
    [null, "returned null"],
    ["tree", "returned string"],
    [{}, "no `tree` array (got undefined)"],
    [{ tree: null }, "no `tree` array (got null)"],
    [{ tree: {} }, "no `tree` array (got object)"],
    [{ tree: [], warnings: "none" }, "`warnings` is not an array (got string)"],
    [{ tree: [], warnings: null }, "`warnings` is not an array (got object)"],
  ])("rejects %j with a named cause", (value, message) => {
    expect(() => assertCapturedTreeShape(value)).toThrow(message);
  });

  it("names the caller in the message", () => {
    expect(() => assertCapturedTreeShape(undefined, "neutral text-paint capture")).toThrow(
      "neutral text-paint capture returned undefined",
    );
  });
});

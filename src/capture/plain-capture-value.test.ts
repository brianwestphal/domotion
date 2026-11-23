import { describe, expect, it } from "vitest";
import { encodePlainCaptureValue, decodePlainCaptureValue } from "./plain-capture-value.js";
const roundtrip = (value: unknown) =>
  decodePlainCaptureValue(JSON.parse(JSON.stringify(encodePlainCaptureValue(value))));
describe("plain capture transport", () => {
  it("preserves own undefined/nonfinite/-0, Unicode and alias/cycle identity", () => {
    const shared = { value: "雪😀\u2028" };
    const input: { optional: undefined; values: unknown[]; first: object; second: object; self?: object } = {
      optional: undefined,
      values: [null, NaN, Infinity, -Infinity, -0, false, ""],
      first: shared,
      second: shared,
    };
    input.self = input;
    const result = roundtrip(input) as typeof input;
    expect(Object.hasOwn(result, "optional")).toBe(true);
    expect(result.optional).toBeUndefined();
    expect(result.values).toEqual(input.values);
    expect(Object.is(result.values[4], -0)).toBe(true);
    expect(result.first).toBe(result.second);
    expect(result.self).toBe(result);
  });
  it("matches array-hole materialization and safely defines constructor while omitting __proto__", () => {
    const sparse = [];
    sparse.length = 2;
    sparse[1] = "x";
    const input = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(input, "__proto__", { value: { polluted: true }, enumerable: true });
    Object.defineProperty(input, "constructor", { value: { data: true }, enumerable: true });
    input.sparse = sparse;
    const result = roundtrip(input) as Record<string, unknown>;
    expect(Object.hasOwn(result, "__proto__")).toBe(false);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, "constructor")).toBe(true);
    expect(result.constructor).toEqual({ data: true });
    expect(Object.hasOwn(result.sparse as object, 0)).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("walks a deep graph iteratively without a small tree/depth cap", () => {
    const input: { next?: object } = {};
    let cursor = input;
    for (let i = 0; i < 12000; i++) {
      const next = {};
      cursor.next = next;
      cursor = next;
    }
    let result = roundtrip(input) as { next?: object };
    let depth = 0;
    while (result.next) {
      depth++;
      result = result.next as { next?: object };
    }
    expect(depth).toBe(12000);
  });
  it.each([new Date(), /x/, new Map(), new Set(), new Uint8Array([1]), () => 1, Symbol("x"), 1n])(
    "explicitly refuses unsupported non-plain data",
    (value) => expect(() => encodePlainCaptureValue(value)).toThrow(/refuses/),
  );
  it.each([
    null,
    {},
    { version: "other", containers: [], root: { k: "u" } },
    { version: "domotion-plain-capture-v1", containers: [], root: { k: "ref", v: 0 } },
    { version: "domotion-plain-capture-v1", containers: [], root: { k: "n", v: NaN } },
    {
      version: "domotion-plain-capture-v1",
      containers: [{ k: "o", values: [[1, { k: "u" }]] }],
      root: { k: "ref", v: 0 },
    },
  ])("rejects malformed wire graphs without reference amplification", (wire) =>
    expect(() => decodePlainCaptureValue(wire)).toThrow(/invalid/),
  );
});

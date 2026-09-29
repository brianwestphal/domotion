import { describe, expect, it } from "vitest";
import { HelperProtocolError, parseHelperResponse } from "./glyph-helper-protocol.js";

const source = { helperPath: "/opt/helper", transport: "one-shot" };

describe("parseHelperResponse", () => {
  it("returns a well-formed envelope untouched", () => {
    expect(parseHelperResponse('{"results":[{"type":"glyphs","glyphs":[]}]}', source).results).toHaveLength(1);
    expect(parseHelperResponse('{"results":[]}', source).results).toEqual([]);
  });

  it("names the helper and carrier when the output is not JSON", () => {
    try {
      parseHelperResponse("Segmentation fault", source);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HelperProtocolError);
      expect((error as HelperProtocolError).helperPath).toBe("/opt/helper");
      expect((error as Error).message).toMatch(/one-shot, \/opt\/helper.*not JSON.*Segmentation fault/);
    }
  });

  it.each(["null", "[]", '"x"', "42", "{}", '{"results":{}}', '{"error":"unknown"}'])(
    "rejects a JSON value without a results array: %s",
    (text) => {
      expect(() => parseHelperResponse(text, { helperPath: null, transport: "persistent" })).toThrow(
        /persistent, unknown binary.*results/,
      );
    },
  );

  it("truncates a long payload in the message", () => {
    expect(() => parseHelperResponse(`{"x":"${"a".repeat(500)}"}`, source)).toThrow(/…$/);
  });
});

import { describe, expect, it } from "vitest";
import { parsePort } from "./common.js";

describe("parsePort", () => {
  it("returns undefined when the flag is absent", () => {
    expect(parsePort(undefined)).toBeUndefined();
  });

  it("accepts a valid port in 0..65535", () => {
    expect(parsePort("1")).toBe(1);
    expect(parsePort("8080")).toBe(8080);
    expect(parsePort("65535")).toBe(65535);
  });

  it("accepts 0 — the OS-assigned-free-port sentinel the servers default to", () => {
    expect(parsePort("0")).toBe(0);
  });

  it("rejects a non-numeric value", () => {
    expect(() => parsePort("abc")).toThrow(/0\.\.65535/);
  });

  it("rejects negatives", () => {
    expect(() => parsePort("-5")).toThrow(/0\.\.65535/);
  });

  it("rejects a non-integer", () => {
    expect(() => parsePort("80.5")).toThrow(/0\.\.65535/);
  });

  it("rejects a port above the TCP range", () => {
    expect(() => parsePort("65536")).toThrow(/0\.\.65535/);
    expect(() => parsePort("70000")).toThrow(/0\.\.65535/);
  });
});

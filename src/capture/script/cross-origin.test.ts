import { describe, it, expect } from "vitest";
import { parseCrossOriginAllowlist, frameHostAllowed } from "./cross-origin.js";

describe("parseCrossOriginAllowlist (DM-1442)", () => {
  it("returns null for empty / whitespace / undefined", () => {
    expect(parseCrossOriginAllowlist(undefined)).toBeNull();
    expect(parseCrossOriginAllowlist(null)).toBeNull();
    expect(parseCrossOriginAllowlist("")).toBeNull();
    expect(parseCrossOriginAllowlist("   ")).toBeNull();
    expect(parseCrossOriginAllowlist(",")).toBeNull();
    expect(parseCrossOriginAllowlist(" , , ")).toBeNull();
  });

  it("parses the wildcard", () => {
    expect(parseCrossOriginAllowlist("*")).toBe("*");
    expect(parseCrossOriginAllowlist("  *  ")).toBe("*");
  });

  it("a bare * anywhere in the list collapses to recurse-all", () => {
    expect(parseCrossOriginAllowlist("a.com,*,b.com")).toBe("*");
  });

  it("parses host-only entries (any port), lowercasing the host", () => {
    expect(parseCrossOriginAllowlist("Example.com")).toEqual([{ host: "example.com", port: null }]);
    expect(parseCrossOriginAllowlist("a.com, b.com")).toEqual([
      { host: "a.com", port: null },
      { host: "b.com", port: null },
    ]);
  });

  it("parses host:port entries", () => {
    expect(parseCrossOriginAllowlist("maps.google.com:443,localhost:3000")).toEqual([
      { host: "maps.google.com", port: "443" },
      { host: "localhost", port: "3000" },
    ]);
  });

  it("treats a trailing non-numeric colon segment as part of the host (no port)", () => {
    // Not a real-world host, but the last-colon split must not misclassify it.
    expect(parseCrossOriginAllowlist("weird:host")).toEqual([{ host: "weird:host", port: null }]);
  });
});

describe("frameHostAllowed (DM-1442)", () => {
  it("null allowlist never matches", () => {
    expect(frameHostAllowed("https://a.com/", null)).toBe(false);
  });

  it("wildcard matches everything (incl. unusual URLs)", () => {
    const all = parseCrossOriginAllowlist("*");
    expect(frameHostAllowed("https://a.com/", all)).toBe(true);
    expect(frameHostAllowed("http://localhost:3000/x", all)).toBe(true);
  });

  it("host-only entry matches on any port", () => {
    const list = parseCrossOriginAllowlist("example.com");
    expect(frameHostAllowed("https://example.com/", list)).toBe(true);
    expect(frameHostAllowed("http://example.com:8080/a", list)).toBe(true);
    expect(frameHostAllowed("https://example.com:1234/", list)).toBe(true);
  });

  it("host:port entry requires an exact port, normalizing default ports", () => {
    const list = parseCrossOriginAllowlist("maps.google.com:443");
    // https default port (443) — normalized from an empty u.port
    expect(frameHostAllowed("https://maps.google.com/", list)).toBe(true);
    expect(frameHostAllowed("https://maps.google.com:443/x", list)).toBe(true);
    // wrong port
    expect(frameHostAllowed("http://maps.google.com/", list)).toBe(false);
    expect(frameHostAllowed("https://maps.google.com:8443/", list)).toBe(false);
  });

  it("localhost:port matches the same port only", () => {
    const list = parseCrossOriginAllowlist("localhost:3000");
    expect(frameHostAllowed("http://localhost:3000/", list)).toBe(true);
    expect(frameHostAllowed("http://localhost:3001/", list)).toBe(false);
    expect(frameHostAllowed("http://localhost/", list)).toBe(false); // http default 80 ≠ 3000
  });

  it("exact host only — subdomains do NOT match (docs/81 decision)", () => {
    const list = parseCrossOriginAllowlist("example.com");
    expect(frameHostAllowed("https://www.example.com/", list)).toBe(false);
    expect(frameHostAllowed("https://example.com.evil.com/", list)).toBe(false);
  });

  it("host comparison is case-insensitive", () => {
    const list = parseCrossOriginAllowlist("Example.COM");
    expect(frameHostAllowed("https://EXAMPLE.com/", list)).toBe(true);
  });

  it("a specific allowlist returns false for an unparseable / relative URL", () => {
    const list = parseCrossOriginAllowlist("example.com");
    expect(frameHostAllowed("not a url", list)).toBe(false);
    expect(frameHostAllowed("/relative/path", list)).toBe(false);
    expect(frameHostAllowed("", list)).toBe(false);
  });

  it("wildcard recurses regardless of URL parseability (recurse-all semantics)", () => {
    // `*` only reaches here once the frame's contentDocument is already
    // accessible; host-matching is moot, so it short-circuits to true.
    expect(frameHostAllowed("not a url", "*")).toBe(true);
  });

  it("matches the first applicable entry in a multi-entry list", () => {
    const list = parseCrossOriginAllowlist("a.com,b.com:8080,c.com");
    expect(frameHostAllowed("https://b.com:8080/", list)).toBe(true);
    expect(frameHostAllowed("https://b.com/", list)).toBe(false); // b.com pinned to 8080
    expect(frameHostAllowed("https://c.com:9999/", list)).toBe(true); // c.com any port
    expect(frameHostAllowed("https://d.com/", list)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { resolveFontKey } from "./text-to-path.js";

// Pinned mappings for the CSS generic-family keywords. These exist to lock
// the fidelity-critical resolutions Chrome on macOS performs (per Blink's
// font_cache_mac.mm) — substituting any of these silently shifts every
// page's text metrics. See DM-236 (monospace was wrongly routed to SF Mono)
// and SK-1124 (sans-serif was wrongly routed to SF Pro).
describe("resolveFontKey: generic-family resolution", () => {
  it("routes sans-serif to Helvetica, not SF Pro", () => {
    expect(resolveFontKey("sans-serif")).toBe("helvetica");
    expect(resolveFontKey("ui-sans-serif")).toBe("helvetica");
  });

  it("routes monospace to Courier, not SF Mono or Menlo", () => {
    expect(resolveFontKey("monospace")).toBe("courier");
    expect(resolveFontKey("ui-monospace")).toBe("courier");
  });

  it("routes serif to Times, not Georgia", () => {
    expect(resolveFontKey("serif")).toBe("times");
    expect(resolveFontKey("ui-serif")).toBe("times");
  });

  it("routes system-ui / -apple-system / BlinkMacSystemFont to SF Pro", () => {
    expect(resolveFontKey("system-ui")).toBe("sf-pro");
    expect(resolveFontKey("-apple-system")).toBe("sf-pro");
    expect(resolveFontKey("BlinkMacSystemFont")).toBe("sf-pro");
  });

  it("routes cursive to Snell Roundhand", () => {
    expect(resolveFontKey("cursive")).toBe("snell");
  });
});

describe("resolveFontKey: explicit-name resolution", () => {
  it("honors author-named monospace families separately", () => {
    expect(resolveFontKey("Menlo")).toBe("menlo");
    expect(resolveFontKey("Monaco")).toBe("monaco");
    expect(resolveFontKey("Courier")).toBe("courier");
    expect(resolveFontKey("Courier New")).toBe("courier");
    expect(resolveFontKey("SF Mono")).toBe("sf-mono");
  });

  it("honors author-named sans families separately", () => {
    expect(resolveFontKey("Helvetica")).toBe("helvetica");
    expect(resolveFontKey("Helvetica Neue")).toBe("helvetica");
    expect(resolveFontKey("Arial")).toBe("arial");
  });

  it("honors author-named serif families separately", () => {
    expect(resolveFontKey("Georgia")).toBe("georgia");
    expect(resolveFontKey("Times New Roman")).toBe("times");
  });

  it("is case-insensitive and strips quotes", () => {
    expect(resolveFontKey("MONOSPACE")).toBe("courier");
    expect(resolveFontKey('"Helvetica Neue"')).toBe("helvetica");
    expect(resolveFontKey("'SF Mono'")).toBe("sf-mono");
  });
});

describe("resolveFontKey: chain walking", () => {
  it("picks the first recognized name in the stack", () => {
    expect(resolveFontKey('"DoesNotExist", monospace')).toBe("courier");
    expect(resolveFontKey("DoesNotExist, Helvetica, sans-serif")).toBe("helvetica");
    expect(resolveFontKey("Menlo, Consolas, monospace")).toBe("menlo");
  });

  it("falls through to Helvetica when nothing matches (Chrome's macOS fallback)", () => {
    expect(resolveFontKey("Nothing-Installed-1, Nothing-Installed-2")).toBe("helvetica");
    expect(resolveFontKey("")).toBe("helvetica");
  });
});

import type { Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { loadInputIntoPage, parsePort, shouldOpenInBrowser } from "./common.js";

describe("openInBrowser", () => {
  it("permits interactive CLI use but fails closed without a TTY", () => {
    expect(shouldOpenInBrowser({}, true)).toBe(true);
    expect(shouldOpenInBrowser({}, false)).toBe(false);
    expect(shouldOpenInBrowser({ DOMOTION_OPEN_BROWSER: "1" }, false)).toBe(true);
  });

  it("rejects automation sentinels even when a TTY or explicit opt-in is present", () => {
    expect(shouldOpenInBrowser({ VITEST: "true" }, true)).toBe(false);
    expect(shouldOpenInBrowser({ DOMOTION_NO_OPEN: "1", DOMOTION_OPEN_BROWSER: "1" }, true)).toBe(false);
    expect(shouldOpenInBrowser({ CI: "true", DOMOTION_OPEN_BROWSER: "1" }, true)).toBe(false);
    expect(shouldOpenInBrowser({ CODEX_CI: "1", DOMOTION_OPEN_BROWSER: "1" }, true)).toBe(false);
    expect(shouldOpenInBrowser({ CODEX_SESSION_ID: "session", DOMOTION_OPEN_BROWSER: "1" }, true)).toBe(false);
    expect(shouldOpenInBrowser({ CODEX_THREAD_ID: "thread", DOMOTION_OPEN_BROWSER: "1" }, true)).toBe(false);
    expect(shouldOpenInBrowser({ HOTSHEET_DRIVE_SPAWNED: "1", DOMOTION_OPEN_BROWSER: "1" }, true)).toBe(false);
  });

  it("inherits Vitest's no-open environment in the real test process", () => {
    expect(shouldOpenInBrowser()).toBe(false);
  });
});

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

describe("loadInputIntoPage navigation readiness", () => {
  it("uses load by default so persistent requests cannot block capture", async () => {
    const goto = vi.fn().mockResolvedValue(null);
    await loadInputIntoPage({ goto } as unknown as Page, "https://example.test/");
    expect(goto).toHaveBeenCalledWith("https://example.test/", { waitUntil: "load" });
  });

  it("supports an explicit network-idle wait", async () => {
    const goto = vi.fn().mockResolvedValue(null);
    await loadInputIntoPage({ goto } as unknown as Page, "https://example.test/", { networkIdle: true });
    expect(goto).toHaveBeenCalledWith("https://example.test/", { waitUntil: "networkidle" });
  });
});

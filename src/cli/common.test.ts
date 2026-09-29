import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import {
  UsageError,
  errorMessage,
  exitCodeFor,
  formatConfigIssues,
  loadInputIntoPage,
  parseNonNegativeInt,
  parsePort,
  parsePositiveInt,
  shouldOpenInBrowser,
  writeOutput,
} from "./common.js";

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

describe("exit-code contract (2 = usage, 1 = runtime)", () => {
  it("maps UsageError to 2 and everything else to 1", () => {
    expect(exitCodeFor(new UsageError("bad flag"))).toBe(2);
    expect(exitCodeFor(new Error("boom"))).toBe(1);
    expect(
      exitCodeFor(Object.assign(new TypeError("Unknown option '--x'"), { code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" })),
    ).toBe(2);
    expect(exitCodeFor(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe(1);
    expect(exitCodeFor("string")).toBe(1);
    expect(exitCodeFor(undefined)).toBe(1);
  });

  it("flag parsers signal usage errors, not runtime ones", () => {
    for (const run of [
      () => parsePositiveInt("0", "width"),
      () => parsePort("99999"),
      () => parseNonNegativeInt("-1", "wait"),
    ]) {
      try {
        run();
        expect.unreachable();
      } catch (error) {
        expect(exitCodeFor(error)).toBe(2);
      }
    }
  });

  it("parseNonNegativeInt accepts 0 (a valid --wait) and rejects fractions and junk", () => {
    expect(parseNonNegativeInt("0", "wait")).toBe(0);
    expect(parseNonNegativeInt("250", "wait")).toBe(250);
    expect(parseNonNegativeInt(undefined, "wait")).toBeUndefined();
    expect(() => parseNonNegativeInt("1.5", "wait")).toThrow(/non-negative integer/);
    expect(() => parseNonNegativeInt("x", "wait")).toThrow(/non-negative integer/);
  });

  it("errorMessage reads an Error and stringifies anything else", () => {
    expect(errorMessage(new Error("a"))).toBe("a");
    expect(errorMessage("b")).toBe("b");
    expect(errorMessage(3)).toBe("3");
  });
});

describe("formatConfigIssues", () => {
  it("lists every issue with array indexes as [n], so one run reports all of them", () => {
    const text = formatConfigIssues({
      issues: [
        { path: ["layers", 0, "svg"], message: "Required" },
        { path: ["layers", 2, "x"], message: "Expected number" },
        { path: [], message: "top-level" },
      ],
    });
    expect(text).toBe("layers[0].svg: Required; layers[2].x: Expected number; top-level");
  });
});

describe("writeOutput", () => {
  it("creates missing parent directories for the output path", () => {
    const dir = mkdtempSync(join(tmpdir(), "domotion-out-"));
    try {
      const out = join(dir, "nested", "deeper", "a.svg");
      writeOutput("<svg/>", out, false);
      expect(readFileSync(out, "utf8")).toBe("<svg/>");
      const gz = join(dir, "other", "b.svgz");
      writeOutput("<svg/>", gz, true);
      expect(readFileSync(gz).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

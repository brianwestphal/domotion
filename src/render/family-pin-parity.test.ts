// Family-matching parity for the hardcoded per-name pins in
// `matchFamilyNameToKey` — each one either mirrors a rule Blink actually runs
// (cited below at checkout rev 7d859f27) or must not exist.
//
// The shared shape of every bug tested here: a name was PINNED to a
// plausible-looking key, where Blink's rule is "look the name up; on failure
// walk to the NEXT family in the stack". A pin and the walk agree on
// single-name stacks (both end at the standard-font terminal), so bare-name
// probes could never discriminate them — only stacks with a later family can,
// and these tests use exactly those.
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import {
  resolveFontKey, resolveFontSpec,
  getSystemFallbackResolution, setSystemFallbackResolution,
} from "./font-resolution.js";
import { withHostPlatform } from "./host-platform.js";

// The live per-codepoint/nomination resolvers ask the REAL host's font system;
// these tests assert the platform-independent pin/walk logic, so pin the
// resolver off for the whole file (same pattern as text-to-path.test.ts).
let prevResolver: boolean;
beforeAll(() => { prevResolver = getSystemFallbackResolution(); setSystemFallbackResolution(false); });
afterAll(() => { setSystemFallbackResolution(prevResolver); });

describe("Consolas has no pin (alternate_font_family.h:72-105 — no alias; uninstalled names are walked past)", () => {
  it("walks past an uninstalled Consolas to the next family instead of pinning Courier", () => {
    withHostPlatform("darwin", () => {
      const key = resolveFontKey("Consolas, Menlo, monospace");
      // Chrome paints Menlo here on a Mac without Consolas; on an MS-Office
      // Mac it resolves Consolas itself (a dynamic sysfb: key via the
      // installed-font probe). Either answer is Chrome's; Courier is not.
      expect(key).not.toBe("courier");
      expect(key === "menlo" || key.startsWith("sysfb:")).toBe(true);
    });
  });
});

describe("Courier New is a direct match; the Courier alias fires only on lookup failure (font_platform_data_cache.cc:74-105)", () => {
  it("resolves the installed Courier New face on macOS instead of pre-empting it with the alias", () => {
    withHostPlatform("darwin", () => {
      const spec = resolveFontSpec("courier-new");
      // The dedicated key must EXIST in the darwin table (same four-sibling
      // shape as times-new-roman); whether its file is on THIS host decides
      // which half of Blink's rule applies below.
      expect(spec).not.toBeNull();
      const installed = spec?.path != null && spec.path !== "" && existsSync(spec.path);
      // Stock macOS ships Courier New under Supplemental; a host without it
      // takes the failure-path alias (the !IS_WIN direction of
      // AlternateFamilyName), which is also Chrome's behavior there.
      expect(resolveFontKey('"Courier New", monospace')).toBe(installed ? "courier-new" : "courier");
    });
  });

  it("on win32 the New→plain alias does not exist (alternate_font_family.h:78-85 is !IS_WIN)", () => {
    withHostPlatform("win32", () => {
      const spec = resolveFontSpec("courier-new");
      const installed = spec?.path != null && spec.path !== "" && existsSync(spec.path);
      const key = resolveFontKey('"Courier New", Georgia');
      // Real Windows host: cour.ttf resolves → the dedicated key. Simulated
      // win32 on another OS: the file is absent, and Blink-on-Windows has no
      // Courier retry — the walk continues to Georgia. Never plain `courier`.
      expect(key).toBe(installed ? "courier-new" : "georgia");
    });
  });
});

describe("ui-serif is not a Blink generic (css_value_keywords.json5:173-181; ConsumeGenericFamily spans serif..math, css_parsing_utils.cc:6344-6346)", () => {
  it("walks past ui-serif to the next declared family instead of pinning Times", () => {
    withHostPlatform("darwin", () => {
      expect(resolveFontKey("ui-serif, Georgia")).toBe("georgia");
    });
  });

  it("bare ui-serif still lands on the standard-font terminal (skip-then-terminal, the case the old probe measured)", () => {
    withHostPlatform("darwin", () => {
      expect(resolveFontKey("ui-serif")).toBe("times");
    });
  });
});

describe("BlinkMacSystemFont → system-ui is #if BUILDFLAG(IS_MAC) (style_builder_converter.cc:552-563)", () => {
  it("maps to the system font on darwin", () => {
    withHostPlatform("darwin", () => {
      expect(resolveFontKey("BlinkMacSystemFont, Georgia")).toBe("sf-pro");
    });
  });

  it("is an ordinary unmatchable name off macOS — the stack walks on", () => {
    withHostPlatform("win32", () => {
      expect(resolveFontKey("BlinkMacSystemFont, Georgia")).toBe("georgia");
    });
    withHostPlatform("linux", () => {
      expect(resolveFontKey("BlinkMacSystemFont, Georgia")).toBe("georgia");
    });
  });

  it("the canonical -apple-system stack converges on every platform (the case that hid the bug)", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      withHostPlatform(platform, () => {
        const key = resolveFontKey('-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, sans-serif');
        // darwin: BlinkMacSystemFont → sf-pro. win32/linux: it walks on, and
        // "Segoe UI"/Helvetica pick up the stack (the sf-pro key IS Segoe UI
        // on win32) — matching Chrome's convergence, not by accident anymore.
        expect(key === "sf-pro" || key === "helvetica" || key.startsWith("sysfb:") || key.startsWith("winfam:")).toBe(true);
      });
    }
  });
});

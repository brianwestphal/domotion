import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  __resolveDarwinFontSpecForTest,
  platformFontKeys,
  resolveFontSpec,
} from "./font-resolution.js";

interface AuditedFontSpec {
  path: string;
  optionalInstall?: boolean;
}

function missingRequiredPaths(
  keys: readonly string[],
  resolve: (key: string) => AuditedFontSpec | null,
  pathExists: (path: string) => boolean,
): string[] {
  const missing: string[] = [];
  for (const key of keys) {
    const spec = resolve(key);
    // A key with no entry on this host is a legitimate miss (the resolver
    // falls through). Author-installed candidates are equally legitimate
    // misses, but a missing OS-owned path remains a table defect.
    if (spec?.path == null || spec.path === "" || spec.optionalInstall === true) continue;
    if (!pathExists(spec.path)) missing.push(`${key} -> ${spec.path}`);
  }
  return missing;
}

/**
 * The path tables hardcode where each system font lived when the entry was
 * written, and the OS moves them. On current macOS every PingFang key declared
 * `/System/Library/Fonts/PingFang.ttc`, which no longer exists — the faces ship
 * inside `FontServices.framework/…/Reserved/PingFangUI.ttc` now (DM-1861).
 *
 * That went unnoticed because those entries are `extractor: "native"`: the
 * helper opens them by PostScript name through CoreText, so the declared path
 * is never dereferenced on the happy path. It still matters, because
 * `resolveFontSpec(key).path` is read directly elsewhere — most visibly by the
 * embedded-subset builder, which reads those bytes.
 *
 * This is the audit that found it, kept as a standing check: every OS-owned key
 * the platform table can resolve must name a file that is actually there.
 * Author-installed candidates are explicitly marked and may be absent, matching
 * Blink's family-stack walk (`font_cache.cc:176-190` and
 * `font_fallback_iterator.cc:150-178`, Chromium rev 7d859f271c).
 */
describe("font path table integrity (DM-1861)", () => {
  it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "every required resolvable key names a file that exists on this host",
    () => {
      const keys = platformFontKeys();
      // Sanity: the table was found and parsed, so a green result means something.
      expect(keys.length).toBeGreaterThan(20);
      expect(missingRequiredPaths(keys, resolveFontSpec, existsSync)).toEqual([]);
    },
  );

  it("models both installed and absent states for optional macOS author fonts", () => {
    const optionalKeys = [
      "source-serif-pro",
      "source-serif-pro-bold",
      "source-serif-pro-italic",
      "source-serif-pro-bold-italic",
      "playfair-display",
      "playfair-display-bold",
      "playfair-display-italic",
      "playfair-display-bold-italic",
      "u-noto-sans",
      "u-noto-sans-kr",
    ] as const;

    for (const key of optionalKeys) {
      const spec = __resolveDarwinFontSpecForTest(key);
      expect(spec, key).toMatchObject({ optionalInstall: true });
      // Installed: the declared candidate is valid. Absent: the same optional
      // candidate is not a broken system table entry and the renderer's family
      // walk remains free to continue to the next CSS family.
      expect(missingRequiredPaths([key], __resolveDarwinFontSpecForTest, () => true)).toEqual([]);
      expect(missingRequiredPaths([key], __resolveDarwinFontSpecForTest, () => false)).toEqual([]);
    }

    const unmarkedAuthorPaths = platformFontKeys()
      .map((key) => [key, __resolveDarwinFontSpecForTest(key)] as const)
      .filter(([, spec]) => spec?.path.startsWith("/Library/Fonts/") && spec.optionalInstall !== true)
      .map(([key]) => key);
    expect(unmarkedAuthorPaths).toEqual([]);

    const required = __resolveDarwinFontSpecForTest("helvetica");
    expect(required?.optionalInstall).not.toBe(true);
    expect(missingRequiredPaths(["helvetica"], __resolveDarwinFontSpecForTest, () => false))
      .toEqual([`helvetica -> ${required?.path}`]);
  });

  it("keeps regenerated /Library font routes optional", () => {
    const generator = readFileSync("tools/probe-983-genroutes-darwin.mjs", "utf8");
    expect(generator).toContain('path.startsWith("/Library/Fonts/") ? ", optionalInstall: true"');
    expect(generator).toContain("family: string; path: string;");
  });
});

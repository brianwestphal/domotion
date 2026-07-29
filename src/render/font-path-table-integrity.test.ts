import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveFontSpec } from "./font-resolution.js";

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
 * This is the audit that found it, kept as a standing check: every key the
 * platform table can resolve must name a file that is actually there. It reads
 * the key list out of the source so a newly added entry is covered without
 * anyone remembering to update a list here.
 */
describe("font path table integrity (DM-1861)", () => {
  const TABLE = {
    darwin: ["const FONT_PATHS", "const LINUX_FONT_PATHS"],
    linux: ["const LINUX_FONT_PATHS", "const WIN32_FONT_PATHS"],
  } as const;

  const bounds = TABLE[process.platform as keyof typeof TABLE];

  it.skipIf(bounds == null)("every resolvable key names a file that exists on this host", () => {
    const src = readFileSync(new URL("./font-resolution.ts", import.meta.url), "utf8");
    const start = src.indexOf(bounds![0]);
    const end = src.indexOf(bounds![1]);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const keys = [...new Set(
      [...src.slice(start, end).matchAll(/^\s*"([a-z0-9-]+)":\s*\{/gim)].map((m) => m[1]),
    )];
    // Sanity: the table was found and parsed, so a green result means something.
    expect(keys.length).toBeGreaterThan(20);

    const missing: string[] = [];
    for (const key of keys) {
      const spec = resolveFontSpec(key);
      // A key with no entry on this host is a legitimate miss (the resolver
      // falls through); only a DECLARED path that isn't there is the defect.
      if (spec?.path == null || spec.path === "") continue;
      if (!existsSync(spec.path)) missing.push(`${key} -> ${spec.path}`);
    }

    expect(missing).toEqual([]);
  });
});

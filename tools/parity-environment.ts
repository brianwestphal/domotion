import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { platform, release, arch } from "node:os";
import { platformFontKeys, shapingFaceFor } from "../src/render/font-resolution.js";

function revision(repo: string, ref = "HEAD"): string {
  try { return execFileSync("git", ["-C", repo, "rev-parse", "--short=12", ref], { encoding: "utf8" }).trim(); }
  catch { return "unavailable"; }
}

function fontInventoryDigest(): string {
  const rows = platformFontKeys().map((key) => {
    const f = shapingFaceFor(key, 400, 16, 0);
    return f == null ? `${key}:missing` : `${key}:${f.path}#${f.faceIndex}:${JSON.stringify(f.axes)}`;
  }).sort();
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

export function parityEnvironment(input: {
  chromium: string; launchFlags: string[]; deviceScaleFactor: number; zoom: number;
  writingMode: string; direction: string; corpusIdentity: string; sampleIdentity: string;
}): Record<string, unknown> {
  return {
    chromium: { version: input.chromium, launchFlags: input.launchFlags },
    host: { os: platform(), release: release(), architecture: arch() },
    fonts: { inventoryDigest: fontInventoryDigest(), genericPreferences: "platform-session-resolver" },
    locale: { process: Intl.DateTimeFormat().resolvedOptions().locale, languages: process.env.LANG ?? "unset" },
    helper: { implementation: `${process.platform}-glyph-helper`, buildRecipe: "repository-native-helper", disabled: process.env.DOMOTION_DISABLE_HELPER === "1" },
    runtimes: {
      node: process.version, icu: process.versions.icu, unicode: process.versions.unicode,
      chromiumSource: revision("external/chromium"), harfbuzzSource: revision("external/harfbuzz"),
      skiaPinned: revision("external/skia", "62efacd3"),
    },
    viewport: { deviceScaleFactor: input.deviceScaleFactor, zoom: input.zoom, writingMode: input.writingMode, direction: input.direction },
    corpus: { identity: input.corpusIdentity, sample: input.sampleIdentity, cacheIsolation: "new-process/new-document", resources: "inline-or-host-inventory" },
  };
}

export function fingerprintComplete(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value !== "" && value !== "unknown" && value !== "unavailable";
  if (Array.isArray(value)) return value.every(fingerprintComplete);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).every(fingerprintComplete);
  return true;
}

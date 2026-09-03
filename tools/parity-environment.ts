import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { platform, release, arch } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platformFontKeys, shapingFaceFor } from "../src/render/font-resolution.js";

type SourceAuthority = "chromium" | "harfbuzz" | "skia" | "icu";

export function sourceAuthorityPinsFromManifest(raw: string): Partial<Record<SourceAuthority, string>> {
  try {
    const value = JSON.parse(raw) as { pins?: Partial<Record<SourceAuthority, unknown>> };
    const output: Partial<Record<SourceAuthority, string>> = {};
    for (const key of ["chromium", "harfbuzz", "skia", "icu"] as const) {
      const pin = value.pins?.[key];
      if (typeof pin === "string" && pin.trim() !== "") output[key] = pin.trim();
    }
    return output;
  } catch {
    return {};
  }
}

function materializedRevision(authority: SourceAuthority): string | undefined {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const raw = readFileSync(resolve(root, "external/.domotion-source-authorities.json"), "utf8");
    return sourceAuthorityPinsFromManifest(raw)[authority];
  } catch {
    return undefined;
  }
}

function revision(repo: string, ref: string, environmentKey: string, authority: SourceAuthority): string {
  const supplied = process.env[environmentKey]?.trim();
  if (supplied != null && supplied !== "") return supplied;
  try {
    return execFileSync("git", ["-C", repo, "rev-parse", "--short=12", ref], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return materializedRevision(authority) ?? "unavailable";
  }
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
      chromiumSource: revision("external/chromium", "HEAD", "DOMOTION_CHROMIUM_REVISION", "chromium"),
      harfbuzzSource: revision("external/harfbuzz", "HEAD", "DOMOTION_HARFBUZZ_REVISION", "harfbuzz"),
      skiaPinned: revision("external/skia", "62efacd3", "DOMOTION_SKIA_REVISION", "skia"),
      icuSource: revision("external/chromium/third_party/icu", "HEAD", "DOMOTION_ICU_SOURCE_REVISION", "icu"),
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

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WebfontRegistration } from "../../src/capture/index.js";
import type { CapturedElement, CaptureWarning } from "../../src/capture/types.js";
import { captureFlagsCacheToken, expectedCachePlatformDir } from "../harness-browsers.js";
import { inventoryDocument } from "../../tools/font-inventory.mjs";
import { playwrightVersion } from "../../scripts/run-env.mjs";

/** A `WebfontRegistration` with its bytes base64-encoded for the JSON entry. */
export type SerializedWebfontRegistration =
  | (Omit<Extract<WebfontRegistration, { kind: "webfont" }>, "bytes"> & { bytes: string })
  | Extract<WebfontRegistration, { kind: "local-alias" }>;

export interface ExpectedCacheMeta {
  bodyBg: string;
  /** The captured tree as this cache serialized it; key changes invalidate a stale shape. */
  tree?: CapturedElement[];
  warnings?: CaptureWarning[];
  /**
   * Every registration webfont discovery made on the miss. A hit skips the
   * source page, so it replays these into the fixture's own text-engine
   * session; without them the render would depend on whatever earlier
   * fixtures left in a shared registry. An entry without the field is a miss.
   */
  webfonts?: SerializedWebfontRegistration[];
}

/**
 * Bumped whenever an entry's shape gains a field a hit depends on, so older
 * entries become misses instead of hits that silently lack it.
 * v2: `webfonts` (per-fixture webfont replay).
 */
export const EXPECTED_CACHE_FORMAT = "v2";

export function serializeWebfontRegistrations(registrations: WebfontRegistration[]): SerializedWebfontRegistration[] {
  return registrations.map((r) => (r.kind === "webfont" ? { ...r, bytes: r.bytes.toString("base64") } : r));
}

export function deserializeWebfontRegistrations(registrations: SerializedWebfontRegistration[]): WebfontRegistration[] {
  return registrations.map((r) => (r.kind === "webfont" ? { ...r, bytes: Buffer.from(r.bytes, "base64") } : r));
}

function hashFileOrEmpty(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "missing";
  }
}

/** One expected-PNG cache namespace per run. The key includes every capture
 * input that can change the reference image, including live capture flags. */
export function createExpectedCache(options: {
  outputDir: string;
  packageRoot: string;
  width: number;
  dpr: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}) {
  const { outputDir, packageRoot, width, dpr } = options;
  const directory = resolve(outputDir, ".expected-cache", expectedCachePlatformDir(options.platform));
  const version: string = playwrightVersion() ?? "unknown";
  const scriptHash = hashFileOrEmpty(resolve(packageRoot, "src/capture/script.generated.ts"));
  const nodeHash = createHash("sha256")
    .update(hashFileOrEmpty(resolve(packageRoot, "src/capture/emoji.ts")))
    .update(hashFileOrEmpty(resolve(packageRoot, "src/capture/index.ts")))
    .update(hashFileOrEmpty(resolve(packageRoot, "src/capture/background-image-sizing.ts")))
    .update(hashFileOrEmpty(resolve(packageRoot, "src/capture/pseudo-fragment-cdp.ts")))
    .digest("hex");
  let fontDigest = "unknown";
  try {
    fontDigest = (inventoryDocument() as { digest: string }).digest;
  } catch {
    // Font inventory is diagnostic; a missing helper must not stop the suite.
  }
  return {
    directory,
    stats: { hits: 0, misses: 0 },
    key(htmlBytes: Buffer, height: number): string {
      return createHash("sha256")
        .update(htmlBytes)
        .update(
          `|${EXPECTED_CACHE_FORMAT}|${width}x${height}@${dpr}x|${version}|${scriptHash}|${nodeHash}|${fontDigest}${captureFlagsCacheToken(options.env)}`,
        )
        .digest("hex");
    },
    pngPath(key: string): string {
      return resolve(directory, `${key}.png`);
    },
    metaPath(key: string): string {
      return resolve(directory, `${key}.json`);
    },
    read(key: string, expectedPath: string): ExpectedCacheMeta | null {
      const png = resolve(directory, `${key}.png`);
      const metaPath = resolve(directory, `${key}.json`);
      if (existsSync(png) && existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, "utf8")) as ExpectedCacheMeta;
          if (meta.tree != null && Array.isArray(meta.webfonts)) {
            copyFileSync(png, expectedPath);
            this.stats.hits++;
            return meta;
          }
        } catch {
          // Corrupt/legacy cache entries become misses and are regenerated.
        }
      }
      this.stats.misses++;
      return null;
    },
    write(key: string, expectedPath: string, meta: ExpectedCacheMeta): void {
      try {
        mkdirSync(directory, { recursive: true });
        copyFileSync(expectedPath, resolve(directory, `${key}.png`));
        writeFileSync(resolve(directory, `${key}.json`), JSON.stringify(meta));
      } catch {
        // The cache only saves time; a failed write must not fail the fixture.
      }
    },
  };
}

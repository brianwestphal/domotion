import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withOs2FsType } from "@domotion/text-engine/testing";

/** OS/2 fsType bit 1: Restricted License embedding. */
export const FS_TYPE_RESTRICTED_LICENSE = 0x0002;

/**
 * A real, Chromium-loadable TrueType face whose OS/2 `fsType` declares
 * Restricted License embedding: the committed Domotion fixture serif
 * (IBMPlexSerif-Regular subset) with only that field rewritten. Browser tests
 * serve it as an `@font-face` webfont to drive the restricted-embedding
 * warning end to end.
 */
export function restrictedEmbeddingFont(): Buffer {
  const source = readFileSync(
    fileURLToPath(
      new URL("../../packages/text-engine/assets/fonts/fixture/DomotionFixtureSerif-Regular.ttf", import.meta.url),
    ),
  );
  return withOs2FsType(source, FS_TYPE_RESTRICTED_LICENSE);
}

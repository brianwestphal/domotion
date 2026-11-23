import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";

interface IcuReleaseEvidence {
  digest: { protocolVersion: string; icuVersion: string; codepoints: number; assigned: number; fnv1a64: string };
  linuxArm64: { executableSha256: string; dataSha256: string };
}

const releases = createRequire(import.meta.url)("../icu-companion-releases.json") as Record<string, IcuReleaseEvidence>;

export function pinnedIcuRelease(version: string): IcuReleaseEvidence {
  const release = releases[`icu-v${version}`];
  if (release == null) throw new Error(`No ratified ICU companion release evidence for ${version}`);
  return release;
}

export function matchesIcuReleaseDigest(version: string, digest: unknown): boolean {
  return isDeepStrictEqual(digest, pinnedIcuRelease(version).digest);
}

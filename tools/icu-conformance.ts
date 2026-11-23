import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireIcuCompanionSync, ICU_COMPANION_VERSION } from "@domotion/text-engine/testing";

import { matchesIcuReleaseDigest, pinnedIcuRelease } from "./lib/icu-companion-release.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const local = path.join(
  ROOT,
  "packages",
  "text-engine",
  "tools",
  "icu-helper",
  process.platform === "win32" ? "domotion-icu.exe" : "domotion-icu",
);
const helper = process.env.DOMOTION_ICU_HELPER_PATH ?? (existsSync(local) ? local : acquireIcuCompanionSync());
if (helper == null) {
  process.stderr.write("ICU companion unavailable\n");
  process.exit(2);
}
const result = spawnSync(helper, ["--digest"], { encoding: "utf8", timeout: 120_000 });
if (result.status !== 0) {
  process.stderr.write(result.stderr || `ICU digest exited ${result.status}\n`);
  process.exit(1);
}
const digest: unknown = JSON.parse(result.stdout);
const ok = matchesIcuReleaseDigest(ICU_COMPANION_VERSION, digest);
process.stdout.write(`${JSON.stringify(digest)}\n`);
if (!ok) {
  process.stderr.write(`expected ${JSON.stringify(pinnedIcuRelease(ICU_COMPANION_VERSION).digest)}\n`);
  process.exit(1);
}

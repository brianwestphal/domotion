import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireIcuCompanionSync } from "../src/render/icu-helper-acquire.js";

interface Digest {
  protocolVersion: string;
  icuVersion: string;
  codepoints: number;
  assigned: number;
  fnv1a64: string;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const local = path.join(ROOT, "tools", "icu-helper", process.platform === "win32" ? "domotion-icu.exe" : "domotion-icu");
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
const digest = JSON.parse(result.stdout) as Digest;
const expected = {
  protocolVersion: "1",
  icuVersion: "78.2",
  codepoints: 0x110000,
  assigned: 299382,
  fnv1a64: "6c5c14d607f8d945",
};
const ok = Object.entries(expected).every(([key, value]) => digest[key as keyof Digest] === value);
process.stdout.write(`${JSON.stringify(digest)}\n`);
if (!ok) {
  process.stderr.write(`expected ${JSON.stringify(expected)}\n`);
  process.exit(1);
}

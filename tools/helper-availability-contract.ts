import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  helperAvailabilityContract,
  type HelperAvailabilityContract,
} from "../src/render/helper-availability-contract.js";
import { isGlyphHelperAvailable } from "../src/render/glyph-helper.js";

type SupportedPlatform = "darwin" | "linux" | "win32";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function helperPath(platform: SupportedPlatform): string {
  if (process.env.DOMOTION_HELPER_PATH) return resolve(process.env.DOMOTION_HELPER_PATH);
  return resolve(
    "tools",
    platform === "darwin" ? "macos-glyph-extractor" :
      platform === "linux" ? "linux-glyph-extractor" : "win32-glyph-extractor",
    platform === "win32" ? "domotion-glyph-paths.exe" : "domotion-glyph-paths",
  );
}

function authenticatedIdentity(path: string): string {
  if (!existsSync(path)) throw new Error(`native helper is unavailable: ${path}`);
  const version = execFileSync(path, ["--version"], { encoding: "utf8" }).trim();
  if (version === "") throw new Error("native helper returned an empty --version identity");
  return createHash("sha256").update(version).update("\0").update(readFileSync(path)).digest("hex");
}

function validatePair(present: HelperAvailabilityContract, absent: HelperAvailabilityContract): void {
  if (present.platform !== absent.platform) throw new Error("report platforms differ");
  if (present.mode !== "helper-present" || present.verdict !== "exact-native-route") {
    throw new Error("enabled arm did not authenticate the native route");
  }
  if (absent.mode !== "helper-absent" || absent.reason !== "explicitly-disabled"
      || absent.verdict !== "explicit-degraded-route") {
    throw new Error("disabled arm did not enter the explicit degraded route");
  }
  if (present.cacheIdentity === absent.cacheIdentity) {
    throw new Error("helper-present and helper-absent cache identities collided");
  }
  for (const fact of ["installedFaceNomination", "systemFallbackOrdering", "nativeTraitsAndAxes", "nativeGlyphGeometry"] as const) {
    if (present.logicalFacts[fact] !== "native-observed" || absent.logicalFacts[fact] !== "withheld") {
      throw new Error(`${fact} was not classified across the activation boundary`);
    }
  }
}

const compare = argument("--compare");
if (compare != null) {
  const [presentPath, absentPath] = compare.split(",");
  if (!presentPath || !absentPath) throw new Error("--compare expects present.json,absent.json");
  const present = JSON.parse(readFileSync(presentPath, "utf8")) as HelperAvailabilityContract;
  const absent = JSON.parse(readFileSync(absentPath, "utf8")) as HelperAvailabilityContract;
  validatePair(present, absent);
  process.stdout.write(JSON.stringify({ pass: true, platform: present.platform, present, absent }, null, 2) + "\n");
} else {
  if (process.platform !== "darwin" && process.platform !== "linux" && process.platform !== "win32") {
    throw new Error(`unsupported platform: ${process.platform}`);
  }
  const platform = process.platform;
  const disabled = process.env.DOMOTION_DISABLE_HELPER === "1";
  const path = helperPath(platform);
  const identity = authenticatedIdentity(path);
  const helperObserved = isGlyphHelperAvailable();
  if (helperObserved === disabled) {
    throw new Error(`DOMOTION_DISABLE_HELPER activation was inert (disabled=${disabled}, observed=${helperObserved})`);
  }
  const report = helperAvailabilityContract({
    platform,
    helperObserved,
    explicitlyDisabled: disabled,
    implementationIdentity: identity,
  });
  const out = argument("--out");
  const json = JSON.stringify(report, null, 2) + "\n";
  if (out) writeFileSync(out, json);
  process.stdout.write(json);
}

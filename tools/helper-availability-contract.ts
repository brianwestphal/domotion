import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  helperAvailabilityContract,
  type HelperAvailabilityContract,
  isGlyphHelperAvailable,
} from "@domotion/text-engine/testing";
import { z } from "zod";
import { flag, isMain, parseFlags, runMain } from "./lib/cli.js";
import { outcomeSchema, reportEnvelopeSchema, writeReport } from "./lib/report.js";

type SupportedPlatform = "darwin" | "linux" | "win32";
const REPORT_TOOL = "helper-availability-contract";
const contractSchema = z
  .object({
    version: z.literal("native-helper-availability-v1"),
    platform: z.enum(["darwin", "linux", "win32"]),
    mode: z.enum(["helper-present", "helper-absent"]),
    reason: z.enum(["native-helper-observed", "explicitly-disabled", "helper-unavailable"]),
    verdict: z.enum(["exact-native-route", "explicit-degraded-route"]),
    cacheIdentity: z.string(),
    logicalFacts: z
      .object({
        capturedWebfontBytes: z.literal("preserved"),
        deterministicStaticTermination: z.literal("preserved"),
        installedFaceNomination: z.enum(["native-observed", "withheld"]),
        systemFallbackOrdering: z.enum(["native-observed", "withheld"]),
        nativeTraitsAndAxes: z.enum(["native-observed", "withheld"]),
        nativeGlyphGeometry: z.enum(["native-observed", "withheld"]),
      })
      .strict(),
  })
  .strict();

export function readHelperAvailabilityReport(path: string): HelperAvailabilityContract {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (raw != null && typeof raw === "object" && ("tool" in raw || "data" in raw)) {
    const data = reportEnvelopeSchema(contractSchema.extend({ outcome: outcomeSchema }), {
      tool: REPORT_TOOL,
      schemaVersion: 1,
    }).parse(raw).data;
    if (data.outcome !== "pass") throw new Error("helper availability report outcome mismatch");
    const { outcome: _outcome, ...contract } = data;
    return contract as HelperAvailabilityContract;
  }
  return contractSchema.parse(raw) as HelperAvailabilityContract;
}

export function helperPath(platform: SupportedPlatform): string {
  if (process.env.DOMOTION_HELPER_PATH) return resolve(process.env.DOMOTION_HELPER_PATH);
  return resolve(
    "packages",
    "text-engine",
    "tools",
    platform === "darwin"
      ? "macos-glyph-extractor"
      : platform === "linux"
        ? "linux-glyph-extractor"
        : "win32-glyph-extractor",
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
  if (
    absent.mode !== "helper-absent" ||
    absent.reason !== "explicitly-disabled" ||
    absent.verdict !== "explicit-degraded-route"
  ) {
    throw new Error("disabled arm did not enter the explicit degraded route");
  }
  if (present.cacheIdentity === absent.cacheIdentity) {
    throw new Error("helper-present and helper-absent cache identities collided");
  }
  for (const fact of [
    "installedFaceNomination",
    "systemFallbackOrdering",
    "nativeTraitsAndAxes",
    "nativeGlyphGeometry",
  ] as const) {
    if (present.logicalFacts[fact] !== "native-observed" || absent.logicalFacts[fact] !== "withheld") {
      throw new Error(`${fact} was not classified across the activation boundary`);
    }
  }
}

export function runHelperAvailabilityContract(argv: string[]): number {
  const args = parseFlags(argv, { compare: { type: "string" }, out: { type: "string" } });
  const compare = flag(args, "compare");
  if (typeof compare === "string") {
    const [presentPath, absentPath] = compare.split(",");
    if (!presentPath || !absentPath) throw new Error("--compare expects present.json,absent.json");
    const present = readHelperAvailabilityReport(presentPath);
    const absent = readHelperAvailabilityReport(absentPath);
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
      throw new Error(
        `DOMOTION_DISABLE_HELPER activation was inert (disabled=${disabled}, observed=${helperObserved})`,
      );
    }
    const report = helperAvailabilityContract({
      platform,
      helperObserved,
      explicitlyDisabled: disabled,
      implementationIdentity: identity,
    });
    const out = flag(args, "out");
    const json = JSON.stringify(report, null, 2) + "\n";
    if (typeof out === "string") {
      writeReport(
        out,
        REPORT_TOOL,
        { ...report, outcome: "pass" },
        {
          schemaVersion: 1,
          env: { platform, mode: report.mode },
        },
      );
    }
    process.stdout.write(json);
  }
  return 0;
}

if (isMain(import.meta.url)) await runMain(() => runHelperAvailabilityContract(process.argv.slice(2)));

import { spawnSync } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { acquireIcuCompanionSync } from "./icu-helper-acquire.js";

export interface IcuCodepointProperties {
  cp: number;
  found: boolean;
  generalCategory: number;
  generalCategoryName: string;
  combiningClass: number;
  script: number;
  scriptName: string;
  scriptLongName: string;
  block: number;
  blockName: string;
  bidiClass: number;
  bidiPairedBracketType: number;
  eastAsianWidth: number;
  indicPositionalCategory: number;
  indicSyllabicCategory: number;
  lineBreak: number;
  verticalOrientation: number;
  binaryProperties: number;
  scriptExtensions: number[];
  scriptExtensionNames: string[];
}

export interface IcuResponse {
  protocolVersion: "1";
  icuVersion: "78.2";
  unicodeVersion: string;
  properties: IcuCodepointProperties[];
}

const ICU_PROTOCOL_VERSION = "1";
const ICU_VERSION = "78.2";

const NUMBER_FIELDS = [
  "cp",
  "generalCategory",
  "combiningClass",
  "script",
  "block",
  "bidiClass",
  "bidiPairedBracketType",
  "eastAsianWidth",
  "indicPositionalCategory",
  "indicSyllabicCategory",
  "lineBreak",
  "verticalOrientation",
  "binaryProperties",
] as const;
const STRING_FIELDS = ["generalCategoryName", "scriptName", "scriptLongName", "blockName"] as const;

function isIcuRow(value: unknown): value is IcuCodepointProperties {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (typeof row.found !== "boolean") return false;
  for (const field of NUMBER_FIELDS) if (typeof row[field] !== "number" || !Number.isFinite(row[field])) return false;
  for (const field of STRING_FIELDS) if (typeof row[field] !== "string") return false;
  if (!Array.isArray(row.scriptExtensions) || !row.scriptExtensions.every((n) => typeof n === "number")) return false;
  if (!Array.isArray(row.scriptExtensionNames) || !row.scriptExtensionNames.every((n) => typeof n === "string")) {
    return false;
  }
  return Number.isInteger(row.cp) && (row.cp as number) >= 0 && (row.cp as number) <= 0x10ffff;
}

/**
 * Parse one companion response. The binary is versioned separately from the package, so the envelope
 * (protocol and ICU versions, a `properties` array) is checked here rather than trusted; a row that does
 * not have the documented shape is dropped so it can never be memoized and later read as a real answer.
 * Any failure returns null — helper-absent mode is deliberately non-fatal.
 */
export function parseIcuResponse(text: string): IcuResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const envelope = parsed as Partial<Record<keyof IcuResponse, unknown>>;
  if (envelope.protocolVersion !== ICU_PROTOCOL_VERSION || envelope.icuVersion !== ICU_VERSION) return null;
  if (typeof envelope.unicodeVersion !== "string" || !Array.isArray(envelope.properties)) return null;
  return {
    protocolVersion: ICU_PROTOCOL_VERSION,
    icuVersion: ICU_VERSION,
    unicodeVersion: envelope.unicodeVersion,
    properties: envelope.properties.filter(isIcuRow),
  };
}

const memo = new Map<number, IcuCodepointProperties>();
// Routing normally asks about adjacent Unicode cells. Fetch a small page so a
// run does not pay one process launch per character, without materialising a
// large fraction of Unicode merely to classify one scalar. Exhaustive callers
// already pass their full batch and therefore bypass page expansion.
const PAGE_SIZE = 256;
const MAX_MEMO_ROWS = 65_536;
let helperPath: string | undefined;
let checked = false;
let helperValidated: boolean | null = null;

function inTreeHelper(): string | undefined {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const name = process.platform === "win32" ? "domotion-icu.exe" : "domotion-icu";
  const candidate = path.join(root, "tools", "icu-helper", name);
  return existsSync(candidate) ? candidate : undefined;
}

function resolveHelper(): string | undefined {
  if (!checked) {
    checked = true;
    helperPath = process.env.DOMOTION_ICU_HELPER_PATH ?? inTreeHelper() ?? acquireIcuCompanionSync();
  }
  return helperPath;
}

/** Whether the pinned ICU companion and its data image answer the protocol. */
export function isIcuHelperAvailable(): boolean {
  if (helperValidated != null) return helperValidated;
  const executable = resolveHelper();
  if (executable == null) return (helperValidated = false);
  const proc = spawnSync(executable, [], {
    input: JSON.stringify({ cps: [] }),
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: process.env.DOMOTION_ICU_DATA
      ? process.env
      : { ...process.env, DOMOTION_ICU_DATA: path.join(path.dirname(executable), "icudtl.dat") },
  });
  if (proc.status !== 0) return (helperValidated = false);
  return (helperValidated = parseIcuResponse(proc.stdout) != null);
}

export function queryIcuCodepoints(codepoints: readonly number[]): Map<number, IcuCodepointProperties> {
  const requested = [...new Set(codepoints)].filter((cp) => Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff);
  const missingRequested = requested.filter((cp) => !memo.has(cp));
  // Classification is normally called one codepoint at a time from synchronous
  // routing. Fetch its 256-codepoint page so a Unicode grid or ordinary text
  // pays one process call per local region rather than one per character.
  const pages = new Set(missingRequested.map((cp) => Math.floor(cp / PAGE_SIZE)));
  const missing =
    pages.size <= 16
      ? [...pages].flatMap((page) => {
          const start = page * PAGE_SIZE;
          const end = Math.min(start + PAGE_SIZE, 0x110000);
          const out: number[] = [];
          for (let cp = start; cp < end; ++cp) if (!memo.has(cp)) out.push(cp);
          return out;
        })
      : missingRequested;
  const executable = missing.length > 0 && isIcuHelperAvailable() ? resolveHelper() : undefined;
  if (missing.length > 0 && executable != null) {
    const proc = spawnSync(executable, [], {
      input: JSON.stringify({ cps: missing }),
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024 * 1024,
      env: process.env.DOMOTION_ICU_DATA
        ? process.env
        : { ...process.env, DOMOTION_ICU_DATA: path.join(path.dirname(executable), "icudtl.dat") },
    });
    const response = proc.status === 0 ? parseIcuResponse(proc.stdout) : null;
    if (response != null) {
      for (const row of response.properties) memo.set(row.cp, row);
      while (memo.size > MAX_MEMO_ROWS) memo.delete(memo.keys().next().value!);
    }
  }
  const result = new Map<number, IcuCodepointProperties>();
  for (const cp of requested) {
    const row = memo.get(cp);
    if (row != null) result.set(cp, row);
  }
  return result;
}

export function icuCodepointProperties(cp: number): IcuCodepointProperties | undefined {
  return queryIcuCodepoints([cp]).get(cp);
}

export const ICU_BINARY = {
  V2: 0x80000000,
  IDEOGRAPHIC: 1 << 0,
  DEFAULT_IGNORABLE: 1 << 1,
  GRAPHEME_EXTEND: 1 << 2,
  EMOJI: 1 << 3,
  EMOJI_PRESENTATION: 1 << 4,
  EMOJI_MODIFIER_BASE: 1 << 5,
  EMOJI_COMPONENT: 1 << 6,
  EXTENDED_PICTOGRAPHIC: 1 << 7,
  EMOJI_MODIFIER: 1 << 8,
  REGIONAL_INDICATOR: 1 << 9,
} as const;

/** Forget the discovered helper and every answer it produced (environment invalidation). */
export function clearIcuHelper(): void {
  memo.clear();
  checked = false;
  helperPath = undefined;
  helperValidated = null;
}

export const __resetIcuHelperForTest = clearIcuHelper;

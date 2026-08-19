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

interface IcuResponse {
  protocolVersion: "1";
  icuVersion: "78.2";
  unicodeVersion: string;
  properties: IcuCodepointProperties[];
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
  try {
    const response = JSON.parse(proc.stdout) as IcuResponse;
    return (helperValidated = response.protocolVersion === "1" && response.icuVersion === "78.2");
  } catch {
    return (helperValidated = false);
  }
}

export function queryIcuCodepoints(codepoints: readonly number[]): Map<number, IcuCodepointProperties> {
  const requested = [...new Set(codepoints)].filter(cp => Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff);
  const missingRequested = requested.filter(cp => !memo.has(cp));
  // Classification is normally called one codepoint at a time from synchronous
  // routing. Fetch its 256-codepoint page so a Unicode grid or ordinary text
  // pays one process call per local region rather than one per character.
  const pages = new Set(missingRequested.map(cp => Math.floor(cp / PAGE_SIZE)));
  const missing = pages.size <= 16
    ? [...pages].flatMap(page => {
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
    if (proc.status === 0) {
      try {
        const response = JSON.parse(proc.stdout) as IcuResponse;
        if (response.protocolVersion === "1" && response.icuVersion === "78.2") {
          for (const row of response.properties) memo.set(row.cp, row);
          while (memo.size > MAX_MEMO_ROWS) memo.delete(memo.keys().next().value!);
        }
      } catch { /* helper-absent mode is deliberately non-fatal */ }
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
  IDEOGRAPHIC: 1 << 0,
  DEFAULT_IGNORABLE: 1 << 1,
  GRAPHEME_EXTEND: 1 << 2,
  EMOJI: 1 << 3,
  EMOJI_PRESENTATION: 1 << 4,
  EMOJI_MODIFIER_BASE: 1 << 5,
  EMOJI_COMPONENT: 1 << 6,
  EXTENDED_PICTOGRAPHIC: 1 << 7,
} as const;

export function __resetIcuHelperForTest(): void {
  memo.clear();
  checked = false;
  helperPath = undefined;
  helperValidated = null;
}

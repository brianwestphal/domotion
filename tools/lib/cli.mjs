import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const EXIT_AGREE = 0;
export const EXIT_MISMATCH = 1;
export const EXIT_ERROR = 2;

/** Parse declared flags only. A missing value and an unknown flag are errors. */
export function parseFlags(argv, options) {
  return parseArgs({ args: argv, options, strict: true, allowPositionals: false }).values;
}

export function flag(values, name, fallback = null) {
  const value = values[name.replace(/^--/, "")];
  return value === undefined ? fallback : value;
}

export function requiredFlag(values, name) {
  const value = flag(values, name);
  if (typeof value !== "string" || value === "") throw new Error(`${name} requires a value`);
  return value;
}

export function intFlag(values, name, minimum = 1) {
  const raw = requiredFlag(values, name);
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw new Error(`${name} needs an integer >= ${minimum}, got ${raw}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error(`${name} needs an integer >= ${minimum}, got ${raw}`);
  return value;
}

export function shardFlag(values, name) {
  const raw = flag(values, name);
  if (raw == null || raw === "") return null;
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(raw);
  if (match == null) throw new Error(`${name} needs a shard i/N, got ${raw}`);
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index < 1 || total < 1 || index > total)
    throw new Error(`${name} needs 1 <= i <= N, got ${raw}`);
  return { index, total };
}

export function isMain(metaUrl, argv = process.argv) {
  return argv[1] != null && pathToFileURL(resolve(argv[1])).href === metaUrl;
}

export async function runMain(main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = EXIT_ERROR;
  }
}

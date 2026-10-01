#!/usr/bin/env node
/** Deterministic routine conformance buckets recorded against a git revision. */

/**
 * Low-byte buckets are disjoint and exhaustive. The stack bucket rotates a
 * complementary focus without changing the 351-stack single-axis matrix: it
 * tells reports which secondary oracle family to emphasize at this revision.
 */
import { isMain, parseCommand, runMain } from "./lib/cli.mjs";
export function rotationForRevision(revision, ordinal) {
  const normalized = String(revision ?? "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{8,64}$/.test(normalized)) {
    throw new Error("revision must be an 8-64 character hexadecimal git object id");
  }
  const run = Number(ordinal);
  if (!Number.isSafeInteger(run) || run < 0) {
    throw new Error("rotation ordinal must be a non-negative integer");
  }
  const byte = run % 256;
  const stackIndex = run % 8;
  const stackBuckets = [
    "generic-initial",
    "weight-style",
    "stretch-variable",
    "named-missing-first",
    "webfont-unicode-range",
    "emoji-presentation",
    "cjk-locales",
    "rtl-combining",
  ];
  return {
    sampleByte: byte.toString(16).toUpperCase().padStart(2, "0"),
    stackBucket: stackBuckets[stackIndex],
    stackBucketIndex: stackIndex,
    stackBucketTotal: stackBuckets.length,
    revision: normalized,
    ordinal: run,
  };
}

if (isMain(import.meta.url))
  await runMain(() => {
    try {
      const { positionals } = parseCommand(process.argv.slice(2), {});
      if (positionals.length !== 2) throw new Error("expected revision and rotation ordinal");
      process.stdout.write(`${JSON.stringify(rotationForRevision(positionals[0], positionals[1]))}\n`);
      return 0;
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
  });

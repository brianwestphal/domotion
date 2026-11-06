/**
 * The environment record a LOCAL visual run writes beside its results, and the
 * warning it prints when that record moved since the previous run in the same
 * output directory.
 *
 * Why it exists (DM-779QKV): on 2026-11-06 two feature fixtures changed bytes on
 * a dev Mac between two runs of the same tree. Chrome's own `expected.png` had
 * moved, because an unrelated app (Photoshop) asked macOS for its downloadable
 * font catalog and a PingFang MobileAsset was installed mid-session. Nothing in
 * the results said the two runs were measured in different environments, so the
 * before/after comparison looked like a rendering change.
 *
 * CI already records the full fingerprint (`scripts/run-env.mjs`, doc 66). This
 * is the local counterpart, deliberately narrow: the browser build, the kernel
 * version, the installed font inventory and — on macOS — the MobileAsset font
 * set, which the inventory cannot see. It warns rather than fails: a local run
 * is not a gate, and the point is that a reader of two result sets knows they
 * are not like-for-like.
 */

import { existsSync, readFileSync } from "node:fs";
import { release } from "node:os";
import { fontAssetsDocument, inventoryDocument } from "../tools/font-inventory.mjs";

export interface DigestCount {
  digest: string | null;
  count: number | null;
}

export interface LocalRunEnv {
  chromium: string | null;
  osRelease: string | null;
  fontInventory: DigestCount | null;
  fontAssets: DigestCount | null;
}

/** Best-effort: an unreadable font store degrades to `null`, never a failed run. */
function digestCount(read: () => { digest: string; count: number }): DigestCount | null {
  try {
    const doc = read();
    return { digest: doc.digest, count: doc.count };
  } catch {
    return null;
  }
}

/** Capture this host's record. `chromium` is the browser build the run launched. */
export function captureLocalRunEnv(chromium: string | null): LocalRunEnv {
  return {
    chromium,
    osRelease: release(),
    fontInventory: digestCount(() => inventoryDocument()),
    fontAssets: digestCount(() => fontAssetsDocument()),
  };
}

const FIELDS: [string, (e: LocalRunEnv) => string | null | undefined][] = [
  ["Chromium", (e) => e.chromium],
  ["OS release", (e) => e.osRelease],
  ["font inventory digest", (e) => e.fontInventory?.digest],
  ["font asset digest", (e) => e.fontAssets?.digest],
];

/**
 * Reasons two records differ. A field absent or null on EITHER side is skipped
 * (an older manifest predates the record), matching `scripts/run-env.mjs`.
 */
export function diffLocalRunEnv(previous: LocalRunEnv | null, current: LocalRunEnv): string[] {
  if (previous == null) return [];
  const out: string[] = [];
  for (const [label, get] of FIELDS) {
    const a = get(previous);
    const b = get(current);
    if (a == null || b == null || a === b) continue;
    out.push(`${label}: ${a} -> ${b}`);
  }
  return out;
}

/** The `runEnv` field of a previous manifest, or null when absent/unreadable. */
export function readPreviousRunEnv(manifestPath: string): LocalRunEnv | null {
  if (!existsSync(manifestPath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (parsed == null || typeof parsed !== "object" || !("runEnv" in parsed)) return null;
    const env = (parsed as { runEnv: unknown }).runEnv;
    return env != null && typeof env === "object" ? (env as LocalRunEnv) : null;
  } catch {
    return null;
  }
}

/** The warning text for a changed environment, or null when nothing moved. */
export function runEnvChangeWarning(previous: LocalRunEnv | null, current: LocalRunEnv): string | null {
  const reasons = diffLocalRunEnv(previous, current);
  if (reasons.length === 0) return null;
  return [
    "WARNING: environment changed since the last run in this output directory —",
    "comparisons across these runs are not like-for-like:",
    ...reasons.map((r) => `  - ${r}`),
  ].join("\n");
}

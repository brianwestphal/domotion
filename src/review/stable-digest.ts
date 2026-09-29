import { createHash } from "node:crypto";

/**
 * Recursively sort object keys so two structurally equal values serialize identically. Arrays keep
 * their order (order is meaningful there); only object key order is normalized.
 */
export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value != null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

/** SHA-256 of a value's canonical (key-sorted) JSON: the digest evidence comparators diff. */
export function stableDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

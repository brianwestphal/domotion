import { randomUUID } from "node:crypto";

/**
 * A collision-resistant private property/attribute key for state a prepass stashes
 * on the inspected page (`globalThis`, element expandos, restore tokens).
 *
 * Every Node-side prepass needs one, and they were minted two ways — a UUID in
 * some files and `Date.now()` plus a truncated `Math.random()` in others, the
 * latter able to collide for two probes started in the same millisecond. One
 * source: `__domotion<Name>_<32 hex chars>`, a valid identifier and CSS-safe.
 */
export function privateCaptureKey(name: string): string {
  return `__domotion${name}_${randomUUID().replaceAll("-", "")}`;
}

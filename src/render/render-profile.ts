// DM-1029: opt-in profiler for the synchronous `render-svg` step
// (`elementTreeToSvgInner`). It breaks that step into sub-stages so the
// demo-test timing diagram can show where the render time actually goes —
// most importantly, how much is the CoreText helper `spawnSync` subprocess
// (the prime optimization target) vs. in-process text shaping/markup vs. box
// geometry.
//
// Gated on `DEMO_TIMING=1` so it's a no-op in normal runs (the `accum` calls
// early-return). Safe to read as a process-global accumulator because
// `elementTreeToSvgInner` runs fully synchronously — even the helper
// `spawnSync` blocks the event loop — so no other test worker can interleave
// between a `reset()` immediately before the render and a `snapshot()`
// immediately after. Reset/snapshot must bracket the render call with no
// `await` in between (see tests/html-test-suite.tsx).

const enabled = process.env.DEMO_TIMING === "1";

export interface ProfAcc { ms: number; count: number }
const acc: Record<string, ProfAcc> = Object.create(null);

export const renderProfileEnabled = enabled;

/** Perf clock — returns 0 when disabled so callers pay nothing. Pair with
 *  `profAccum(label, profNow() - t0)`. */
export function profNow(): number {
  return enabled ? performance.now() : 0;
}

export function profAccum(label: string, ms: number): void {
  if (!enabled) return;
  const a = acc[label] ?? (acc[label] = { ms: 0, count: 0 });
  a.ms += ms;
  a.count++;
}

export function profSnapshot(): Record<string, ProfAcc> {
  const out: Record<string, ProfAcc> = {};
  for (const k of Object.keys(acc)) out[k] = { ms: acc[k].ms, count: acc[k].count };
  return out;
}

export function profReset(): void {
  for (const k of Object.keys(acc)) delete acc[k];
}

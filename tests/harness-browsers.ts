/**
 * DM-1790 (docs/105): asymmetric capture-vs-raster browsers for the visual
 * harnesses.
 *
 * `tests/runner.tsx` and `tests/html-test-suite.tsx` each drive ONE Chromium:
 * the same page screenshots the expected paint AND rasterizes the candidate
 * Domotion SVG for the diff. That coupling is fine — until you want to launch
 * Chromium with a flag meant to change only ONE side. Any `chromium.launch({
 * args })` flag then moves both sides together, and a whole class of
 * capture-side experiments becomes unmeasurable.
 *
 * The motivating case (DM-1789 / docs/66): `--font-render-hinting=none` on the
 * capture browser is a valid experiment in **paths** mode — the SVG is vector
 * geometry, so only the expected paint moves — but INVALID in **embedded**
 * mode, where the SVG's hinted subset font also rasterizes unhinted in the same
 * flagged browser. Both sides go soft and agree, the sweep reports diff%
 * DROPPING, and the number is a mirage: a real consumer opens that SVG in an
 * unflagged, hinted browser.
 *
 * This module makes the two sides independently configurable, via two env vars
 * holding whitespace-separated Chromium args:
 *
 *   DOMOTION_CAPTURE_FLAGS   args for the browser that renders the FIXTURE
 *                            (the expected paint)
 *   DOMOTION_RASTER_FLAGS    args for the browser that rasterizes the candidate
 *                            SVG (the consumer's condition)
 *
 * The three configurations that matter:
 *
 *   neither set              ONE browser for both — today's fast path,
 *                            byte-identical, zero extra process
 *   CAPTURE only             ASYMMETRIC: flagged capture, unflagged raster.
 *                            This is the consumer's condition, and the only
 *                            way to measure a capture-only flag honestly
 *   both set to the same     symmetric-but-flagged, i.e. the coupled behavior
 *                            the harness has always had, now reachable
 *                            deliberately rather than by accident
 *
 * A second browser costs one extra Chromium process for the whole run (not per
 * worker), so the mode is cheap — but it stays opt-in because the default
 * single-browser path is what every committed baseline was measured under.
 */

import { chromium, type Browser } from "@playwright/test";

/** Parse a whitespace-separated flag list; `undefined`/blank ⇒ no flags. */
function parseFlags(raw: string | undefined): string[] {
  return (raw ?? "").trim().split(/\s+/).filter((s) => s !== "");
}

/**
 * Cache-key contribution for the CAPTURE browser's flags — **empty string when
 * there are none**, so a default run's key is byte-identical to before this
 * mode existed and every already-cached expected.png stays valid.
 *
 * This is load-bearing, not hygiene. `tests/html-test-suite.tsx` caches the
 * expected screenshot keyed on (source HTML, viewport, Playwright version,
 * capture-script hash). A capture-side Chromium flag changes that screenshot
 * and NOTHING else in the key, so without this a flagged run silently reuses
 * the unflagged cached PNG and reports numbers for a condition it never ran —
 * precisely the mirage-measurement failure this whole mode exists to prevent.
 * (Observed: three conditions produced identical coverage to three decimals.)
 *
 * Only the capture flags belong here. The raster flags affect `actual.png`,
 * which is never cached.
 */
export function captureFlagsCacheToken(env: NodeJS.ProcessEnv = process.env): string {
  const flags = parseFlags(env.DOMOTION_CAPTURE_FLAGS);
  return flags.length > 0 ? `|captureFlags=${flags.join(" ")}` : "";
}

/**
 * The flag decision, resolved from the environment — pure, so the three
 * configurations can be unit-tested without launching Chromium.
 *
 * Equality is order-sensitive on purpose: two arg lists that differ only in
 * order are still two distinct launch configurations as far as this helper is
 * concerned, and splitting the browser is the conservative answer.
 */
export function resolveHarnessFlags(env: NodeJS.ProcessEnv = process.env): {
  captureFlags: string[]; rasterFlags: string[]; asymmetric: boolean;
} {
  const captureFlags = parseFlags(env.DOMOTION_CAPTURE_FLAGS);
  const rasterFlags = parseFlags(env.DOMOTION_RASTER_FLAGS);
  const same = captureFlags.length === rasterFlags.length
    && captureFlags.every((f, i) => f === rasterFlags[i]);
  return { captureFlags, rasterFlags, asymmetric: !same };
}

export interface HarnessBrowsers {
  /** Renders the fixture HTML — the expected paint. */
  capture: Browser;
  /**
   * Rasterizes the candidate SVG. The SAME object as `capture` unless the two
   * sides were configured differently, so the default path allocates nothing
   * extra and callers need no branch beyond `asymmetric`.
   */
  raster: Browser;
  /** True when `raster !== capture` — i.e. a second browser really was launched. */
  asymmetric: boolean;
  /** The resolved flag lists, for the run's log line. */
  captureFlags: string[];
  rasterFlags: string[];
  /** Close whichever browsers were actually launched (once each). */
  close: () => Promise<void>;
}

/**
 * Launch the harness's browser(s) honoring `DOMOTION_CAPTURE_FLAGS` /
 * `DOMOTION_RASTER_FLAGS`. Returns one browser under both names unless the two
 * flag lists differ, in which case a second is launched for the raster side.
 */
export async function launchHarnessBrowsers(): Promise<HarnessBrowsers> {
  const { captureFlags, rasterFlags, asymmetric } = resolveHarnessFlags();

  const capture = await chromium.launch(captureFlags.length > 0 ? { args: captureFlags } : {});
  if (!asymmetric) {
    return {
      capture, raster: capture, asymmetric: false, captureFlags, rasterFlags,
      close: async () => { await capture.close(); },
    };
  }
  const raster = await chromium.launch(rasterFlags.length > 0 ? { args: rasterFlags } : {});
  return {
    capture, raster, asymmetric: true, captureFlags, rasterFlags,
    close: async () => { await raster.close(); await capture.close(); },
  };
}

/**
 * One line describing the browser configuration, or `null` when it is the
 * default (nothing worth printing). Printed by each harness at start-up so a
 * results file is never ambiguous about which condition produced it — the
 * failure mode this whole mode exists to prevent is a number measured under a
 * flag nobody remembers setting.
 */
export function harnessBrowserNote(b: Pick<HarnessBrowsers, "asymmetric" | "captureFlags" | "rasterFlags">): string | null {
  if (!b.asymmetric && b.captureFlags.length === 0) return null;
  const fmt = (f: string[]): string => (f.length > 0 ? f.join(" ") : "(none)");
  return b.asymmetric
    ? `browsers: ASYMMETRIC — capture ${fmt(b.captureFlags)} · raster ${fmt(b.rasterFlags)}`
    : `browsers: one, flagged ${fmt(b.captureFlags)} (capture AND raster — both sides move together)`;
}

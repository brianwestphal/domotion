/**
 * The platform the renderer resolves fonts FOR — as an input, not an ambient
 * fact (DM-1980).
 *
 * ## Why this exists
 *
 * Font selection is three genuinely different procedures — CoreText on macOS,
 * fontconfig on Linux, a hardcoded table plus DirectWrite on Windows — and the
 * code branches on `process.platform` in 53 places across the subsystem. That
 * made every Linux and Windows decision untestable on a developer Mac: the
 * relevant suites `describe.skip` themselves off-platform, so the only
 * instruments that could speak to those branches were CI jobs costing minutes,
 * two of which need a push first.
 *
 * Reading the platform through one accessor makes it substitutable. Combined
 * with a recorded helper cassette (`tools/font-env-cassette.mjs`), a Linux
 * routing decision can be exercised in the 30-second unit suite on any machine.
 *
 * ## What this does NOT do
 *
 * Overriding the platform does not conjure that platform's FONTS. A Linux
 * decision replayed on a Mac still needs its environment answers supplied — the
 * helper's, via a cassette, and any file-existence checks. This accessor is one
 * of the inputs, not all of them; asserting a cross-platform result without
 * also supplying those would be measuring the wrong machine while looking
 * rigorous, which is the failure mode this area keeps hitting.
 *
 * Nor does it change what SHIPS: the default is `process.platform`, read
 * lazily, so production behavior is byte-identical.
 */

/** The platforms the font subsystem has real routing for. Anything else falls
 *  through the same "no table for this platform" paths it always has. */
export type HostPlatform = NodeJS.Platform;

let override: HostPlatform | null = null;

/**
 * The platform font resolution should answer for.
 *
 * Read this instead of `process.platform` anywhere the answer feeds a font
 * decision. Deliberately a function rather than a constant: a module-level
 * `const` snapshot would capture the real platform at import time and make the
 * override silently inert for anything already loaded — the exact shape of
 * "the flag was on but the mechanism was not in the loop".
 */
export function hostPlatform(): HostPlatform {
  return override ?? process.platform;
}

/** True when the platform is being overridden — for diagnostics that need to
 *  say "this number describes a simulated host". */
export function hostPlatformIsOverridden(): boolean {
  return override != null;
}

/**
 * Run `fn` with the host platform forced to `platform`, restoring the previous
 * value afterwards even if `fn` throws.
 *
 * Scoped rather than a bare setter because the subsystem is full of process-
 * global caches: a leaked override would poison every later resolution in the
 * same process with answers for the wrong OS. Callers that need the caches
 * cleared across the boundary should do that themselves — this only owns the
 * platform.
 */
export function withHostPlatform<T>(platform: HostPlatform, fn: () => T): T {
  const prev = override;
  override = platform;
  try {
    return fn();
  } finally {
    override = prev;
  }
}

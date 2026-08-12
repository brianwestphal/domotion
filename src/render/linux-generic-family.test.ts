/**
 * The CSS generic keywords, resolved on the platform itself (DM-1993).
 *
 * Blink resolves `cursive` and `fantasy` from a browser-side settings value —
 * `settings.Cursive(script)` / `settings.Fantasy(script)`
 * (`platform/fonts/font_selector.cc:80-83`, rev 7d859f27) — and **never asks
 * fontconfig for its own `cursive` / `fantasy` aliases**. When the configured
 * family is not installed, that settings value falls through to the same face
 * `serif` resolves to.
 *
 * Asking fontconfig's aliases is the intuitive move and it is the wrong
 * question. It answered WenQuanYi Zen Hei where Chrome answers Liberation
 * Serif, and because a generic keyword is the run's PRIMARY, one wrong answer
 * applies to every codepoint the stack touches: 448,990 mismatches on the first
 * full-corpus Linux sweep — 63.5% of the platform's entire mismatch mass.
 *
 * ── Why this file is Linux-gated rather than cassette-replayed ────────────────
 *
 * The sibling `*-crossplatform` tests replay DECISIONS. This one asserts a
 * resolved FILE, and `resolveFontSpec` on Linux checks the path exists (falling
 * back to `fc-match`), so it can only answer on a host that has the fonts. That
 * is the boundary DM-1980 measured: decisions replay, face materialization does
 * not. Reproduce with `npm run test:linux-docker`.
 */
import { describe, expect, it } from "vitest";
import { __resolveFontSpecForTest, resolveFontKey } from "./font-resolution.js";
import { hostPlatform } from "./host-platform.js";

const describeLinux = hostPlatform() === "linux" ? describe : describe.skip;

describeLinux("CSS generic keywords resolve where Chrome resolves them (Linux)", () => {
  /** The face `serif` lands on — Liberation Serif in the pinned noble image. */
  const serifPath = (): string | undefined => __resolveFontSpecForTest(resolveFontKey("serif")!)?.path;

  it("puts `serif` on Liberation Serif", () => {
    // Precondition for the two claims below: they are stated RELATIVE to this
    // face, so if the image ever stops resolving serif here, the failure should
    // name that rather than showing up as two mysterious mismatches.
    expect(serifPath()).toContain("LiberationSerif");
  });

  it.each(["cursive", "fantasy"])("puts `%s` on the same face as `serif`", (generic) => {
    const key = resolveFontKey(generic);
    expect(key).not.toBeNull();
    expect(__resolveFontSpecForTest(key!)?.path).toBe(serifPath());
  });

  it("sends an author-NAMED absent family through the nomination walk instead", () => {
    // Not a control for the generics — a correction to what I first assumed.
    // On Linux `Snell Roundhand` does NOT reach the `snell` key's fontconfig
    // substitute at all: the transcribed nomination walk (doc 110) asks the
    // matcher, gets a rejection because the family is not installed, walks past
    // it and lands on the host's last-resort serif face. So the
    // `snell` entry's `fcMatch: "cursive"` is dormant on this platform.
    //
    // Recorded because it is the reason the generics could not be "fixed" by
    // pointing `snell` somewhere too: that key is not in the path.
    const key = resolveFontKey("Snell Roundhand");
    expect(key).not.toBeNull();
    expect(__resolveFontSpecForTest(key!)?.path).toBe(serifPath());
  });

  it("keeps the other generics where they already agreed with Chrome", () => {
    // Measured together with the two that moved, because a change to generic
    // routing that fixed two and broke three would otherwise look like progress.
    // Chrome in the pinned image: sans-serif → Liberation Sans,
    // monospace → WenQuanYi Zen Hei Mono, math → Liberation Serif.
    expect(__resolveFontSpecForTest(resolveFontKey("sans-serif")!)?.path).toContain("LiberationSans");
    expect(__resolveFontSpecForTest(resolveFontKey("monospace")!)?.path?.toLowerCase()).toContain("wqy");
    expect(__resolveFontSpecForTest(resolveFontKey("math")!)?.path).toContain("LiberationSerif");
  });
});

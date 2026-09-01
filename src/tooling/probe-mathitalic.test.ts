import { describe, expect, it, vi } from "vitest";
// The executable probe remains an .mjs tool; importing is safe because its
// process entry point is guarded.
// @ts-expect-error no declaration file for the standalone diagnostic module
import { findStixFonts } from "../../tools/probe-mathitalic.mjs";

describe("math italic font probe", () => {
  it("skips a missing font root without spawning find", () => {
    const run = vi.fn();
    expect(findStixFonts("/missing-font-root", run, () => false)).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("uses an argv-based find call and suppresses diagnostic stderr", () => {
    const run = vi.fn(() => "/fonts/STIXTwoMath-Regular.otf\n");
    expect(findStixFonts("/fonts", run, () => true)).toBe("/fonts/STIXTwoMath-Regular.otf\n");
    expect(run).toHaveBeenCalledWith(
      "find",
      ["/fonts", "-iname", "*STIX*"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  });

  it("treats an unreadable search root like the old redirected shell probe", () => {
    const run = vi.fn(() => { throw new Error("permission denied"); });
    expect(findStixFonts("/fonts", run, () => true)).toBeNull();
  });
});

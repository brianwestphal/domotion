import { describe, expect, it } from "vitest";
// page-context module is untyped (@ts-nocheck) but resolves cleanly here
import { createCounterStyleResolver } from "./counter-style-resolver.js";

// DM-1274: `counter()` / `counters()` with a BUILT-IN style argument (e.g.
// `counters(outline, " · ", upper-roman)`) must format through the resolver,
// not fall back to decimal. The bug was a gate in pseudo-content.ts that only
// applied the style when it was a CUSTOM @counter-style; built-ins like
// upper-roman / lower-alpha were dropped to decimal. The resolver itself always
// handled built-ins — these tests lock that, so the widened gate has a contract.
describe("counter-style resolver: built-in styles in counter() context (DM-1274)", () => {
  const { resolveCounterValue } = createCounterStyleResolver({ counterStyles: {} });

  it("formats upper-roman / lower-roman", () => {
    expect(resolveCounterValue("upper-roman", 1)).toBe("I");
    expect(resolveCounterValue("upper-roman", 4)).toBe("IV");
    expect(resolveCounterValue("upper-roman", 9)).toBe("IX");
    expect(resolveCounterValue("lower-roman", 4)).toBe("iv");
  });

  it("formats alpha and decimal variants", () => {
    expect(resolveCounterValue("lower-alpha", 1)).toBe("a");
    expect(resolveCounterValue("upper-alpha", 26)).toBe("Z");
    expect(resolveCounterValue("decimal", 7)).toBe("7");
    expect(resolveCounterValue("decimal-leading-zero", 3)).toBe("03");
  });

  it("counter-function context returns the bare value (no prefix/suffix wrapping)", () => {
    // resolveCounterValue is the `wrap=false` path — unlike the ::marker
    // resolveCounterStyle path which adds prefix/suffix.
    const { resolveCounterValue: rv, resolveCounterStyle: rs } = createCounterStyleResolver({
      counterStyles: { stepd: { system: "extends", extendsName: "decimal", prefix: "Step ", suffix: ":", padLen: 2, padSym: "0", rangeLo: -Infinity, rangeHi: Infinity } },
    });
    expect(rv("stepd", 1)).toBe("01");            // value only
    expect(rs("stepd", 1)).toBe("Step 01:");      // wrapped (marker context)
  });
});

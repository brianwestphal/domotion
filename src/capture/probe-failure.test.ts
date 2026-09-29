import { describe, expect, it } from "vitest";
import { errorMessage, probeFailureWarning } from "./probe-failure.js";

describe("probeFailureWarning", () => {
  it("names the probe, the cause and the effect, and defaults to a partial state", () => {
    expect(
      probeFailureWarning({
        selector: "body",
        feature: "transform",
        probe: "Range FragmentItem probe",
        cause: new Error("Execution context was destroyed"),
        effect: "its text elements take the legacy text path",
      }),
    ).toEqual({
      selector: "body",
      feature: "transform",
      detail:
        "Range FragmentItem probe failed (Execution context was destroyed); its text elements take the legacy text path",
      status: "partial",
    });
  });

  it("accepts a non-Error cause and an explicit unavailable state", () => {
    const warning = probeFailureWarning({
      selector: "#a::before",
      feature: "generated-pseudo-fragment-geometry",
      probe: "isolated surface capture",
      cause: "timeout",
      effect: "the paint is missing",
      status: "unavailable",
    });
    expect(warning.detail).toBe("isolated surface capture failed (timeout); the paint is missing");
    expect(warning.status).toBe("unavailable");
    expect(errorMessage(42)).toBe("42");
  });
});

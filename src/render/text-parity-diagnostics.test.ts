import { describe, expect, it } from "vitest";
import { unsupportedTextParityDiagnostic } from "./text-parity-diagnostics.js";

describe("unsupported text parity diagnostics", () => {
  it("classifies only enumerated detected features with actionable raster fallback", () => {
    const d = unsupportedTextParityDiagnostic({ textOrientation: "sideways" });
    expect(d).toMatchObject({ verdict: "explicit-unsupported", feature: "text-orientation: sideways", fallback: "rasterize-text" });
    expect(d!.remediation).toContain("raster text fallback");
  });

  it("does not relabel supported or unknown inputs as unsupported", () => {
    expect(unsupportedTextParityDiagnostic({ textOrientation: "mixed", textWrapMode: "nowrap" })).toBeNull();
    expect(unsupportedTextParityDiagnostic({})).toBeNull();
  });
});

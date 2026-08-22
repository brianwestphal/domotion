import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  auditFormControlRoutes,
  auditNativeControlFallbackSources,
  runNativeControlFallbackGate,
} from "../tools/native-control-fallback-gate.js";

const formSource = (): string => readFileSync(resolve("src/render/form-controls.ts"), "utf8");
const emitterSource = (): string => readFileSync(resolve("src/render/element-tree-to-svg.ts"), "utf8");

describe("native-control sampled fallback retirement gate (DM-2458)", () => {
  it("accepts every current route and source invariant", () => {
    expect(runNativeControlFallbackGate()).toEqual({ ok: true, errors: [], routeRows: 24 });
    expect(auditFormControlRoutes()).toEqual([]);
  });

  it("kills reintroduced stock constants and sampled helpers", () => {
    const errors = auditNativeControlFallbackSources(
      `${formSource()}\nconst STOCK_LIGHT = {};\nfunction renderDatePicker() {}`,
      emitterSource(),
    );
    expect(errors).toContain("sampled native fallback token remains: STOCK_LIGHT");
    expect(errors).toContain("sampled native fallback token remains: renderDatePicker");

    const literalErrors = auditNativeControlFallbackSources(
      `${formSource()}\nconst oldBlue = "rgb(0,117,255)"; const oldLabel = "Choose File";`,
      emitterSource(),
    );
    expect(literalErrors.some((error) => error.includes("sampled native fallback literal"))).toBe(true);
  });

  it("kills platform, fixture, and test-only route discriminators", () => {
    const errors = auditNativeControlFallbackSources(
      `${formSource()}\nvoid navigator.platform; void dataDomotionAnim; void fixtureName;`,
      emitterSource(),
    );
    expect(errors.some((error) => error.includes("navigator"))).toBe(true);
    expect(errors.some((error) => error.includes("data-domotion-anim"))).toBe(false);
    expect(errors.some((error) => error.includes("fixture"))).toBe(true);

    const dataAttributeErrors = auditNativeControlFallbackSources(
      `${formSource()}\nvoid "data-domotion-anim";`,
      emitterSource(),
    );
    expect(dataAttributeErrors.some((error) => error.includes("data-domotion-anim"))).toBe(true);
  });

  it("kills a reordered or removed native-raster terminal guard", () => {
    const mutatedEmitter = emitterSource().replace(
      "if (nativeControlRaster != null)",
      "if (false)",
    );
    expect(auditNativeControlFallbackSources(formSource(), mutatedEmitter))
      .toContain("native-control raster must terminate emission before renderFormControl");
  });
});

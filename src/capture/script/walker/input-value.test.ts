// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { createInputValueHandler } from "./input-value.js";

const KEY = "__domotionInputValueTest";

function setup() {
  const warnings: { sel: string; feature: string; detail: string }[] = [];
  const { captureInputValue } = createInputValueHandler({
    vp: { x: 0, y: 0 },
    normColor: (color) => color,
    measureFontMetrics: () => ({ ascent: 14, descent: 4 }),
    fontFamilyStackFor: () => undefined,
    valueTextGeometryKey: KEY,
    warn: (sel, feature, detail) => warnings.push({ sel, feature, detail }),
    shortSelector: (el) => "input#" + el.id,
  });
  const run = (record: unknown, rect = { left: 10, top: 100, width: 200, height: 40 }) => {
    warnings.length = 0;
    const el = document.createElement("input");
    el.id = "field";
    el.value = "Hello";
    if (record !== undefined) Object.defineProperty(el, KEY, { value: record, configurable: true });
    const cs = {
      paddingLeft: "0px",
      paddingTop: "0px",
      paddingRight: "0px",
      paddingBottom: "0px",
      borderLeftWidth: "0px",
      borderTopWidth: "0px",
      borderRightWidth: "0px",
      borderBottomWidth: "0px",
      lineHeight: "normal",
      fontSize: "16px",
      display: "inline-block",
      textAlign: "start",
      direction: "ltr",
      color: "rgb(0, 0, 0)",
    } as unknown as CSSStyleDeclaration;
    const result = captureInputValue(el, cs, "input", rect as DOMRect) as { applied: boolean; textTop?: number };
    return { textTop: result.textTop, warnings: warnings.map(({ feature, detail }) => ({ feature, detail })) };
  };
  return { run };
}

const accepted = {
  source: "chromium-ua-shadow-text-quad-v1",
  hostWidth: 200,
  hostHeight: 40,
  textTopOffset: 11,
  textHeight: 18,
};
const detail = (reason: string) =>
  `closed-shadow value text quad rejected (${reason}); value text top estimated from line-height and font metrics`;

describe("input value closed-shadow geometry", () => {
  it("uses an accepted record silently", () => {
    const { run } = setup();
    expect(run(accepted)).toEqual({ textTop: 111, warnings: [] });
  });

  it("stays silent when no closed-shadow record was captured", () => {
    const { run } = setup();
    const result = run(undefined);
    expect(result.warnings).toEqual([]);
    expect(result.textTop).not.toBe(111);
  });

  it("keeps the estimate and warns with the capture-side rejection reason", () => {
    const { run } = setup();
    const estimate = run(undefined).textTop;
    for (const reason of ["multiple-text-labels", "non-axis-aligned-quad", "host-quad-unavailable"]) {
      expect(run({ source: "chromium-ua-shadow-text-quad-v1", rejected: reason })).toEqual({
        textTop: estimate,
        warnings: [{ feature: "input-value-geometry", detail: detail(reason) }],
      });
    }
  });

  it("warns when the live host box no longer matches the recorded quad", () => {
    const { run } = setup();
    const estimate = run(undefined, { left: 10, top: 100, width: 300, height: 40 }).textTop;
    expect(run(accepted, { left: 10, top: 100, width: 300, height: 40 })).toEqual({
      textTop: estimate,
      warnings: [{ feature: "input-value-geometry", detail: detail("host-box-changed") }],
    });
  });

  it("treats a malformed record as invalid instead of trusting it", () => {
    const { run } = setup();
    expect(run({ source: "chromium-ua-shadow-text-quad-v1", hostWidth: 200 }).warnings).toEqual([
      { feature: "input-value-geometry", detail: detail("invalid-record") },
    ]);
  });
});

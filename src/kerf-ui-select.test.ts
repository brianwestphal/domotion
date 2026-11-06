// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { Select } from "@kerfjs/ui/select";
import { selectValue, setSelectValue } from "./kerf-ui-select.js";

function render(value: "" | "1" | "2"): Element {
  const host = document.createElement("div");
  host.innerHTML = Select({
    name: "speed",
    ariaLabel: "Playback speed",
    value,
    choices: [
      { value: "1", label: "1x" },
      { value: "2", label: "2x" },
      { value: "", label: "None" },
    ],
  }).toString();
  document.body.append(host);
  return host.querySelector("kui-select")!;
}

describe("kerf-ui Select support", () => {
  it("registers the kui-select element on import", () => {
    expect(customElements.get("kui-select")).toBeDefined();
  });

  it("reads the rendered (state → control) value", () => {
    expect(selectValue(render("2"))).toBe("2");
    expect(selectValue(render(""))).toBe("");
  });

  it("sets a value programmatically and reads it back, including the empty choice", () => {
    const el = render("1");
    setSelectValue(el, "2");
    expect(selectValue(el)).toBe("2");
    setSelectValue(el, "");
    expect(selectValue(el)).toBe("");
    setSelectValue(el, "1");
    expect(selectValue(el)).toBe("1");
  });

  it("takes the first value of a multiple-value element", () => {
    const fake = Object.assign(document.createElement("div"), { value: ["b", "c"] });
    expect(selectValue(fake)).toBe("b");
    const empty = Object.assign(document.createElement("div"), { value: [] as string[] });
    expect(selectValue(empty)).toBe("");
  });
});

describe("scrolled-page popup floor (kerf-ui positionPopup workaround)", () => {
  it("injects one floor stylesheet whose floor never exceeds 2.5rem per option", async () => {
    const { SELECT_POPUP_FLOOR_CSS } = await import("./kerf-ui-select.js");
    expect(document.querySelectorAll("style[data-kerf-ui-select-floor]")).toHaveLength(1);
    const floors = [...SELECT_POPUP_FLOOR_CSS.matchAll(/nth-child\((\d+)\)\) \{ min-height: min\(([\d.]+)rem/g)];
    expect(floors).toHaveLength(5);
    for (const m of floors) expect(Number(m[2])).toBeLessThanOrEqual(Number(m[1]) * 2.5);
  });
});

import { describe, expect, it } from "vitest";

import type { CapturedElement } from "../capture/types.js";
import { elementTreeToSvgInner } from "./element-tree-to-svg.js";

const DATA_URI = "data:image/png;base64,Y3VsbC1yYXN0ZXI=";

function atomic(kind: "filter" | "projective" | "native"): CapturedElement {
  const element: CapturedElement = {
    tag: kind === "native" ? "input" : "div",
    text: "",
    x: 900,
    y: 20,
    width: 60,
    height: 30,
    children: [],
    animId: `move-${kind}`,
    cullClass: "cull-20_000-80_000",
    displayNone: true,
    styles: {
      backgroundColor: "rgba(0, 0, 0, 0)",
      color: "rgb(0, 0, 0)",
      borderColor: "rgba(0, 0, 0, 0)",
      borderWidth: "0px",
      opacity: "1",
      filter: "none",
      mixBlendMode: "normal",
      transform: "matrix(0, 1, -1, 0, 0, 0)",
      transformOrigin: "0px 0px",
    } as CapturedElement["styles"],
  };
  const surface = { x: 780, y: 20, width: 60, height: 30, dataUri: DATA_URI };
  if (kind === "filter") element.urlFilterRaster = surface;
  else if (kind === "projective") element.transformSubtreeRaster = surface;
  else element.nativeControlRaster = surface;
  return element;
}

describe("renderer-owned cull wrappers for atomic Chromium surfaces", () => {
  it.each(["filter", "projective", "native"] as const)(
    "keeps the %s surface under one outer cull owner and one inner animation owner",
    (kind) => {
      const svg = elementTreeToSvgInner([atomic(kind)], 800, 200);
      expect(svg.split(DATA_URI)).toHaveLength(2);
      expect(svg).toMatch(new RegExp(
        `<g class="cull-20_000-80_000" style="display:none"><g class="anim-move-${kind}"><image`,
      ));
      // The screenshot already owns Chromium's frozen static transform. Only
      // the later live animation belongs on its SVG wrapper.
      expect(svg).not.toContain('transform="matrix(0 1 -1 0');
    },
  );
});

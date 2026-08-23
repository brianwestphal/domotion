import { describe, expect, it } from "vitest";

import {
  exactCompositeDelta,
  planBackdropRootComposites,
  planBackdropTerminalComposites,
  targetNeedsAtomicFilterComposite,
  type BackdropCompositeTarget,
} from "./backdrop-composite-raster.js";
import type { CapturedElement } from "./types.js";
import sharp from "sharp";

function element(tag: string, filter = "none", children: CapturedElement[] = []): CapturedElement {
  return {
    tag,
    text: "",
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    children,
    styles: { filter },
  } as unknown as CapturedElement;
}

function attachBackdrop(
  target: CapturedElement,
  reasons: Array<"opacity" | "mask" | "mix-blend-mode" | "filter">,
  neutralize: Array<"opacity" | "mask" | "mix-blend-mode" | "filter">,
): void {
  target.backdropFilterRaster = {
    x: 10,
    y: 10,
    width: 60,
    height: 40,
    token: "bf0",
    selector: "div.target",
    effectSpace: {
      source: "blink-backdrop-effect-tree-v1",
      nearestRoot: { kind: "element", depth: 1, selector: "div.root", reasons },
      ancestors: [{ depth: 1, selector: "div.root", reasons, neutralize }],
    },
  };
}

describe("planBackdropRootComposites", () => {
  it("keeps an opacity root atomic and re-applies opacity outside its raster", () => {
    const target = element("div");
    const root = element("section", "none", [target]);
    attachBackdrop(target, ["opacity"], ["opacity"]);
    const jobs = planBackdropRootComposites([root]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      root,
      rootDepth: 1,
      consumedEffects: [],
      neutralizedEffects: ["opacity"],
    });
    expect(jobs[0].targets[0].element).toBe(target);
  });

  it("captures mask coverage into the root surface and neutralizes blend", () => {
    const target = element("div");
    const root = element("section", "none", [target]);
    attachBackdrop(target, ["mask", "mix-blend-mode"], ["mask"]);
    const [job] = planBackdropRootComposites([root]);
    expect(job.consumedEffects).toEqual(["mask", "mix-blend-mode"]);
    expect(job.neutralizedEffects).toEqual([]);
  });

  it("leaves filter-only roots on the exact target-boundary route", () => {
    const target = element("div");
    const root = element("section", "none", [target]);
    attachBackdrop(target, ["filter"], ["filter"]);
    expect(planBackdropRootComposites([root])).toEqual([]);
  });
});

describe("targetNeedsAtomicFilterComposite", () => {
  it("selects a target regular-filter chain but not the initial value", () => {
    const raster = { x: 0, y: 0, width: 10, height: 10, token: "bf" };
    expect(targetNeedsAtomicFilterComposite({ element: element("div", "opacity(.7)"), raster, selector: "div" })).toBe(true);
    expect(targetNeedsAtomicFilterComposite({ element: element("div"), raster, selector: "div" } as BackdropCompositeTarget)).toBe(false);
  });
});

describe("terminal backdrop effect-space ownership", () => {
  it("selects a transformed document-root owner at its compositor ancestor", () => {
    const target = element("div");
    const root = element("section", "none", [target]);
    attachBackdrop(target, [], []);
    target.backdropFilterRaster!.effectSpace!.nearestRoot = {
      kind: "document",
      depth: 2,
      selector: "html",
      reasons: ["document-root"],
    };
    target.backdropFilterRaster!.effectSpace!.ancestors = [{
      depth: 1,
      selector: "section.root",
      reasons: [],
      neutralize: ["rotate-skew"],
    }];
    expect(planBackdropTerminalComposites([root])).toEqual([expect.objectContaining({
      root,
      rootDepth: 1,
      reason: "relative-transform",
    })]);
  });

  it("serializes only source pixels changed by the terminal owner", async () => {
    const base = await sharp({ create: { width: 2, height: 1, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 1 } } }).png().toBuffer();
    const source = await sharp(Buffer.from([20, 30, 40, 255, 90, 80, 70, 255]), {
      raw: { width: 2, height: 1, channels: 4 },
    }).png().toBuffer();
    const delta = await sharp(await exactCompositeDelta(source, base)).ensureAlpha().raw().toBuffer();
    expect([...delta]).toEqual([0, 0, 0, 0, 90, 80, 70, 255]);
  });
});

import { describe, expect, it } from "vitest";
import type { CapturedElement } from "../capture/types.js";
import {
  collectElementMaskRasters,
  collectFragmentClipPathDefs,
  collectFragmentFilterDefs,
  collectFragmentMaskDefs,
  collectOffGridCollapsedCells,
  collectParentElements,
  fragmentDefinitionKey,
} from "./render-state-collectors.js";

const element = (tag: string, children: CapturedElement[] = [], extra: Record<string, unknown> = {}): CapturedElement => ({
  tag, children, styles: {}, ...extra,
}) as unknown as CapturedElement;

describe("SVG render-state collectors", () => {
  it("collects parent ownership without crossing render sessions", () => {
    const leaf = element("span");
    const child = element("div", [leaf]);
    const root = element("body", [child]);
    const parents = collectParentElements([root]);
    expect(parents.get(child)).toBe(root);
    expect(parents.get(leaf)).toBe(child);
    expect(collectParentElements([element("body")])).not.toBe(parents);
  });

  it("deduplicates fragment resources by tree scope and first ownership", () => {
    const maskA = { id: "m", scope: 1, outerHTML: "<mask id='a'/>", maskUnits: "userSpaceOnUse", maskContentUnits: "userSpaceOnUse", maskType: "alpha" };
    const maskB = { ...maskA, outerHTML: "<mask id='b'/>" };
    const clip = { id: "c", scope: 2, outerHTML: "<clipPath id='c'/>", clipPathUnits: "userSpaceOnUse" };
    const filterA = { id: "f", outerHTML: "<filter id='a'/>" };
    const rasterA = { id: "source", rid: "mr0", width: 1, height: 1, rect: { x: 0, y: 0, width: 1, height: 1 } };
    const root = element("body", [], {
      maskDefs: [maskA, maskB],
      clipPathDefs: [clip],
      filterDefs: [filterA, { id: "f", outerHTML: "<filter id='b'/>" }],
      maskRasters: [rasterA, { ...rasterA, rid: "mr1" }],
    });
    expect(fragmentDefinitionKey("m", 1)).toBe("1\u0000m");
    expect(collectFragmentMaskDefs([root]).get("1\u0000m")?.outerHTML).toContain("id='a'");
    expect(collectFragmentClipPathDefs([root]).has("2\u0000c")).toBe(true);
    expect(collectFragmentFilterDefs([root]).get("f")).toBe(filterA);
    expect(collectElementMaskRasters([root]).get("source")).toBe(rasterA);
  });

  it("keeps collapsed-border consensus scoped to each table", () => {
    const target = element("td", [], {
      x: 1, y: 1, width: 10, height: 10,
      styles: { borderCollapse: "collapse" },
    });
    const voterA = element("td", [], {
      x: 0, y: 0, width: 10, height: 10,
      styles: { borderCollapse: "collapse" },
    });
    const voterB = element("td", [], {
      x: 0, y: 20, width: 10, height: 10,
      styles: { borderCollapse: "collapse" },
    });
    const tableA = element("table", [target]);
    const tableB = element("table", [voterA, voterB]);
    expect(collectOffGridCollapsedCells([tableA, tableB]).has(target)).toBe(false);
  });
});

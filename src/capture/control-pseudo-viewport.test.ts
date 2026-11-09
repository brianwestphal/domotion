import { describe, expect, it } from "vitest";
import {
  offscreenControlPseudoHostIds as selectHosts,
  type ControlPseudoViewportSnapshot,
} from "./control-pseudo-viewport.js";

const viewport = { x: 0, y: 0, width: 640, height: 320 };
const offscreenControlPseudoHostIds = (value: ControlPseudoViewportSnapshot, target: typeof viewport) =>
  selectHosts(value, target, 100);

function snapshot(): ControlPseudoViewportSnapshot {
  return {
    strings: ["none", "matrix(1, 0, 0, 1, 0, 20)", "data-domotion-anim", "reel", ""],
    documents: [
      {
        scrollOffsetX: 0,
        scrollOffsetY: 100,
        nodes: {
          backendNodeId: [100, 101, 102, 103],
          nodeType: [9, 1, 1, 1],
          parentIndex: [-1, 0, 1, 1],
          attributes: [[], [], [], []],
        },
        layout: {
          nodeIndex: [1, 2, 3],
          bounds: [
            [0, 0, 640, 3000],
            [10, 110, 100, 20],
            [10, 1000, 100, 20],
          ],
          styles: [[0], [0], [0]],
        },
      },
    ],
  };
}

describe("offscreen control pseudo host selection (DM-A93KQZ)", () => {
  it("subtracts document scroll and skips only proven nonintersecting boxes", () => {
    expect([...offscreenControlPseudoHostIds(snapshot(), viewport)]).toEqual([103]);
    expect([...offscreenControlPseudoHostIds(snapshot(), { ...viewport, y: 900 })]).toEqual([102]);
  });

  it("retains hosts with missing, degenerate or nonfinite bounds", () => {
    const base = snapshot();
    for (const bounds of [[], [10, 1000, 0, 20], [10, 1000, 100, 0], [10, NaN, 100, 20]]) {
      const main = base.documents[0];
      const value = {
        ...base,
        documents: [
          { ...main, layout: { ...main.layout, bounds: [main.layout.bounds[0], main.layout.bounds[1], bounds] } },
        ],
      };
      expect([...offscreenControlPseudoHostIds(value, viewport)]).toEqual([]);
    }
  });

  it("handles Chromium's style-less document LayoutView without protecting every host", () => {
    const base = snapshot();
    const main = base.documents[0];
    const value = {
      ...base,
      documents: [
        {
          ...main,
          layout: {
            nodeIndex: [0, ...main.layout.nodeIndex],
            bounds: [[0, 0, 640, 320], ...main.layout.bounds],
            styles: [[], ...main.layout.styles],
          },
        },
      ],
    };
    expect([...offscreenControlPseudoHostIds(value, viewport)]).toEqual([103]);
  });

  it("retains transformed hosts and their descendants even when currently outside", () => {
    const base = snapshot();
    const main = base.documents[0];
    for (const styles of [
      [[1], [0], [0]],
      [[0], [0], [1]],
    ]) {
      const value = { ...base, documents: [{ ...main, layout: { ...main.layout, styles } }] };
      expect([...offscreenControlPseudoHostIds(value, viewport)]).toEqual([]);
    }
  });

  it("retains a post-capture animation's entire subtree and ignores an empty marker", () => {
    const base = snapshot();
    const main = base.documents[0];
    const marked = { ...base, documents: [{ ...main, nodes: { ...main.nodes, attributes: [[], [2, 3], [], []] } }] };
    expect([...offscreenControlPseudoHostIds(marked, viewport)]).toEqual([]);
    const empty = { ...base, documents: [{ ...main, nodes: { ...main.nodes, attributes: [[], [2, 4], [], []] } }] };
    expect([...offscreenControlPseudoHostIds(empty, viewport)]).toEqual([103]);
  });

  it("does not filter child-frame nodes whose coordinates have a different origin", () => {
    const base = snapshot();
    const child = { ...base.documents[0], nodes: { ...base.documents[0].nodes, backendNodeId: [200, 201, 202, 203] } };
    expect([...offscreenControlPseudoHostIds({ ...base, documents: [...base.documents, child] }, viewport)]).toEqual([
      103,
    ]);
    expect([...offscreenControlPseudoHostIds({ ...base, documents: [child, ...base.documents] }, viewport)]).toEqual([
      103,
    ]);
    expect([...offscreenControlPseudoHostIds({ ...base, documents: [child] }, viewport)]).toEqual([]);
  });

  it("retains all hosts when scroll, ancestry, transform or viewport facts are unavailable", () => {
    const base = snapshot();
    const main = base.documents[0];
    const cases: ControlPseudoViewportSnapshot[] = [
      { ...base, documents: [] },
      { ...base, documents: [{ ...main, scrollOffsetY: undefined }] },
      { ...base, documents: [{ ...main, nodes: { ...main.nodes, parentIndex: [] } }] },
      { ...base, documents: [{ ...main, nodes: { ...main.nodes, parentIndex: [-1, 0, 1, 3] } }] },
      { ...base, documents: [{ ...main, layout: { ...main.layout, styles: [] } }] },
    ];
    for (const value of cases) expect([...offscreenControlPseudoHostIds(value, viewport)]).toEqual([]);
    expect([...offscreenControlPseudoHostIds(base, { ...viewport, width: NaN })]).toEqual([]);
  });
});

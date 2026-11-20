import { describe, expect, it } from "vitest";
import { authorTopology, type TreeNode } from "./external-css-svg-shadow-guard.js";

const node = (backendNodeId: number, extra: Partial<TreeNode> = {}): TreeNode => ({ backendNodeId, ...extra });

describe("authorTopology (DM-JDJ0DP)", () => {
  it("counts the owner and collects open and closed author roots in tree order, including nested ones", () => {
    const tree = node(1, {
      children: [
        node(2, {
          shadowRoots: [
            node(10, {
              shadowRootType: "closed",
              children: [node(11, { shadowRoots: [node(12, { shadowRootType: "open", children: [node(13)] })] })],
            }),
          ],
          children: [node(3)],
        }),
        node(4, { shadowRoots: [node(20, { shadowRootType: "open" })] }),
      ],
    });
    expect(authorTopology(tree, 3)).toEqual({ owners: 1, roots: [10, 12, 20] });
    // An owner inside a shadow tree is still found once by the pierced walk.
    expect(authorTopology(tree, 13)).toEqual({ owners: 1, roots: [10, 12, 20] });
    expect(authorTopology(tree, 99).owners).toBe(0);
  });

  it("excludes browser-owned UA roots", () => {
    const tree = node(1, { children: [node(2, { shadowRoots: [node(30, { shadowRootType: "user-agent" })] })] });
    expect(authorTopology(tree, 2)).toEqual({ owners: 1, roots: [] });
  });

  it("refuses an author root inside an embedded document, but not a UA root there", () => {
    const frameDocument = (type: string) =>
      node(1, {
        children: [
          node(2, {
            contentDocument: node(5, { children: [node(6, { shadowRoots: [node(7, { shadowRootType: type })] })] }),
          }),
        ],
      });
    expect(() => authorTopology(frameDocument("closed"), 2)).toThrow("author-shadow paint in an embedded document");
    expect(() => authorTopology(frameDocument("open"), 2)).toThrow("author-shadow paint in an embedded document");
    expect(authorTopology(frameDocument("user-agent"), 2)).toEqual({ owners: 1, roots: [] });
  });

  it("counts a duplicated owner backend so the caller can refuse it", () => {
    const tree = node(1, {
      children: [node(3), node(2, { shadowRoots: [node(9, { shadowRootType: "open", children: [node(3)] })] })],
    });
    expect(authorTopology(tree, 3)).toEqual({ owners: 2, roots: [9] });
  });
});

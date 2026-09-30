import { describe, expect, it } from "vitest";
import type { CapturedElement } from "../capture/types.js";
import { walkCapturedElements } from "./walk-captured-elements.js";

const element = (tag: string, children: CapturedElement[] = []): CapturedElement =>
  ({ tag, children }) as CapturedElement;

describe("walkCapturedElements", () => {
  it("visits each nested element in document preorder and accepts empty trees", () => {
    const tags: string[] = [];
    walkCapturedElements([], (item) => tags.push(item.tag));
    walkCapturedElements([element("a", [element("b"), element("c", [element("d")])]), element("e")], (item) =>
      tags.push(item.tag),
    );
    expect(tags).toEqual(["a", "b", "c", "d", "e"]);
  });
});

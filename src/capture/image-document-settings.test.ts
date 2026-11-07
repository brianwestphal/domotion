import { describe, expect, it } from "vitest";

import { stampImageDocumentSettings, treeHasImgElement } from "./image-document-settings.js";
import type { CapturedElement } from "./types.js";
import { capturedElement } from "../test-support/captured-fixtures.js";

const node = (tag: string, children: CapturedElement[] = []): CapturedElement => capturedElement({ tag, children });

describe("image document Settings stamping", () => {
  it("finds nested <img> elements and stamps only them", () => {
    const img = node("img");
    const div = node("div", [node("span", [img])]);
    expect(treeHasImgElement([node("div")])).toBe(false);
    expect(treeHasImgElement([div])).toBe(true);
    stampImageDocumentSettings([div], { prefersReducedMotion: true, forcedColors: false });
    expect(img.imageDocumentPrefersReducedMotion).toBe(true);
    expect(img.imageDocumentForcedColors).toBe(false);
    expect(div.imageDocumentPrefersReducedMotion).toBeUndefined();
  });
});

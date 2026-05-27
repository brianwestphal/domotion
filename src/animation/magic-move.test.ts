import { describe, expect, it } from "vitest";

import type { CapturedElement } from "../capture/types.js";
import { buildMagicMove } from "./magic-move.js";

// Minimal CapturedElement factory (mirrors tree-diff.test.ts). diffTrees reads
// tag/text/children for fingerprinting and x/y/width/height for bbox shift;
// buildMagicMove additionally reads/sets `animId` and walks `children`.
function el(opts: Partial<CapturedElement> & { tag: string; x: number; y: number; width?: number; height?: number; text?: string; children?: CapturedElement[] }): CapturedElement {
  return {
    text: "",
    width: 100,
    height: 20,
    styles: {} as CapturedElement["styles"],
    children: [],
    ...opts,
  };
}

// A render stub that records which animId-annotated elements it was handed and
// returns a marker string per root, so tests can assert on annotation without
// the real (heavy) SVG renderer.
function stubRender(roots: CapturedElement[]): string {
  const ids: string[] = [];
  const walk = (e: CapturedElement): void => {
    if (e.animId != null) ids.push(e.animId);
    for (const c of e.children) walk(c);
  };
  for (const r of roots) walk(r);
  return `<!--render ids=${ids.join(",")} roots=${roots.length}-->`;
}

describe("buildMagicMove (DM-898)", () => {
  it("returns null when nothing moved / was added / removed", () => {
    const prev = el({ tag: "body", x: 0, y: 0, children: [el({ tag: "p", x: 10, y: 10, text: "Hi" })] });
    const next = JSON.parse(JSON.stringify(prev));
    expect(buildMagicMove(prev, next, stubRender, "mm0-")).toBeNull();
  });

  it("emits a slide with the prev→next delta for a moved element", () => {
    const prev = el({ tag: "body", x: 0, y: 0, children: [el({ tag: "div", x: 10, y: 10, text: "card" })] });
    const next = el({ tag: "body", x: 0, y: 0, children: [el({ tag: "div", x: 60, y: 90, text: "card" })] });
    const mm = buildMagicMove(prev, next, stubRender, "mm0-")!;
    expect(mm).not.toBeNull();
    expect(mm.slides).toHaveLength(1);
    // dx = next.x − prev.x = 50; dy = 80.
    expect(mm.slides[0]).toMatchObject({ dx: 50, dy: 80 });
    // The slide class was actually stamped onto the rendered composite.
    expect(mm.compositeSvg).toContain(mm.slides[0].cls.replace("anim-", ""));
  });

  it("animates only the highest moved ancestor, not its moved children", () => {
    // A card moves by (40, 40); its child text moves by the same delta. Only
    // the card should slide — animating both would double-translate the child.
    const prev = el({ tag: "body", x: 0, y: 0, children: [
      el({ tag: "div", x: 10, y: 10, children: [el({ tag: "span", x: 12, y: 12, text: "x" })] }),
    ]});
    const next = el({ tag: "body", x: 0, y: 0, children: [
      el({ tag: "div", x: 50, y: 50, children: [el({ tag: "span", x: 52, y: 52, text: "x" })] }),
    ]});
    const mm = buildMagicMove(prev, next, stubRender, "mm0-")!;
    expect(mm.slides).toHaveLength(1);
    expect(mm.slides[0]).toMatchObject({ dx: 40, dy: 40 });
  });

  it("fades in added elements and fades out removed ones", () => {
    const prev = el({ tag: "body", x: 0, y: 0, children: [
      el({ tag: "p", x: 10, y: 10, text: "stays" }),
      el({ tag: "p", x: 10, y: 40, text: "goes away" }),
    ]});
    const next = el({ tag: "body", x: 0, y: 0, children: [
      el({ tag: "p", x: 10, y: 10, text: "stays" }),
      el({ tag: "p", x: 10, y: 40, text: "brand new" }),
    ]});
    const mm = buildMagicMove(prev, next, stubRender, "mm0-")!;
    expect(mm.fadeIn).toHaveLength(1);   // "brand new"
    expect(mm.fadeOut).toHaveLength(1);  // "goes away"
    expect(mm.slides).toHaveLength(0);
  });
});

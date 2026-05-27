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
    // Pure move (no size change) → a single translate from prev to next origin:
    // prev.x − next.x = -50, prev.y − next.y = -80.
    expect(mm.slides[0].from).toBe("translate(-50px, -80px)");
    // The slide class was actually stamped onto the rendered composite.
    expect(mm.compositeSvg).toContain(mm.slides[0].cls.replace("anim-", ""));
  });

  it("emits a translate·scale affine for an element that moves AND resizes (DM-899)", () => {
    // A card grows 2× (100×40 → 200×80) and relocates (10,10 → 60,90).
    const prev = el({ tag: "body", x: 0, y: 0, children: [el({ tag: "div", x: 10, y: 10, width: 100, height: 40, text: "card" })] });
    const next = el({ tag: "body", x: 0, y: 0, children: [el({ tag: "div", x: 60, y: 90, width: 200, height: 80, text: "card" })] });
    const mm = buildMagicMove(prev, next, stubRender, "mm0-")!;
    expect(mm.slides).toHaveLength(1);
    // prevSize/nextSize = 0.5; maps the next-rendered box back onto the prev box.
    expect(mm.slides[0].from).toBe("translate(10px, 10px) scale(0.5, 0.5) translate(-60px, -90px)");
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
    expect(mm.slides[0].from).toBe("translate(-40px, -40px)");
  });

  it("force-pairs by data-magic-key even when content differs (DM-900)", () => {
    // Different tag-content (text "A" vs "B") AND a move: the fingerprint
    // heuristic would split these into add + remove (cross-fade). A shared
    // data-magic-key must instead pair them into a single slide.
    const prev = el({ tag: "body", x: 0, y: 0, children: [
      el({ tag: "div", x: 10, y: 10, text: "A", magicKey: "hero" }),
    ]});
    const next = el({ tag: "body", x: 0, y: 0, children: [
      el({ tag: "div", x: 200, y: 200, text: "B", magicKey: "hero" }),
    ]});

    // Sanity: without the keys this is add + remove (independent appear /
    // disappear) — NO slide, because the heuristic can't pair "A" with "B".
    const noKey = buildMagicMove(
      el({ tag: "body", x: 0, y: 0, children: [el({ tag: "div", x: 10, y: 10, text: "A" })] }),
      el({ tag: "body", x: 0, y: 0, children: [el({ tag: "div", x: 200, y: 200, text: "B" })] }),
      stubRender, "mm0-")!;
    expect(noKey.slides).toHaveLength(0);

    // With the key the element is PAIRED → it slides. Since its content also
    // changed (A→B), the DM-903 dual-render kicks in: two co-moving copies
    // (prev + next appearance) that cross-fade, both tracing the prev→next path.
    const mm = buildMagicMove(prev, next, stubRender, "mm0-")!;
    expect(mm.slides).toHaveLength(2);
    const nextCopy = mm.slides.find((s) => s.to === "none")!;
    expect(nextCopy.from).toBe("translate(-190px, -190px)"); // next copy slides in from prev rect
    expect(mm.fadeIn).toHaveLength(1);   // next appearance fades in
    expect(mm.fadeOut).toHaveLength(1);  // prev appearance fades out
  });

  it("dual-renders a cross-fade when a mover's PAINT changes, not just its box (DM-903)", () => {
    // Same text, same structure, but the card is recolored AND moved — the
    // fingerprint still pairs it (color isn't in the fingerprint), so it's a
    // single mover; the paint change must trigger the prev+next cross-fade.
    const blue = { color: "rgb(0,0,0)", backgroundColor: "rgb(0,0,255)", opacity: "1" } as CapturedElement["styles"];
    const red = { color: "rgb(0,0,0)", backgroundColor: "rgb(255,0,0)", opacity: "1" } as CapturedElement["styles"];
    const prev = el({ tag: "body", x: 0, y: 0, children: [el({ tag: "div", x: 10, y: 10, text: "Card", styles: blue })] });
    const next = el({ tag: "body", x: 0, y: 0, children: [el({ tag: "div", x: 120, y: 60, text: "Card", styles: red })] });
    const mm = buildMagicMove(prev, next, stubRender, "mm0-")!;
    // Two slide copies (next-appearance + prev-appearance), one fading in, one out.
    expect(mm.slides).toHaveLength(2);
    expect(mm.fadeIn).toHaveLength(1);
    expect(mm.fadeOut).toHaveLength(1);

    // A pure geometric move with NO paint change stays a single copy.
    const moveOnly = buildMagicMove(
      el({ tag: "body", x: 0, y: 0, children: [el({ tag: "div", x: 10, y: 10, text: "Card", styles: blue })] }),
      el({ tag: "body", x: 0, y: 0, children: [el({ tag: "div", x: 120, y: 60, text: "Card", styles: blue })] }),
      stubRender, "mm0-")!;
    expect(moveOnly.slides).toHaveLength(1);
    expect(moveOnly.fadeIn).toHaveLength(0);
    expect(moveOnly.fadeOut).toHaveLength(0);
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

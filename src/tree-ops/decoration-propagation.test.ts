import { describe, expect, it } from "vitest";

import type { CapturedElement } from "../capture/types.js";
import { propagateTextDecorations } from "./decoration-propagation.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

type StyleOverrides = Partial<CapturedElement["styles"]>;

function el(opts: { tag?: string; text?: string; styles?: StyleOverrides; children?: CapturedElement[] }): CapturedElement {
  return {
    tag: opts.tag ?? "span",
    text: opts.text ?? "",
    x: 0,
    y: 0,
    width: 100,
    height: 20,
    styles: {
      color: "rgb(0, 0, 0)",
      fontSize: "16px",
      fontFamily: "Helvetica",
      fontWeight: "400",
      ...opts.styles,
    } as CapturedElement["styles"],
    children: opts.children ?? [],
  };
}

/** A decorating span: red wavy underline, 2px thickness, 24px font. */
function decoStyles(overrides: StyleOverrides = {}): StyleOverrides {
  return {
    textDecorationLine: "underline",
    textDecorationStyle: "wavy",
    textDecorationColor: "rgb(220, 38, 38)",
    textDecorationThickness: "2px",
    textUnderlineOffset: "auto",
    fontSize: "24px",
    fontFamily: "system-ui",
    fontWeight: "400",
    ...overrides,
  };
}

// ── Basic propagation ───────────────────────────────────────────────────────

describe("propagateTextDecorations: basics", () => {
  it("annotates an in-flow child with the parent's decoration + font", () => {
    // The DM-1723 shape: <span class="wavy">regular <strong>bold</strong></span>
    const strong = el({ tag: "strong", text: "bold", styles: { fontWeight: "700", textDecorationLine: "none" } });
    const span = el({ text: "regular ", styles: decoStyles(), children: [strong] });
    propagateTextDecorations([span]);
    expect(strong.propagatedDecorations).toEqual([{
      line: "underline",
      style: "wavy",
      color: "rgb(220, 38, 38)",
      thickness: "2px",
      underlineOffset: "auto",
      fontFamily: "system-ui",
      fontSize: 24,
      fontWeight: "400",
      fontStyle: undefined,
    }]);
    // The decorating element itself is not annotated.
    expect(span.propagatedDecorations).toBeUndefined();
  });

  it("propagates through undecorated intermediate inlines to deeper text", () => {
    const em = el({ tag: "em", text: "deep", styles: { textDecorationLine: "none" } });
    const b = el({ tag: "b", styles: { textDecorationLine: "none" }, children: [em] });
    const span = el({ text: "top ", styles: decoStyles(), children: [b] });
    propagateTextDecorations([span]);
    expect(em.propagatedDecorations?.[0]?.line).toBe("underline");
    // The textless intermediate still forwards but is not annotated itself.
    expect(b.propagatedDecorations).toBeUndefined();
  });

  it("annotates elements with textSegments but empty text", () => {
    const child = el({ tag: "strong", styles: { textDecorationLine: "none" } });
    child.textSegments = [{ text: "seg", x: 0, y: 0, width: 10, height: 10 } as NonNullable<CapturedElement["textSegments"]>[number]];
    const span = el({ styles: decoStyles(), children: [child] });
    propagateTextDecorations([span]);
    expect(child.propagatedDecorations?.[0]?.line).toBe("underline");
  });

  it("resolves currentcolor decoration color against the DECORATING element's color", () => {
    const strong = el({ tag: "strong", text: "bold", styles: { color: "rgb(9, 9, 9)", textDecorationLine: "none" } });
    const span = el({
      text: "t",
      styles: decoStyles({ textDecorationColor: "currentcolor", color: "rgb(1, 2, 3)" }),
      children: [strong],
    });
    propagateTextDecorations([span]);
    expect(strong.propagatedDecorations?.[0]?.color).toBe("rgb(1, 2, 3)");
  });

  it("accumulates the whole ancestor chain, outermost first (DM-1725)", () => {
    // Blink's AppliedTextDecorations: <u><span style="overline">x</span></u>
    // paints BOTH lines over "x" — both entries reach the leaf, applied order.
    const leaf = el({ text: "leaf", styles: { textDecorationLine: "none" } });
    const inner = el({ text: "mid", styles: decoStyles({ textDecorationLine: "overline", textDecorationStyle: "dotted", textDecorationColor: "rgb(0, 0, 255)" }), children: [leaf] });
    const outer = el({ styles: decoStyles(), children: [inner] });
    propagateTextDecorations([outer]);
    expect(leaf.propagatedDecorations).toHaveLength(2);
    expect(leaf.propagatedDecorations?.[0]?.line).toBe("underline"); // outermost first
    expect(leaf.propagatedDecorations?.[0]?.style).toBe("wavy");
    expect(leaf.propagatedDecorations?.[1]?.line).toBe("overline");
    expect(leaf.propagatedDecorations?.[1]?.style).toBe("dotted");
    expect(leaf.propagatedDecorations?.[1]?.color).toBe("rgb(0, 0, 255)");
    // The intermediate decorating element receives only ITS ancestors' entry
    // (its own decoration is emitted from its styles, not the annotation).
    expect(inner.propagatedDecorations).toHaveLength(1);
    expect(inner.propagatedDecorations?.[0]?.line).toBe("underline");
  });

  it("a child with its OWN decoration still receives the ancestors' entries (DM-1725)", () => {
    // Chrome paints the parent underline AND the child's line-through.
    const child = el({ text: "struck", styles: { textDecorationLine: "line-through" } });
    const span = el({ styles: decoStyles(), children: [child] });
    propagateTextDecorations([span]);
    expect(child.propagatedDecorations).toHaveLength(1);
    expect(child.propagatedDecorations?.[0]?.line).toBe("underline");
  });

  it("no decorating ancestor → nothing annotated", () => {
    const child = el({ text: "plain", styles: { textDecorationLine: "none" } });
    const parent = el({ text: "plain", styles: { textDecorationLine: "none" }, children: [child] });
    propagateTextDecorations([parent]);
    expect(parent.propagatedDecorations).toBeUndefined();
    expect(child.propagatedDecorations).toBeUndefined();
  });
});

// ── Propagation blockers (CSS Text Decoration 3 §2) ─────────────────────────

describe("propagateTextDecorations: blockers", () => {
  for (const [name, styles] of [
    ["position: absolute", { position: "absolute" }],
    ["position: fixed", { position: "fixed" }],
    ["float: left", { float: "left" }],
    ["display: inline-block", { display: "inline-block" }],
    ["display: inline-table", { display: "inline-table" }],
    ["display: inline-flex", { display: "inline-flex" }],
    ["display: inline-grid", { display: "inline-grid" }],
  ] as const) {
    it(`${name} blocks receiving AND forwarding`, () => {
      const grandchild = el({ text: "deep", styles: { textDecorationLine: "none" } });
      const blocked = el({ text: "blocked", styles: { textDecorationLine: "none", ...styles }, children: [grandchild] });
      const span = el({ styles: decoStyles(), children: [blocked] });
      propagateTextDecorations([span]);
      expect(blocked.propagatedDecorations).toBeUndefined();
      expect(grandchild.propagatedDecorations).toBeUndefined();
    });
  }

  it("a blocked element that itself decorates starts a NEW propagation context", () => {
    const inner = el({ text: "inner", styles: { textDecorationLine: "none" } });
    const blocked = el({
      text: "chip",
      styles: decoStyles({ display: "inline-block", textDecorationStyle: "solid" }),
      children: [inner],
    });
    const span = el({ styles: decoStyles(), children: [blocked] });
    propagateTextDecorations([span]);
    // Doesn't receive the outer wavy…
    expect(blocked.propagatedDecorations).toBeUndefined();
    // …but its own solid underline propagates inward.
    expect(inner.propagatedDecorations?.[0]?.style).toBe("solid");
  });

  it("relative / static positioning does NOT block", () => {
    const child = el({ text: "rel", styles: { textDecorationLine: "none", position: "relative" } });
    const span = el({ styles: decoStyles(), children: [child] });
    propagateTextDecorations([span]);
    expect(child.propagatedDecorations?.[0]?.line).toBe("underline");
  });

  it("plain block display does NOT block (block containers receive propagation)", () => {
    const p = el({ tag: "p", text: "para", styles: { textDecorationLine: "none", display: "block" } });
    const div = el({ tag: "div", styles: decoStyles({ display: "block" }), children: [p] });
    propagateTextDecorations([div]);
    expect(p.propagatedDecorations?.[0]?.line).toBe("underline");
  });
});

// ── State / sequencing (transition-matrix guard) ────────────────────────────

describe("propagateTextDecorations: idempotence + re-run transitions", () => {
  it("re-running is idempotent", () => {
    const strong = el({ tag: "strong", text: "bold", styles: { textDecorationLine: "none" } });
    const span = el({ styles: decoStyles(), children: [strong] });
    propagateTextDecorations([span]);
    const first = JSON.parse(JSON.stringify(strong.propagatedDecorations));
    propagateTextDecorations([span]);
    expect(strong.propagatedDecorations).toEqual(first);
  });

  it("clears stale annotations when the decoration is removed between runs", () => {
    const strong = el({ tag: "strong", text: "bold", styles: { textDecorationLine: "none" } });
    const span = el({ styles: decoStyles(), children: [strong] });
    propagateTextDecorations([span]);
    expect(strong.propagatedDecorations).toBeDefined();
    // Frame 2 of an animation might drop the decoration — stale annotations
    // must not survive the re-run.
    span.styles.textDecorationLine = "none";
    propagateTextDecorations([span]);
    expect(strong.propagatedDecorations).toBeUndefined();
  });

  it("handles multiple top-level roots independently", () => {
    const c1 = el({ text: "a", styles: { textDecorationLine: "none" } });
    const r1 = el({ styles: decoStyles(), children: [c1] });
    const c2 = el({ text: "b", styles: { textDecorationLine: "none" } });
    const r2 = el({ styles: { textDecorationLine: "none" }, children: [c2] });
    propagateTextDecorations([r1, r2]);
    expect(c1.propagatedDecorations?.[0]?.line).toBe("underline");
    expect(c2.propagatedDecorations).toBeUndefined();
  });
});

// ── DM-1732: decorating-box baselines for vertical-align-shifted children ───

describe("propagateTextDecorations: decorating-box baselines (DM-1732)", () => {
  it("records the decorating element's own segment baselines (deduped, rounded)", () => {
    const child = el({ tag: "sub", text: "2", styles: { textDecorationLine: "none" } });
    const u = el({ text: "H O", styles: decoStyles(), children: [child] });
    u.fontAscent = 22.3;
    u.textSegments = [
      { text: "H ", x: 10, y: 100.2, width: 20, height: 30 },
      { text: " O", x: 50, y: 100.2, width: 20, height: 30 },
      { text: "wrap", x: 10, y: 140.2, width: 40, height: 30 },
    ] as NonNullable<CapturedElement["textSegments"]>;
    propagateTextDecorations([u]);
    // 100.2+22.3=122.5 → 123 (deduped across the two same-line segs); 140.2+22.3=162.5 → 163
    expect(child.propagatedDecorations?.[0]?.baselines).toEqual([123, 163]);
  });

  it("uses per-segment fontAscent overrides when present", () => {
    const child = el({ text: "x", styles: { textDecorationLine: "none" } });
    const u = el({ text: "big", styles: decoStyles(), children: [child] });
    u.fontAscent = 20;
    u.textSegments = [
      { text: "big", x: 0, y: 100, width: 30, height: 40, fontAscent: 30 } as NonNullable<CapturedElement["textSegments"]>[number],
    ];
    propagateTextDecorations([u]);
    expect(child.propagatedDecorations?.[0]?.baselines).toEqual([130]);
  });

  it("textless decorating element records no baselines", () => {
    const child = el({ text: "only", styles: { textDecorationLine: "none" } });
    const u = el({ styles: decoStyles(), children: [child] });
    propagateTextDecorations([u]);
    expect(child.propagatedDecorations?.[0]?.baselines).toBeUndefined();
  });
});

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
    expect(strong.propagatedDecoration).toEqual({
      line: "underline",
      style: "wavy",
      color: "rgb(220, 38, 38)",
      thickness: "2px",
      underlineOffset: "auto",
      fontFamily: "system-ui",
      fontSize: 24,
      fontWeight: "400",
      fontStyle: undefined,
    });
    // The decorating element itself is not annotated.
    expect(span.propagatedDecoration).toBeUndefined();
  });

  it("propagates through undecorated intermediate inlines to deeper text", () => {
    const em = el({ tag: "em", text: "deep", styles: { textDecorationLine: "none" } });
    const b = el({ tag: "b", styles: { textDecorationLine: "none" }, children: [em] });
    const span = el({ text: "top ", styles: decoStyles(), children: [b] });
    propagateTextDecorations([span]);
    expect(em.propagatedDecoration?.line).toBe("underline");
    // The textless intermediate still forwards but is not annotated itself.
    expect(b.propagatedDecoration).toBeUndefined();
  });

  it("annotates elements with textSegments but empty text", () => {
    const child = el({ tag: "strong", styles: { textDecorationLine: "none" } });
    child.textSegments = [{ text: "seg", x: 0, y: 0, width: 10, height: 10 } as NonNullable<CapturedElement["textSegments"]>[number]];
    const span = el({ styles: decoStyles(), children: [child] });
    propagateTextDecorations([span]);
    expect(child.propagatedDecoration?.line).toBe("underline");
  });

  it("resolves currentcolor decoration color against the DECORATING element's color", () => {
    const strong = el({ tag: "strong", text: "bold", styles: { color: "rgb(9, 9, 9)", textDecorationLine: "none" } });
    const span = el({
      text: "t",
      styles: decoStyles({ textDecorationColor: "currentcolor", color: "rgb(1, 2, 3)" }),
      children: [strong],
    });
    propagateTextDecorations([span]);
    expect(strong.propagatedDecoration?.color).toBe("rgb(1, 2, 3)");
  });

  it("nearest decorating ancestor wins", () => {
    const leaf = el({ text: "leaf", styles: { textDecorationLine: "none" } });
    const inner = el({ styles: decoStyles({ textDecorationStyle: "dotted", textDecorationColor: "rgb(0, 0, 255)" }), children: [leaf] });
    const outer = el({ styles: decoStyles(), children: [inner] });
    propagateTextDecorations([outer]);
    expect(leaf.propagatedDecoration?.style).toBe("dotted");
    expect(leaf.propagatedDecoration?.color).toBe("rgb(0, 0, 255)");
  });

  it("does not annotate a child that carries its own decoration", () => {
    const child = el({ text: "struck", styles: { textDecorationLine: "line-through" } });
    const span = el({ styles: decoStyles(), children: [child] });
    propagateTextDecorations([span]);
    // Own decoration wins; the (unmodeled) Chrome behavior would paint both.
    expect(child.propagatedDecoration).toBeUndefined();
  });

  it("no decorating ancestor → nothing annotated", () => {
    const child = el({ text: "plain", styles: { textDecorationLine: "none" } });
    const parent = el({ text: "plain", styles: { textDecorationLine: "none" }, children: [child] });
    propagateTextDecorations([parent]);
    expect(parent.propagatedDecoration).toBeUndefined();
    expect(child.propagatedDecoration).toBeUndefined();
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
      expect(blocked.propagatedDecoration).toBeUndefined();
      expect(grandchild.propagatedDecoration).toBeUndefined();
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
    expect(blocked.propagatedDecoration).toBeUndefined();
    // …but its own solid underline propagates inward.
    expect(inner.propagatedDecoration?.style).toBe("solid");
  });

  it("relative / static positioning does NOT block", () => {
    const child = el({ text: "rel", styles: { textDecorationLine: "none", position: "relative" } });
    const span = el({ styles: decoStyles(), children: [child] });
    propagateTextDecorations([span]);
    expect(child.propagatedDecoration?.line).toBe("underline");
  });

  it("plain block display does NOT block (block containers receive propagation)", () => {
    const p = el({ tag: "p", text: "para", styles: { textDecorationLine: "none", display: "block" } });
    const div = el({ tag: "div", styles: decoStyles({ display: "block" }), children: [p] });
    propagateTextDecorations([div]);
    expect(p.propagatedDecoration?.line).toBe("underline");
  });
});

// ── State / sequencing (transition-matrix guard) ────────────────────────────

describe("propagateTextDecorations: idempotence + re-run transitions", () => {
  it("re-running is idempotent", () => {
    const strong = el({ tag: "strong", text: "bold", styles: { textDecorationLine: "none" } });
    const span = el({ styles: decoStyles(), children: [strong] });
    propagateTextDecorations([span]);
    const first = JSON.parse(JSON.stringify(strong.propagatedDecoration));
    propagateTextDecorations([span]);
    expect(strong.propagatedDecoration).toEqual(first);
  });

  it("clears stale annotations when the decoration is removed between runs", () => {
    const strong = el({ tag: "strong", text: "bold", styles: { textDecorationLine: "none" } });
    const span = el({ styles: decoStyles(), children: [strong] });
    propagateTextDecorations([span]);
    expect(strong.propagatedDecoration).toBeDefined();
    // Frame 2 of an animation might drop the decoration — stale annotations
    // must not survive the re-run.
    span.styles.textDecorationLine = "none";
    propagateTextDecorations([span]);
    expect(strong.propagatedDecoration).toBeUndefined();
  });

  it("handles multiple top-level roots independently", () => {
    const c1 = el({ text: "a", styles: { textDecorationLine: "none" } });
    const r1 = el({ styles: decoStyles(), children: [c1] });
    const c2 = el({ text: "b", styles: { textDecorationLine: "none" } });
    const r2 = el({ styles: { textDecorationLine: "none" }, children: [c2] });
    propagateTextDecorations([r1, r2]);
    expect(c1.propagatedDecoration?.line).toBe("underline");
    expect(c2.propagatedDecoration).toBeUndefined();
  });
});

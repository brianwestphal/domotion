import { describe, expect, it } from "vitest";

import type { CapturedElement } from "../capture/types.js";
import { diffTrees, dominantTranslate, entriesOfKind } from "./tree-diff.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

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

// ── Pure static (no changes) ────────────────────────────────────────────────

describe("diffTrees: static", () => {
  it("identical trees → every entry is static", () => {
    const prev = el({ tag: "body", x: 0, y: 0, children: [
      el({ tag: "h1", x: 10, y: 10, text: "Title" }),
      el({ tag: "p",  x: 10, y: 40, text: "Hello" }),
    ]});
    const next = JSON.parse(JSON.stringify(prev));
    const diff = diffTrees(prev, next);
    expect(diff.entries.every((e) => e.kind === "static")).toBe(true);
    expect(diff.entries).toHaveLength(3);   // root + 2 children
  });

  it("identical trees with sub-pixel drift still static", () => {
    const prev = el({ tag: "p", x: 10, y: 40, text: "Hi" });
    const next = el({ tag: "p", x: 10.3, y: 40.1, text: "Hi" });
    const diff = diffTrees(prev, next);
    expect(diff.entries[0].kind).toBe("static");
  });
});

// ── Pure translation ────────────────────────────────────────────────────────

describe("diffTrees: pure translation", () => {
  it("every element shifted by the same dy → all translated", () => {
    const prev = el({ tag: "body", x: 0, y: 0, children: [
      el({ tag: "h1", x: 10, y: 10, text: "Title" }),
      el({ tag: "p",  x: 10, y: 40, text: "Body" }),
    ]});
    const next = el({ tag: "body", x: 0, y: -300, children: [
      el({ tag: "h1", x: 10, y: -290, text: "Title" }),
      el({ tag: "p",  x: 10, y: -260, text: "Body" }),
    ]});
    const diff = diffTrees(prev, next);
    expect(diff.entries.filter((e) => e.kind === "translated")).toHaveLength(3);
    for (const e of diff.entries) {
      expect(e.kind).toBe("translated");
      expect(e.dy).toBe(-300);
    }
  });

  it("dominantTranslate detects whole-subtree shift", () => {
    const prev = el({ tag: "ul", x: 0, y: 0, children: [
      el({ tag: "li", x: 10, y: 10, text: "Row 1" }),
      el({ tag: "li", x: 10, y: 30, text: "Row 2" }),
      el({ tag: "li", x: 10, y: 50, text: "Row 3" }),
    ]});
    const next = el({ tag: "ul", x: 0, y: -500, children: [
      el({ tag: "li", x: 10, y: -490, text: "Row 1" }),
      el({ tag: "li", x: 10, y: -470, text: "Row 2" }),
      el({ tag: "li", x: 10, y: -450, text: "Row 3" }),
    ]});
    const diff = diffTrees(prev, next);
    const dt = dominantTranslate(diff);
    expect(dt).not.toBeNull();
    expect(dt!.dx).toBe(0);
    expect(dt!.dy).toBe(-500);
    expect(dt!.fraction).toBe(1);
  });
});

// ── Sticky header + scrolled body ───────────────────────────────────────────

describe("diffTrees: partial translation (sticky header + scrolled body)", () => {
  it("header stays put, body shifts", () => {
    const prev = el({ tag: "div", x: 0, y: 0, children: [
      el({ tag: "header", x: 0, y: 0,  text: "Nav", children: [
        el({ tag: "a", x: 10, y: 10, text: "Home" }),
      ]}),
      el({ tag: "main",   x: 0, y: 60, text: "",    children: [
        el({ tag: "p", x: 10, y: 70,  text: "Para 1" }),
        el({ tag: "p", x: 10, y: 100, text: "Para 2" }),
      ]}),
    ]});
    const next = el({ tag: "div", x: 0, y: 0, children: [
      el({ tag: "header", x: 0, y: 0,    text: "Nav", children: [
        el({ tag: "a", x: 10, y: 10, text: "Home" }),
      ]}),
      el({ tag: "main",   x: 0, y: -240, text: "",    children: [
        el({ tag: "p", x: 10, y: -230, text: "Para 1" }),
        el({ tag: "p", x: 10, y: -200, text: "Para 2" }),
      ]}),
    ]});
    const diff = diffTrees(prev, next);
    const statics    = entriesOfKind(diff, "static");
    const translated = entriesOfKind(diff, "translated");
    // Root div is static (same x=0, y=0).
    expect(statics.some((e) => e.prev?.tag === "div")).toBe(true);
    // Header + its child are static.
    expect(statics.some((e) => e.prev?.tag === "header")).toBe(true);
    expect(statics.some((e) => e.prev?.tag === "a")).toBe(true);
    // Main + its paragraphs are translated by dy=-300.
    expect(translated.some((e) => e.prev?.tag === "main" && e.dy === -300)).toBe(true);
    expect(translated.filter((e) => e.prev?.tag === "p")).toHaveLength(2);
  });
});

// ── Added / removed rows ────────────────────────────────────────────────────

describe("diffTrees: added / removed", () => {
  it("row inserted at the end", () => {
    const prev = el({ tag: "ul", x: 0, y: 0, children: [
      el({ tag: "li", x: 10, y: 10, text: "A" }),
      el({ tag: "li", x: 10, y: 30, text: "B" }),
    ]});
    const next = el({ tag: "ul", x: 0, y: 0, children: [
      el({ tag: "li", x: 10, y: 10, text: "A" }),
      el({ tag: "li", x: 10, y: 30, text: "B" }),
      el({ tag: "li", x: 10, y: 50, text: "C" }),
    ]});
    const diff = diffTrees(prev, next);
    const added = entriesOfKind(diff, "added");
    expect(added).toHaveLength(1);
    expect(added[0].next?.text).toBe("C");
  });

  it("row removed from the end", () => {
    const prev = el({ tag: "ul", x: 0, y: 0, children: [
      el({ tag: "li", x: 10, y: 10, text: "A" }),
      el({ tag: "li", x: 10, y: 30, text: "B" }),
    ]});
    const next = el({ tag: "ul", x: 0, y: 0, children: [
      el({ tag: "li", x: 10, y: 10, text: "A" }),
    ]});
    const diff = diffTrees(prev, next);
    const removed = entriesOfKind(diff, "removed");
    expect(removed).toHaveLength(1);
    expect(removed[0].prev?.text).toBe("B");
  });

  it("multiple adds and removes mixed with statics", () => {
    const prev = el({ tag: "ul", x: 0, y: 0, children: [
      el({ tag: "li", x: 10, y: 10, text: "Keep" }),
      el({ tag: "li", x: 10, y: 30, text: "Drop1" }),
      el({ tag: "li", x: 10, y: 50, text: "Drop2" }),
    ]});
    const next = el({ tag: "ul", x: 0, y: 0, children: [
      el({ tag: "li", x: 10, y: 10, text: "Keep" }),
      el({ tag: "li", x: 10, y: 30, text: "New1" }),
    ]});
    const diff = diffTrees(prev, next);
    expect(entriesOfKind(diff, "added").map((e) => e.next?.text)).toEqual(["New1"]);
    expect(entriesOfKind(diff, "removed").map((e) => e.prev?.text).sort()).toEqual(["Drop1", "Drop2"]);
    expect(entriesOfKind(diff, "static").some((e) => e.prev?.text === "Keep")).toBe(true);
  });
});

// ── Modified (same element, different content) ─────────────────────────────

describe("diffTrees: modified", () => {
  it("animId-stable element with text change → modified", () => {
    // An element carrying an explicit animId (the user's "this is the same
    // element across captures" hint) gets modified status even if the text
    // differs. Without animId, the fallback rule treats text-different
    // path-same elements as add+remove, not modified — see next test.
    const prev = el({ tag: "p", x: 10, y: 10, text: "Loading...", animId: "status" });
    const next = el({ tag: "p", x: 10, y: 10, text: "Done",       animId: "status" });
    const diff = diffTrees(prev, next);
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0].kind).toBe("modified");
  });

  it("path-same element with completely different text → add+remove (not modified)", () => {
    // Refuse to false-match `<p>Hello</p>` and `<p>Goodbye</p>` as the same
    // element just because they share a path. Without text or animId
    // agreement, classify as add + remove and let the composer crossfade.
    const prev = el({ tag: "p", x: 10, y: 10, text: "Hello" });
    const next = el({ tag: "p", x: 10, y: 10, text: "Goodbye" });
    const diff = diffTrees(prev, next);
    expect(entriesOfKind(diff, "modified")).toHaveLength(0);
    expect(entriesOfKind(diff, "removed").map((e) => e.prev?.text)).toEqual(["Hello"]);
    expect(entriesOfKind(diff, "added").map((e) => e.next?.text)).toEqual(["Goodbye"]);
  });

  it("text-equal parent with text-different child → parent modified, child add+remove", () => {
    // Parent's text is empty in both, so the Pass-2 text-equality rule lets
    // the parent match as modified. Child's text differs and there's no
    // animId, so it doesn't match the rule → falls through to add+remove.
    const prev = el({ tag: "section", x: 0, y: 0, children: [
      el({ tag: "p", x: 10, y: 10, text: "old" }),
    ]});
    const next = el({ tag: "section", x: 0, y: 0, children: [
      el({ tag: "p", x: 10, y: 10, text: "new" }),
    ]});
    const diff = diffTrees(prev, next);
    const mods = entriesOfKind(diff, "modified");
    expect(mods).toHaveLength(1);
    expect(mods[0].prev?.tag).toBe("section");
    const added = entriesOfKind(diff, "added");
    const removed = entriesOfKind(diff, "removed");
    expect(added.map((e) => e.next?.text)).toEqual(["new"]);
    expect(removed.map((e) => e.prev?.text)).toEqual(["old"]);
  });
});

// ── animId stability ───────────────────────────────────────────────────────

describe("diffTrees: animId-keyed matching", () => {
  it("animId disambiguates two elements with otherwise identical fingerprints", () => {
    // Without animId, two identical elements could swap match order. With
    // animId, each gets a stable identity.
    const prev = el({ tag: "div", x: 0, y: 0, children: [
      el({ tag: "p", x: 10, y: 10, text: "Same", animId: "first" }),
      el({ tag: "p", x: 10, y: 30, text: "Same", animId: "second" }),
    ]});
    const next = el({ tag: "div", x: 0, y: 0, children: [
      el({ tag: "p", x: 10, y: 40, text: "Same", animId: "first" }),    // moved down
      el({ tag: "p", x: 10, y: 10, text: "Same", animId: "second" }),   // moved up
    ]});
    const diff = diffTrees(prev, next);
    const firstMatch = diff.entries.find((e) => e.prev?.animId === "first" && e.next?.animId === "first");
    const secondMatch = diff.entries.find((e) => e.prev?.animId === "second" && e.next?.animId === "second");
    expect(firstMatch?.kind).toBe("translated");
    expect(firstMatch?.dy).toBe(30);
    expect(secondMatch?.kind).toBe("translated");
    expect(secondMatch?.dy).toBe(-20);
  });

  it("animId mismatch between trees prevents matching", () => {
    // Same content, but different animId values → fingerprint includes animId,
    // so they don't fingerprint-match. Pass 2 picks them up by path (same path,
    // same tag) and classifies as modified.
    const prev = el({ tag: "p", x: 10, y: 10, text: "Hi", animId: "a" });
    const next = el({ tag: "p", x: 10, y: 10, text: "Hi", animId: "b" });
    const diff = diffTrees(prev, next);
    expect(diff.entries[0].kind).toBe("modified");
  });
});

// ── Multiple roots (sibling forests) ───────────────────────────────────────

describe("diffTrees: sibling-forest input", () => {
  it("accepts arrays of roots", () => {
    const prev = [
      el({ tag: "div", x: 0, y: 0, text: "A" }),
      el({ tag: "div", x: 0, y: 50, text: "B" }),
    ];
    const next = [
      el({ tag: "div", x: 0, y: 0, text: "A" }),
      el({ tag: "div", x: 0, y: 50, text: "B" }),
    ];
    const diff = diffTrees(prev, next);
    expect(diff.entries.every((e) => e.kind === "static")).toBe(true);
    expect(diff.entries).toHaveLength(2);
  });
});

// ── dominantTranslate helper ───────────────────────────────────────────────

describe("dominantTranslate", () => {
  it("returns null when nothing translated", () => {
    const prev = el({ tag: "p", x: 10, y: 10, text: "Hi" });
    const next = el({ tag: "p", x: 10, y: 10, text: "Hi" });
    expect(dominantTranslate(diffTrees(prev, next))).toBeNull();
  });

  it("picks the largest bucket when translations vary", () => {
    // 4 elements: 3 move by dy=-100, 1 moves by dy=-50.
    const prev = el({ tag: "ul", x: 0, y: 0, children: [
      el({ tag: "li", x: 0, y: 10, text: "A" }),
      el({ tag: "li", x: 0, y: 30, text: "B" }),
      el({ tag: "li", x: 0, y: 50, text: "C" }),
      el({ tag: "li", x: 0, y: 70, text: "D" }),
    ]});
    const next = el({ tag: "ul", x: 0, y: -100, children: [
      el({ tag: "li", x: 0, y: -90, text: "A" }),
      el({ tag: "li", x: 0, y: -70, text: "B" }),
      el({ tag: "li", x: 0, y: -50, text: "C" }),
      el({ tag: "li", x: 0, y: 20, text: "D" }),    // moved only by dy=-50
    ]});
    const dt = dominantTranslate(diffTrees(prev, next));
    expect(dt).not.toBeNull();
    expect(dt!.dy).toBe(-100);
    expect(dt!.fraction).toBeCloseTo(4 / 5, 2);  // 4 of 5 moving entries (root counts too)
  });
});

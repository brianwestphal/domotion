import { describe, it, expect } from "vitest";
import type { Page } from "@playwright/test";
import { resolveOverlays } from "./resolve-overlays.js";

/**
 * DM-1132: the overlay-resolution engine (selector `anchor` + typing `maxWidth`
 * → concrete `x` / `y` / `bgWidth`). The page measurement is stubbed so the
 * resolution logic is unit-tested without a browser; the live-page path is
 * covered by the scripting-API probe and the existing CLI example regression
 * (the CLI now delegates to this same engine).
 */

// A stub Page whose `evaluate` returns a fixed anchor box (border box 50,60
// 200×100, content width 176, border-radius 12), standing in for the
// page.evaluate measurement.
const stubPage = (box: { x: number; y: number; width: number; height: number; contentWidth: number; borderRadius: number } | null): Page =>
  ({ evaluate: async () => box }) as unknown as Page;

const BOX = { x: 50, y: 60, width: 200, height: 100, contentWidth: 176, borderRadius: 12 };

describe("resolveOverlays (DM-1132)", () => {
  it("resolves a typing overlay's anchor + maxWidth:'anchor' and strips the authoring keys", async () => {
    const [ov] = await resolveOverlays(stubPage(BOX), [
      { kind: "typing", text: "hi", x: 0, y: 0, caret: true, anchor: { selector: "#t", at: "top-left", dx: 2, dy: 2 }, maxWidth: "anchor" },
    ]);
    // DM-1134: maxWidth controls wrapping, so it resolves into `wrapWidth`.
    expect(ov).toMatchObject({ kind: "typing", text: "hi", x: 52, y: 62, wrapWidth: 176, caret: true });
    expect("anchor" in ov).toBe(false);
    expect("maxWidth" in ov).toBe(false);
  });

  it("resolves a numeric maxWidth without requiring an anchor box", async () => {
    const [ov] = await resolveOverlays(stubPage(null), [
      { kind: "typing", text: "x", x: 10, y: 20, maxWidth: 320 },
    ]);
    expect(ov).toMatchObject({ kind: "typing", x: 10, y: 20, wrapWidth: 320 });
  });

  it("anchors a tap overlay at the requested corner", async () => {
    const [ov] = await resolveOverlays(stubPage(BOX), [
      { kind: "tap", x: 0, y: 0, anchor: { selector: "#t", at: "center" } },
    ]);
    expect(ov).toMatchObject({ kind: "tap", x: 150, y: 110 }); // center of the border box
  });

  it("passes through overlays with neither anchor nor maxWidth unchanged", async () => {
    const input = { kind: "blink" as const, x: 5, y: 6, width: 4, height: 4 };
    const [ov] = await resolveOverlays(stubPage(BOX), [input]);
    expect(ov).toEqual(input);
  });

  it("throws a clear error when the anchor selector matches nothing", async () => {
    await expect(
      resolveOverlays(stubPage(null), [{ kind: "typing", text: "x", x: 0, y: 0, anchor: { selector: "#nope" } }]),
    ).rejects.toThrow(/anchor selector "#nope" matched no element/);
  });

  // DM-1549 / DM-1551: an anchored `shine` overlay auto-sizes to the anchored
  // element's box and auto-rounds its clip to the element's border-radius.
  it("auto-sizes a shine overlay's width/height + radius from the anchored box", async () => {
    const [ov] = await resolveOverlays(stubPage(BOX), [
      // width/height 0 (the CLI defaults) → resolver fills them from the box;
      // default top-left anchor → (x, y) is the box top-left (the clip origin).
      { kind: "shine", x: 0, y: 0, width: 0, height: 0, anchor: { selector: "#badge" } },
    ] as never);
    expect(ov).toMatchObject({ kind: "shine", x: 50, y: 60, width: 200, height: 100, radius: 12 });
    expect("anchor" in ov).toBe(false);
  });

  it("respects an explicit positive width/height and an explicit radius over the anchor's box", async () => {
    const [ov] = await resolveOverlays(stubPage(BOX), [
      { kind: "shine", x: 0, y: 0, width: 90, height: 40, radius: 4, anchor: { selector: "#badge" } },
    ] as never);
    // x/y still come from the anchor; the explicit size + radius win.
    expect(ov).toMatchObject({ kind: "shine", x: 50, y: 60, width: 90, height: 40, radius: 4 });
  });

  it("leaves an un-anchored shine overlay's size/radius untouched", async () => {
    const input = { kind: "shine" as const, x: 5, y: 6, width: 100, height: 20, radius: 10 };
    const [ov] = await resolveOverlays(stubPage(BOX), [input] as never);
    expect(ov).toEqual(input);
  });

  // DM-1565: an `interact` overlay auto-SIZES + auto-ROUNDS from the anchored
  // element's box (like `shine`), with explicit positive values still winning.
  const RBOX = { ...BOX, borderRadius: 8 };

  it("auto-sizes + auto-rounds an anchored interact overlay from the element box", async () => {
    const [ov] = await resolveOverlays(stubPage(RBOX), [
      { kind: "interact", treatment: "hover", x: 0, y: 0, width: 0, height: 0, anchor: { selector: "#btn" } } as never,
    ]);
    // top-left anchor → box origin; width/height/radius from the box.
    expect(ov).toMatchObject({ kind: "interact", x: 50, y: 60, width: 200, height: 100, radius: 8 });
    expect("anchor" in ov).toBe(false);
  });

  it("keeps an explicit interact width / height / radius over the anchor box", async () => {
    const [ov] = await resolveOverlays(stubPage(RBOX), [
      { kind: "interact", x: 0, y: 0, width: 40, height: 20, radius: 2, anchor: { selector: "#btn" } } as never,
    ]);
    expect(ov).toMatchObject({ x: 50, y: 60, width: 40, height: 20, radius: 2 });
  });
});

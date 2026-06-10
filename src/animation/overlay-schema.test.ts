import { describe, it, expect } from "vitest";
import {
  typingOverlaySchema,
  tapOverlaySchema,
  svgOverlaySchema,
  blinkOverlaySchema,
  animationOverlaySchema,
  intraFrameAnimationSchema,
  type TypingOverlay,
  type AnimationOverlay,
} from "./overlay-schema.js";

/**
 * DM-1131: the overlay / intra-frame-animation shapes are defined ONCE here as
 * zod schemas; the renderer's runtime types are `z.infer`red from them and the
 * declarative-config layer extends the same bases. These tests pin the base
 * shape so a dropped/renamed field is caught here (and, via the `.extend()`
 * call sites in `src/cli/animate.ts`, at compile time) instead of silently
 * drifting — the failure mode that motivated the ticket.
 */
describe("overlay schema SSOT (DM-1131)", () => {
  it("parses a resolved typing overlay, keeping every field", () => {
    const ov = typingOverlaySchema.parse({
      kind: "typing", text: "hi", x: 10, y: 20,
      fontSize: 14, color: "#000", delay: 100, speed: 40,
      bgColor: "#fff", bgWidth: 200, bgHeight: 40, caret: { color: "#333", width: 2, blinkMs: 530 },
    });
    expect(ov.kind).toBe("typing");
    expect(ov.bgWidth).toBe(200);
    expect(ov.caret).toEqual({ color: "#333", width: 2, blinkMs: 530 });
  });

  it("requires the resolved x/y on a typing overlay (the authoring schema is what defaults them)", () => {
    expect(typingOverlaySchema.safeParse({ kind: "typing", text: "x" }).success).toBe(false);
  });

  it("parses tap / svg / blink resolved overlays", () => {
    expect(tapOverlaySchema.parse({ kind: "tap", x: 1, y: 2 }).kind).toBe("tap");
    expect(svgOverlaySchema.parse({ kind: "svg", innerSvg: "<g/>", x: 0, y: 0, width: 10, height: 10, animId: "s0" }).animId).toBe("s0");
    expect(blinkOverlaySchema.parse({ kind: "blink", x: 0, y: 0, width: 4, height: 4 }).kind).toBe("blink");
  });

  it("discriminates the overlay union on `kind`", () => {
    const ov: AnimationOverlay = animationOverlaySchema.parse({ kind: "blink", x: 0, y: 0, width: 4, height: 4 });
    expect(ov.kind).toBe("blink");
    expect(animationOverlaySchema.safeParse({ kind: "nope", x: 0, y: 0 }).success).toBe(false);
  });

  it("parses an intra-frame animation (the runtime shape carries animId, not selector)", () => {
    const a = intraFrameAnimationSchema.parse({ animId: "f0a0", property: "opacity", from: "0", to: "1", duration: 300 });
    expect(a.animId).toBe("f0a0");
    // The config-author `selector` form is the CLI's derived view, not this one.
    expect("selector" in a).toBe(false);
  });

  it("derives types that a consumer can annotate against (compile-time guard)", () => {
    const typed: TypingOverlay = { kind: "typing", text: "t", x: 0, y: 0 };
    expect(typed.text).toBe("t");
  });
});

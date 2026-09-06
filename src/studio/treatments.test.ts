import { describe, expect, it } from "vitest";
import { applyStudioTreatments, resolveStudioTreatmentPlan, StudioTreatmentError } from "./treatments.js";

const BASE = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><defs><clipPath id="clip"><rect width="320" height="180"/></clipPath></defs><style>@keyframes pulse{from{opacity:.8}to{opacity:1}}.card{animation:pulse 1s linear infinite}</style><rect class="card" clip-path="url(#clip)" width="320" height="180" fill="#2563eb"/></svg>`;
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20" fill="#f59e0b"/></svg>`;

describe("Studio cinematic treatment library", () => {
  it.each([
    ["device-frame", { kind: "device-frame", device: "phone" }],
    ["browser-chrome", { kind: "browser-chrome", label: "example.test" }],
    ["terminal-chrome", { kind: "terminal-chrome", title: "Build" }],
    ["zoom-pan", { kind: "zoom-pan", transform: { from: { x: 0, y: 0, scale: 1 }, to: { x: -20, y: -10, scale: 1.2 } } }],
    ["spotlight", { kind: "spotlight", mask: { region: { x: 40, y: 30, width: 120, height: 60 } } }],
    ["callout", { kind: "callout", text: "Choose this", anchor: { x: 80, y: 60 }, box: { x: 170, y: 25, width: 120, height: 44 } }],
    ["title-card", { kind: "title-card", title: "Ship faster", subtitle: "With confidence" }],
    ["logo-reveal", { kind: "logo-reveal", logo: LOGO }],
  ])("renders the %s preset as a self-contained SVG example", (_name, treatment) => {
    const result = applyStudioTreatments(BASE, [treatment], { brand: { palette: { primary: "#f59e0b", text: "#fff", background: "#111827" }, radius: 14 } });
    expect(result.svg).toMatch(/^<svg/);
    expect(result.svg).toMatch(/<\/svg>$/);
    expect(result.svg).not.toMatch(/(?:href|src)="https?:\/\//);
    expect(result.plan.layers).toHaveLength(1);
    expect(result.width).toBeGreaterThanOrEqual(320);
    expect(result.height).toBeGreaterThanOrEqual(180);
  });

  it("expands presets into composable primitives and keeps scene transition separate", () => {
    const plan = resolveStudioTreatmentPlan([
      { kind: "zoom-pan", transform: { from: { x: 0, y: 0 }, to: { x: 10, y: 10, scale: 1.1 } } },
      { kind: "spotlight", mask: { region: { x: 1, y: 2, width: 3, height: 4 } } },
      { kind: "callout", text: "Here", anchor: { x: 4, y: 5 }, box: { x: 10, y: 10, width: 80, height: 30 } },
      { kind: "scene-transition", transition: { type: "shine", duration: 240 } },
    ]);
    expect(plan).toMatchObject({
      transforms: [{ from: { x: 0, y: 0, scale: 1 }, to: { x: 10, y: 10, scale: 1.1 } }],
      masks: [{ region: { x: 1, y: 2, width: 3, height: 4 } }],
      transition: { type: "shine", duration: 240 },
    });
    expect(plan.layers).toHaveLength(3);
    expect(plan.layers[0]).toMatchObject({ id: "treatment-0-zoom-pan" });
    expect(plan.overlays).toHaveLength(2);
    expect(plan.timings).toHaveLength(3);
  });

  it("nests mixed treatments without id, keyframe, URL, or clip collisions", () => {
    const result = applyStudioTreatments(BASE, [
      { kind: "browser-chrome", label: "studio.local" },
      { kind: "zoom-pan", transform: { from: { x: 0, y: 0 }, to: { x: -8, y: -4, scale: 1.08 } } },
      { kind: "spotlight", mask: { region: { x: 60, y: 40, width: 100, height: 50 } } },
      { kind: "callout", text: "Primary action", anchor: { x: 110, y: 70 }, box: { x: 180, y: 100, width: 120, height: 44 } },
      { kind: "logo-reveal", logo: LOGO, position: { x: 16, y: 16 }, width: 60 },
    ]);
    const ids = [...result.svg.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.svg).not.toContain('url(#clip)');
    expect(result.svg).toContain("st4_st3_st2_st1_st0_clip");
    expect(result.svg).toContain("data:image/svg+xml;base64,");
  });

  it("uses brand defaults and fails closed on non-embedded logo URLs", () => {
    const branded = applyStudioTreatments(BASE, [{ kind: "title-card", title: "Branded" }], {
      brand: { background: "linear-gradient(#111,#222)", palette: { primary: "#0ea5e9", text: "#f8fafc" } },
    });
    expect(branded.svg).toContain("#0ea5e9");
    expect(branded.svg).toContain("<linearGradient");
    expect(() => applyStudioTreatments(BASE, [{ kind: "logo-reveal", logo: "https://example.test/logo.svg" }])).toThrow(StudioTreatmentError);
    expect(() => applyStudioTreatments(BASE, [{ kind: "logo-reveal", logo: '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.test/pixel.png"/></svg>' }])).toThrow(/remote resource/);
  });

  it("rejects malformed treatment timing and geometry", () => {
    expect(() => resolveStudioTreatmentPlan([{ kind: "spotlight", mask: { region: { x: 0, y: 0, width: 0, height: 10 } } }])).toThrow(/too small/i);
    expect(() => resolveStudioTreatmentPlan([{ kind: "zoom-pan", transform: { from: { x: 0, y: 0 }, to: { x: 0, y: 0 } }, timing: { durationMs: -1 } }])).toThrow(/durationMs/);
    expect(() => resolveStudioTreatmentPlan([
      { kind: "scene-transition", transition: { type: "cut", duration: 0 } },
      { kind: "scene-transition", transition: { type: "crossfade", duration: 100 } },
    ])).toThrow(/only one scene-transition/);
  });
});

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { studioTreatmentsSchema } from "./treatment-schema.js";
import { applyStudioTreatments, resolveStudioTreatmentPlan, StudioTreatmentError } from "./treatments.js";

const BASE = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><defs><clipPath id="clip"><rect width="320" height="180"/></clipPath></defs><style>@keyframes pulse{from{opacity:.8}to{opacity:1}}.card{animation:pulse 1s linear infinite}</style><rect class="card" clip-path="url(#clip)" width="320" height="180" fill="#2563eb"/></svg>`;
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20" fill="#f59e0b"/></svg>`;

describe("Studio cinematic treatment library", () => {
  it.each([
    ["device-frame", { kind: "device-frame", device: "phone" }],
    ["browser-chrome", { kind: "browser-chrome", label: "example.test" }],
    ["terminal-chrome", { kind: "terminal-chrome", title: "Build" }],
    [
      "zoom-pan",
      { kind: "zoom-pan", transform: { from: { x: 0, y: 0, scale: 1 }, to: { x: -20, y: -10, scale: 1.2 } } },
    ],
    ["spotlight", { kind: "spotlight", mask: { region: { x: 40, y: 30, width: 120, height: 60 } } }],
    [
      "callout",
      {
        kind: "callout",
        text: "Choose this",
        anchor: { x: 80, y: 60 },
        box: { x: 170, y: 25, width: 120, height: 44 },
      },
    ],
    ["title-card", { kind: "title-card", title: "Ship faster", subtitle: "With confidence" }],
    ["logo-reveal", { kind: "logo-reveal", logo: LOGO }],
  ])("renders the %s preset as a self-contained SVG example", (_name, treatment) => {
    const result = applyStudioTreatments(BASE, [treatment], {
      brand: { palette: { primary: "#f59e0b", text: "#fff", background: "#111827" }, radius: 14 },
    });
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
      {
        kind: "callout",
        text: "Primary action",
        anchor: { x: 110, y: 70 },
        box: { x: 180, y: 100, width: 120, height: 44 },
      },
      { kind: "logo-reveal", logo: LOGO, position: { x: 16, y: 16 }, width: 60 },
    ]);
    const ids = [...result.svg.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.svg).not.toContain("url(#clip)");
    expect(result.svg).toContain("st4_st3_st2_st1_st0_clip");
    expect(result.svg).toContain("data:image/svg+xml;base64,");
  });

  it("uses brand defaults and fails closed on non-embedded logo URLs", () => {
    const branded = applyStudioTreatments(BASE, [{ kind: "title-card", title: "Branded" }], {
      brand: { background: "linear-gradient(#111,#222)", palette: { primary: "#0ea5e9", text: "#f8fafc" } },
    });
    expect(branded.svg).toContain("#0ea5e9");
    expect(branded.svg).toContain("<linearGradient");
    expect(() => applyStudioTreatments(BASE, [{ kind: "logo-reveal", logo: "https://example.test/logo.svg" }])).toThrow(
      StudioTreatmentError,
    );
    expect(() =>
      applyStudioTreatments(BASE, [
        {
          kind: "logo-reveal",
          logo: '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.test/pixel.png"/></svg>',
        },
      ]),
    ).toThrow(/remote resource/);
  });

  it("rejects malformed treatment timing and geometry", () => {
    expect(() =>
      resolveStudioTreatmentPlan([{ kind: "spotlight", mask: { region: { x: 0, y: 0, width: 0, height: 10 } } }]),
    ).toThrow(/too small/i);
    expect(() =>
      resolveStudioTreatmentPlan([
        { kind: "zoom-pan", transform: { from: { x: 0, y: 0 }, to: { x: 0, y: 0 } }, timing: { durationMs: -1 } },
      ]),
    ).toThrow(/durationMs/);
    expect(() =>
      resolveStudioTreatmentPlan([
        { kind: "scene-transition", transition: { type: "cut", duration: 0 } },
        { kind: "scene-transition", transition: { type: "crossfade", duration: 100 } },
      ]),
    ).toThrow(/only one scene-transition/);
  });
});

// A treatment easing used to be any non-empty string, interpolated raw into the
// SVG `style` attribute, so `ease" onload="…` broke out of the attribute and
// injected markup into the "self-contained" output.
describe("treatment easing cannot inject markup", () => {
  const HOSTILE = 'ease" onload="alert(1)';
  const timed = (easing: string) => [
    {
      kind: "spotlight",
      mask: { region: { x: 40, y: 30, width: 120, height: 60 } },
      timing: { startMs: 0, durationMs: 400, easing },
    },
  ];

  it("rejects a non-easing string at the schema", () => {
    expect(() => resolveStudioTreatmentPlan(timed(HOSTILE))).toThrow(/easing: must be a CSS easing function/);
    expect(() => applyStudioTreatments(BASE, timed("ease;fill:red"))).toThrow(StudioTreatmentError);
  });

  it("accepts and emits every easing-function form", () => {
    for (const easing of [
      "ease-in-out",
      "cubic-bezier(0.22,1,0.36,1)",
      "steps(4, jump-end)",
      "linear(0, 0.4 30%, 1)",
    ]) {
      expect(applyStudioTreatments(BASE, timed(easing)).svg).toContain(`400ms ${easing} 0ms both`);
    }
  });

  it("escapes the style attribute even when a timing bypasses the schema", () => {
    const parse = studioTreatmentsSchema.safeParse.bind(studioTreatmentsSchema);
    const spy = vi.spyOn(studioTreatmentsSchema, "safeParse").mockImplementation((raw) => {
      const result = parse(raw);
      if (!result.success) throw new Error("fixture must parse");
      for (const treatment of result.data)
        if ("timing" in treatment && treatment.timing) treatment.timing.easing = HOSTILE;
      return result;
    });
    try {
      const { svg } = applyStudioTreatments(BASE, timed("ease"));
      expect(svg).not.toContain(HOSTILE);
      expect(svg).not.toMatch(/\sonload="/);
      expect(svg).toContain("ease&quot; onload=&quot;alert(1)");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("logo-reveal local assets stay inside the asset directory", () => {
  const withDirs = (run: (assetDir: string, outsideDir: string) => void): void => {
    const base = mkdtempSync(join(tmpdir(), "domotion-logo-"));
    try {
      const assetDir = join(base, "assets");
      const outsideDir = join(base, "outside");
      mkdirSync(assetDir);
      mkdirSync(outsideDir);
      writeFileSync(join(assetDir, "logo.svg"), LOGO);
      writeFileSync(join(outsideDir, "secret.svg"), LOGO);
      run(assetDir, outsideDir);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  };
  const render = (source: string, assetDir: string): string =>
    applyStudioTreatments(BASE, [{ kind: "logo-reveal", logo: source }], { assetDir }).svg;

  it("embeds a logo inside the directory", () => {
    withDirs((assetDir) => {
      expect(render("logo.svg", assetDir)).toContain("data:image/svg+xml;base64,");
    });
  });

  it("refuses ../ traversal and an absolute path elsewhere", () => {
    withDirs((assetDir, outsideDir) => {
      expect(() => render("../outside/secret.svg", assetDir)).toThrow(StudioTreatmentError);
      expect(() => render(join(outsideDir, "secret.svg"), assetDir)).toThrow(/asset directory/);
    });
  });

  it("refuses a symlink inside the directory that points outside it", () => {
    withDirs((assetDir, outsideDir) => {
      symlinkSync(join(outsideDir, "secret.svg"), join(assetDir, "sneaky.svg"));
      expect(() => render("sneaky.svg", assetDir)).toThrow(/asset directory/);
    });
  });
});

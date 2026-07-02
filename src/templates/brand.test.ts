import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadBrand, brandSeriesColors, brandBackground, brandCustomProperties, brandRootCss, type Brand } from "./brand.js";
import { applyBrandDefaults, validateTemplateParams } from "./render.js";
import { lowerThirdTemplate } from "./builtin/lower-third.js";
import { chartTemplate } from "./builtin/chart.js";
import { chatTemplate } from "./builtin/chat.js";
import { subscribeTemplate } from "./builtin/subscribe.js";
import { kineticTextTemplate } from "./builtin/kinetic-text.js";
import { backgroundLoopTemplate } from "./builtin/background-loop.js";
import { deviceMockupTemplate } from "./builtin/device-mockup.js";

const ACME: Brand = {
  palette: { primary: "#2f6df6", accent: "#22d3ee", background: "#0b1020", text: "#e6edf3", muted: "#8b93a7" },
  font: { family: "Inter, sans-serif", weights: [400, 700] },
  radius: 10,
  background: "linear-gradient(135deg,#1e293b,#0f172a)",
};

describe("loadBrand (DM-1530)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "domotion-brand-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses a valid brand file", () => {
    const p = join(dir, "acme.json");
    writeFileSync(p, JSON.stringify({ palette: { primary: "#f00" }, font: { family: "Inter" }, radius: 8 }));
    const brand = loadBrand(p);
    expect(brand.palette?.primary).toBe("#f00");
    expect(brand.font?.family).toBe("Inter");
    expect(brand.radius).toBe(8);
  });

  it("resolves a relative logo against the brand file's directory", () => {
    const p = join(dir, "withlogo.json");
    writeFileSync(p, JSON.stringify({ logo: "acme-logo.svg" }));
    expect(loadBrand(p).logo).toBe(resolve(dir, "acme-logo.svg"));
  });

  it("leaves an absolute logo path and an http(s) URL untouched", () => {
    const abs = join(dir, "abs.json");
    writeFileSync(abs, JSON.stringify({ logo: "/opt/logos/a.svg" }));
    expect(loadBrand(abs).logo).toBe("/opt/logos/a.svg");
    const url = join(dir, "url.json");
    writeFileSync(url, JSON.stringify({ logo: "https://cdn.example.com/a.svg" }));
    expect(loadBrand(url).logo).toBe("https://cdn.example.com/a.svg");
  });

  it("strips unknown top-level keys (forward-compatible)", () => {
    const p = join(dir, "future.json");
    writeFileSync(p, JSON.stringify({ palette: { primary: "#f00" }, futureToken: 123 }));
    const brand = loadBrand(p) as Record<string, unknown>;
    expect(brand.futureToken).toBeUndefined();
    expect((brand.palette as Record<string, unknown>).primary).toBe("#f00");
  });

  it("throws on a missing file, invalid JSON, and a schema violation", () => {
    expect(() => loadBrand(join(dir, "nope.json"))).toThrow(/not found/);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    expect(() => loadBrand(bad)).toThrow(/not valid JSON/);
    const wrong = join(dir, "wrong.json");
    writeFileSync(wrong, JSON.stringify({ palette: { primary: 123 } }));
    expect(() => loadBrand(wrong)).toThrow(/invalid brand file/);
  });
});

describe("brand helpers (DM-1530)", () => {
  it("brandSeriesColors returns [primary, accent] when set, else undefined", () => {
    expect(brandSeriesColors(ACME)).toEqual(["#2f6df6", "#22d3ee"]);
    expect(brandSeriesColors({ palette: { primary: "#f00" } })).toEqual(["#f00"]);
    expect(brandSeriesColors({})).toBeUndefined();
    expect(brandSeriesColors({ palette: { text: "#111" } })).toBeUndefined();
  });

  it("brandBackground prefers top-level background over palette.background", () => {
    expect(brandBackground(ACME)).toBe("linear-gradient(135deg,#1e293b,#0f172a)");
    expect(brandBackground({ palette: { background: "#000" } })).toBe("#000");
    expect(brandBackground({})).toBeUndefined();
  });
});

describe("brandCustomProperties / brandRootCss — capture/animate CSS vars (DM-1540, docs/92)", () => {
  it("maps every set token to its --brand-* variable, radius as px", () => {
    expect(brandCustomProperties(ACME)).toEqual([
      ["--brand-primary", "#2f6df6"],
      ["--brand-accent", "#22d3ee"],
      ["--brand-background", "linear-gradient(135deg,#1e293b,#0f172a)"], // top-level background wins
      ["--brand-text", "#e6edf3"],
      ["--brand-muted", "#8b93a7"],
      ["--brand-font-family", "Inter, sans-serif"],
      ["--brand-radius", "10px"],
    ]);
  });

  it("emits ONLY the tokens the brand actually set (no unset var leaks a fallback)", () => {
    const partial: Brand = { palette: { primary: "#f00" }, radius: 4 };
    expect(brandCustomProperties(partial)).toEqual([
      ["--brand-primary", "#f00"],
      ["--brand-radius", "4px"],
    ]);
    // An empty brand maps to nothing.
    expect(brandCustomProperties({})).toEqual([]);
    // An empty-string value counts as unset (never emitted).
    expect(brandCustomProperties({ palette: { primary: "" } })).toEqual([]);
  });

  it("--brand-background falls back to the flat palette.background when no richer background", () => {
    expect(brandCustomProperties({ palette: { background: "#101317" } })).toEqual([
      ["--brand-background", "#101317"],
    ]);
  });

  it("brandRootCss wraps the pairs in a :root{} block, and is '' when nothing is set", () => {
    expect(brandRootCss({ palette: { primary: "#f00" }, radius: 8 })).toBe(
      ":root{--brand-primary:#f00;--brand-radius:8px;}",
    );
    expect(brandRootCss({})).toBe("");
  });
});

describe("per-template brandDefaults mapping (DM-1530)", () => {
  it("lower-third maps accent/background/font", () => {
    expect(lowerThirdTemplate.brandDefaults!(ACME)).toEqual({
      accent: "#22d3ee",
      background: "linear-gradient(135deg,#1e293b,#0f172a)",
      fontFamily: "Inter, sans-serif",
    });
  });

  it("chart maps text→color, background, font, palette→series colors", () => {
    expect(chartTemplate.brandDefaults!(ACME)).toEqual({
      color: "#e6edf3",
      background: "linear-gradient(135deg,#1e293b,#0f172a)",
      fontFamily: "Inter, sans-serif",
      colors: ["#2f6df6", "#22d3ee"],
    });
  });

  it("chat + subscribe map primary→accent (subscribe also →avatarColor)", () => {
    expect(chatTemplate.brandDefaults!(ACME)).toMatchObject({ accent: "#2f6df6" });
    expect(subscribeTemplate.brandDefaults!(ACME)).toMatchObject({ accent: "#2f6df6", avatarColor: "#2f6df6" });
  });

  it("kinetic-text maps text→color; background-loop maps palette→colors", () => {
    expect(kineticTextTemplate.brandDefaults!(ACME)).toMatchObject({ color: "#e6edf3" });
    expect(backgroundLoopTemplate.brandDefaults!(ACME)).toMatchObject({ colors: ["#2f6df6", "#22d3ee"] });
  });

  it("device-mockup has no brand slot", () => {
    expect(deviceMockupTemplate.brandDefaults).toBeUndefined();
  });

  it("omits tokens the brand didn't set (never shadows a default with undefined)", () => {
    const partial: Brand = { palette: { accent: "#abc" } };
    const d = lowerThirdTemplate.brandDefaults!(partial);
    expect(d).toEqual({ accent: "#abc" }); // no background / fontFamily keys at all
    expect("background" in d).toBe(false);
    expect("fontFamily" in d).toBe(false);
  });
});

describe("brand precedence: explicit > brand > default (DM-1530)", () => {
  it("brand fills what the caller left unset (brand > template default)", () => {
    const merged = applyBrandDefaults(lowerThirdTemplate, { title: "Hi" }, ACME);
    const params = validateTemplateParams(lowerThirdTemplate, merged);
    expect(params.accent).toBe("#22d3ee");                 // from brand, not the #3b82f6 default
    expect(params.fontFamily).toBe("Inter, sans-serif");   // from brand
  });

  it("an explicit param overrides the brand", () => {
    const merged = applyBrandDefaults(lowerThirdTemplate, { title: "Hi", accent: "#ff0000" }, ACME);
    const params = validateTemplateParams(lowerThirdTemplate, merged);
    expect(params.accent).toBe("#ff0000");                 // explicit wins over brand
    expect(params.fontFamily).toBe("Inter, sans-serif");   // brand still fills the unset one
  });

  it("with no brand, the template's own defaults apply", () => {
    const merged = applyBrandDefaults(lowerThirdTemplate, { title: "Hi" }, undefined);
    const params = validateTemplateParams(lowerThirdTemplate, merged);
    expect(params.accent).toBe("#3b82f6");                 // built-in default
  });

  it("palette fills a chart's multi-color series when the caller passes none", () => {
    const merged = applyBrandDefaults(chartTemplate, { data: "1,2,3" }, ACME);
    const params = validateTemplateParams(chartTemplate, merged);
    expect(params.colors).toEqual(["#2f6df6", "#22d3ee"]);
  });

  it("an explicit colors list overrides the brand palette", () => {
    const merged = applyBrandDefaults(chartTemplate, { data: "1,2,3", colors: "#111,#222" }, ACME);
    const params = validateTemplateParams(chartTemplate, merged);
    expect(params.colors).toEqual(["#111", "#222"]);
  });

  it("a template without a brand slot ignores the brand entirely", () => {
    const raw = { input: "/x.html", device: "phone" };
    expect(applyBrandDefaults(deviceMockupTemplate, raw, ACME)).toBe(raw); // untouched
  });
});

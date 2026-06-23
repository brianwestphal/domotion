import { describe, it, expect } from "vitest";
import { isTemplate } from "./types.js";
import {
  listBuiltinTemplates,
  getBuiltinTemplate,
  loadTemplate,
  templatePackageName,
} from "./registry.js";
import { validateTemplateParams } from "./render.js";
import { templateParamsJsonSchema, describeTemplateParams } from "./json-schema.js";
import { lowerThirdTemplate, buildLowerThirdHtml, lowerThirdParamsSchema } from "./builtin/lower-third.js";
import { deviceMockupTemplate } from "./builtin/device-mockup.js";
import {
  backgroundLoopTemplate,
  backgroundLoopParamsSchema,
  planBlobs,
  buildBackgroundHtml,
  buildBackgroundAnimations,
} from "./builtin/background-loop.js";
import {
  kineticTextTemplate,
  kineticTextParamsSchema,
  planUnits,
  buildKineticHtml,
  buildKineticAnimations,
  kineticDurationMs,
} from "./builtin/kinetic-text.js";

describe("template registry (DM-1276)", () => {
  it("lists the built-in templates", () => {
    const names = listBuiltinTemplates().map((t) => t.name).sort();
    expect(names).toEqual(["background-loop", "device-mockup", "kinetic-text", "lower-third"]);
  });

  it("resolves a built-in by name", async () => {
    expect(getBuiltinTemplate("lower-third")).toBe(lowerThirdTemplate);
    expect(await loadTemplate("device-mockup")).toBe(deviceMockupTemplate);
  });

  it("maps a template name to its npm package convention", () => {
    expect(templatePackageName("kinetic")).toBe("domotion-template-kinetic");
  });

  it("errors helpfully for an unknown template (no such built-in or npm package)", async () => {
    await expect(loadTemplate("does-not-exist-xyz")).rejects.toThrow(
      /unknown template "does-not-exist-xyz".*npm install domotion-template-does-not-exist-xyz/s,
    );
  });

  it("the built-ins all satisfy the Template shape guard", () => {
    for (const t of listBuiltinTemplates()) expect(isTemplate(t)).toBe(true);
  });

  it("isTemplate rejects non-templates", () => {
    expect(isTemplate(null)).toBe(false);
    expect(isTemplate({})).toBe(false);
    expect(isTemplate({ name: "x", description: "y", paramsSchema: {}, render: () => {} })).toBe(false); // bad schema
  });
});

describe("param validation + JSON-Schema projection", () => {
  it("validateTemplateParams applies defaults and coerces numeric strings", () => {
    const p = validateTemplateParams(lowerThirdTemplate, { title: "Hi", width: "1920" });
    expect(p.title).toBe("Hi");
    expect(p.width).toBe(1920); // coerced from the CLI string flag
    expect(p.theme).toBe("dark"); // default applied
    expect(p.accent).toBe("#3b82f6");
  });

  it("validateTemplateParams throws a path-specific error on a bad param", () => {
    expect(() => validateTemplateParams(lowerThirdTemplate, {})).toThrow(/template "lower-third": invalid params.*title/s);
    expect(() => validateTemplateParams(lowerThirdTemplate, { title: "x", theme: "purple" })).toThrow(/theme/);
  });

  it("templateParamsJsonSchema projects to an object schema with the params as properties", () => {
    const js = templateParamsJsonSchema(lowerThirdTemplate);
    const props = js.properties as Record<string, unknown>;
    expect(props).toHaveProperty("title");
    expect(props).toHaveProperty("width");
    expect(js.required).toContain("title");
  });

  it("describeTemplateParams flags required/kind/enum/defaults", () => {
    const params = describeTemplateParams(lowerThirdTemplate);
    const by = (n: string) => params.find((p) => p.name === n)!;
    expect(by("title").required).toBe(true);
    expect(by("width").kind).toBe("number");
    expect(by("theme").enumValues).toEqual(["dark", "light"]);
    expect(by("accent").default).toBe("#3b82f6");
    // device-mockup's boolean param is detected as a presence flag.
    expect(describeTemplateParams(deviceMockupTemplate).find((p) => p.name === "mobile")!.kind).toBe("boolean");
  });
});

describe("lower-third HTML generation (pure, no browser)", () => {
  it("embeds the title, subtitle, and accent color", () => {
    const html = buildLowerThirdHtml(lowerThirdParamsSchema.parse({ title: "Jane Doe", subtitle: "CEO", accent: "#ff0000" }));
    expect(html).toContain("Jane Doe");
    expect(html).toContain("CEO");
    expect(html).toContain("#ff0000");
    expect(html).toMatch(/class="lt-sub"/);
  });

  it("omits the subtitle element when no subtitle is given", () => {
    const html = buildLowerThirdHtml(lowerThirdParamsSchema.parse({ title: "Solo" }));
    expect(html).toContain("Solo");
    expect(html).not.toMatch(/class="lt-sub"/);
  });

  it("escapes HTML-special characters in the text", () => {
    const html = buildLowerThirdHtml(lowerThirdParamsSchema.parse({ title: "A <b> & \"c\"" }));
    expect(html).toContain("A &lt;b&gt; &amp; &quot;c&quot;");
    expect(html).not.toContain("<b>");
  });

  it("anchors to the chosen corner via flex alignment", () => {
    const bottomRight = buildLowerThirdHtml(lowerThirdParamsSchema.parse({ title: "x", position: "bottom-right" }));
    expect(bottomRight).toMatch(/justify-content: flex-end/);
    expect(bottomRight).toMatch(/align-items: flex-end/);
    const topCenter = buildLowerThirdHtml(lowerThirdParamsSchema.parse({ title: "x", position: "top-center" }));
    expect(topCenter).toMatch(/justify-content: center/);
    expect(topCenter).toMatch(/align-items: flex-start/);
  });
});

describe("background-loop generation (pure, no browser) — DM-1280", () => {
  const parse = (o: Record<string, unknown>) => backgroundLoopParamsSchema.parse(o);

  it("plans exactly `count` blobs, cycling the colors", () => {
    const blobs = planBlobs(parse({ count: 4, colors: ["#a", "#b"] }));
    expect(blobs).toHaveLength(4);
    expect(blobs.map((b) => b.color)).toEqual(["#a", "#b", "#a", "#b"]);
  });

  it("is deterministic for a given seed and varies with the seed", () => {
    const a1 = planBlobs(parse({ seed: 7 }));
    const a2 = planBlobs(parse({ seed: 7 }));
    const b = planBlobs(parse({ seed: 8 }));
    expect(a1).toEqual(a2); // same seed ⇒ identical layout
    expect(a1).not.toEqual(b); // different seed ⇒ different layout
  });

  it("emits a base fill, a radial-gradient blob per item, and a pos/blob wrapper pair", () => {
    const p = parse({ count: 3, background: "#010203" });
    const html = buildBackgroundHtml(p, planBlobs(p));
    expect(html).toContain("background: #010203");
    expect(html.match(/radial-gradient/g) ?? []).toHaveLength(3);
    expect(html).toMatch(/class="bg-pos bg-pos-0"/);
    expect(html).toMatch(/class="bg-blob bg-blob-0"/);
  });

  it("builds two looping animations per blob on distinct selectors (drift + breathe)", () => {
    const p = parse({ count: 2 });
    const anims = buildBackgroundAnimations(planBlobs(p));
    expect(anims).toHaveLength(4); // 2 blobs × (drift + breathe)
    const drift = anims.find((a) => a.selector === ".bg-pos-0")!;
    const breathe = anims.find((a) => a.selector === ".bg-blob-0")!;
    expect(drift.property).toBe("transform"); // origin-safe translate
    expect(drift.from).toBe("translate(0px, 0px)");
    expect(drift.repeat).toBe("infinite");
    expect(drift.alternate).toBe(true);
    expect(breathe.property).toBe("opacity");
    expect(breathe.repeat).toBe("infinite");
    expect(breathe.alternate).toBe(true);
    // The two animations target DIFFERENT selectors so neither overrides the other.
    expect(drift.selector).not.toBe(breathe.selector);
  });

  it("orbs blobs are smaller and more opaque than aurora blobs", () => {
    const aurora = planBlobs(parse({ variant: "aurora", seed: 3 }));
    const orbs = planBlobs(parse({ variant: "orbs", seed: 3 }));
    expect(orbs[0].size).toBeLessThan(aurora[0].size);
    expect(orbs[0].opacityHigh).toBeGreaterThan(aurora[0].opacityHigh);
  });

  it("the template is registered and validates params", () => {
    expect(backgroundLoopTemplate.name).toBe("background-loop");
    expect(() => parse({ count: 99 })).toThrow(); // max 24
  });
});

describe("kinetic-text generation (pure, no browser) — DM-1277", () => {
  const parse = (o: Record<string, unknown>) => kineticTextParamsSchema.parse(o);

  it("splits into one unit per word (word mode), assigning sequential indices", () => {
    const plan = planUnits(parse({ text: "Ship it now" }));
    expect(plan.count).toBe(3);
    expect(plan.words.map((w) => w.map((u) => u.text))).toEqual([["Ship"], ["it"], ["now"]]);
    expect(plan.words.flat().map((u) => u.index)).toEqual([0, 1, 2]);
  });

  it("splits into one unit per character (char mode), indexing across words", () => {
    const plan = planUnits(parse({ text: "Hi yo", by: "char" }));
    expect(plan.count).toBe(4); // H,i,y,o (space is a word boundary, not a unit)
    expect(plan.words.map((w) => w.map((u) => u.text))).toEqual([["H", "i"], ["y", "o"]]);
    expect(plan.words.flat().map((u) => u.index)).toEqual([0, 1, 2, 3]);
  });

  it("collapses extra whitespace and ignores empty tokens", () => {
    expect(planUnits(parse({ text: "  a   b  " })).count).toBe(2);
  });

  it("emits a wrapper+inner span pair per unit and escapes the text", () => {
    const p = parse({ text: "A <b>" });
    const html = buildKineticHtml(p, planUnits(p));
    expect(html).toMatch(/class="kt-w kt-w-0"/);
    expect(html).toMatch(/class="kt-wi kt-wi-0"/);
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
  });

  it("char mode wraps each word in a nowrap group so words don't break mid-word", () => {
    const p = parse({ text: "Go", by: "char" });
    const html = buildKineticHtml(p, planUnits(p));
    expect(html).toMatch(/class="kt-word"/);
  });

  it("rise adds a translateY on the wrapper + opacity on the inner (two selectors)", () => {
    const p = parse({ text: "Hi", variant: "rise" });
    const anims = buildKineticAnimations(p, planUnits(p));
    const fade = anims.find((a) => a.selector === ".kt-wi-0")!;
    const move = anims.find((a) => a.selector === ".kt-w-0")!;
    expect(fade.property).toBe("opacity");
    expect(move.property).toBe("translateY");
    expect(move.repeat).toBeUndefined(); // one-shot reveal, not a loop
  });

  it("slide uses translateX; fade has no transform animation (opacity only)", () => {
    const slide = buildKineticAnimations(parse({ text: "Hi", variant: "slide" }), planUnits(parse({ text: "Hi" })));
    expect(slide.some((a) => a.property === "translateX")).toBe(true);
    const fade = buildKineticAnimations(parse({ text: "Hi there", variant: "fade" }), planUnits(parse({ text: "Hi there" })));
    expect(fade.every((a) => a.property === "opacity")).toBe(true);
    expect(fade).toHaveLength(2); // 2 words, opacity-only
  });

  it("staggers each unit by staggerMs and sizes the duration to reveal-end + hold", () => {
    const p = parse({ text: "a b c", staggerMs: 100, revealMs: 500, holdMs: 1000 });
    const plan = planUnits(p);
    const anims = buildKineticAnimations(p, plan);
    expect(anims.find((a) => a.selector === ".kt-wi-2")!.delay).toBe(200); // 3rd unit
    expect(kineticDurationMs(p, plan.count)).toBe(200 + 500 + 1000); // last start + reveal + hold
  });

  it("the template is registered and rejects empty / overlong text", () => {
    expect(kineticTextTemplate.name).toBe("kinetic-text");
    expect(() => parse({ text: "" })).toThrow();
    expect(() => parse({ text: "x".repeat(201) })).toThrow();
  });
});

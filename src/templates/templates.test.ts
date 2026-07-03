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
  buildGradientPanHtml,
  buildGradientPanAnimations,
  planGridDots,
  buildGridHtml,
  buildGridAnimations,
  planStars,
  buildStarsHtml,
  buildStarsAnimations,
  planWaves,
  buildWaveHtml,
  buildWaveAnimations,
} from "./builtin/background-loop.js";
import {
  kineticTextTemplate,
  kineticTextParamsSchema,
  planUnits,
  buildKineticHtml,
  buildKineticAnimations,
  kineticDurationMs,
  parseStyledText,
  unitText,
  type KineticUnit,
} from "./builtin/kinetic-text.js";
import {
  chartTemplate,
  chartParamsSchema,
  planChart,
  buildChartHtml,
  buildChartAnimations,
  chartDurationMs,
} from "./builtin/chart.js";
import {
  chatTemplate,
  chatParamsSchema,
  buildChatHtml,
  buildChatAnimations,
  chatDurationMs,
  chatTimeline,
} from "./builtin/chat.js";
import {
  subscribeTemplate,
  subscribeParamsSchema,
  buildSubscribeHtml,
  buildSubscribeAnimations,
  subscribeDurationMs,
} from "./builtin/subscribe.js";

/** All units of a plan, flattened across lines, in index order. */
const allUnits = (plan: { lines: KineticUnit[][][] }): KineticUnit[] =>
  plan.lines.flat(2);

describe("template registry (DM-1276)", () => {
  it("lists the built-in templates", () => {
    const names = listBuiltinTemplates().map((t) => t.name).sort();
    expect(names).toEqual([
      "background-loop", "caption", "chart", "chat", "compare", "counter", "cta", "device-mockup",
      "kinetic-text", "lower-third", "quote", "stat", "subscribe", "title-card",
    ]);
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

  it("embeds a brand logo when given, and omits the mark otherwise (DM-1545)", () => {
    const withLogo = buildLowerThirdHtml(lowerThirdParamsSchema.parse({ title: "Acme", logo: "/opt/logos/acme.svg" }));
    expect(withLogo).toMatch(/<img class="lt-logo" src="\/opt\/logos\/acme\.svg"/);
    const withoutLogo = buildLowerThirdHtml(lowerThirdParamsSchema.parse({ title: "Acme" }));
    expect(withoutLogo).not.toContain("<img");
  });

  it("DM-1576: logoPosition places the mark on the panel (default) or a frame corner", () => {
    const panel = buildLowerThirdHtml(lowerThirdParamsSchema.parse({ title: "Acme", logo: "/l.svg" }));
    expect(panel).toMatch(/<img class="lt-logo" src="\/l\.svg"/); // on-panel
    expect(panel).not.toContain("lt-logo-corner");
    expect(panel).not.toContain("position: relative"); // byte-identical default

    const tr = buildLowerThirdHtml(lowerThirdParamsSchema.parse({ title: "Acme", logo: "/l.svg", logoPosition: "top-right" }));
    expect(tr).not.toMatch(/class="lt-logo"/);          // NOT on the panel
    expect(tr).toMatch(/lt-logo-corner[^>]*right:48px/); // absolute, top-right at the inset
    expect(tr).toContain("position: relative");          // body positioned for the absolute mark

    const tl = buildLowerThirdHtml(lowerThirdParamsSchema.parse({ title: "Acme", logo: "/l.svg", logoPosition: "top-left" }));
    expect(tl).toMatch(/lt-logo-corner[^>]*left:48px/);
  });

  it("escapes a logo URL's HTML-special characters (DM-1545)", () => {
    const html = buildLowerThirdHtml(lowerThirdParamsSchema.parse({ title: "x", logo: 'a"b.svg' }));
    expect(html).toContain('src="a&quot;b.svg"');
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
    // DM-1289: delays are NEGATIVE phase offsets (start the loop mid-cycle), not
    // positive waits — a positive delay freezes the blob at `from` then snaps.
    for (const a of anims) {
      expect(a.delay).toBeLessThanOrEqual(0);
      expect(Math.abs(a.delay ?? 0)).toBeLessThanOrEqual(a.duration);
    }
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

  // DM-1285: comma-separated `colors` convenience flag.
  it("accepts `colors` as a comma-separated string (the --colors flag)", () => {
    const p = parse({ colors: "#abc, #def ,#123" });
    expect(p.colors).toEqual(["#abc", "#def", "#123"]); // split + trimmed
    expect(parse({ colors: ["#x", "#y"] }).colors).toEqual(["#x", "#y"]); // array still works
    expect(() => parse({ colors: "" })).toThrow(); // empty → no colors → min(1) fails
  });

  // DM-1298: "stars" — a dense field of sharp points that twinkle (opacity) +
  // sparkle (center-origin scale). `count` is a density level (×16).
  it("stars plans ~16× the count of sharp twinkling points", () => {
    const stars = planStars(parse({ variant: "stars", count: 5, seed: 3 }));
    expect(stars).toHaveLength(80); // 5 × 16
    const html = buildStarsHtml(parse({ variant: "stars", count: 1, colors: ["#abc"] }), planStars(parse({ variant: "stars", count: 1, colors: ["#abc"] })));
    expect(html).toContain("radial-gradient(circle, #ffffff 0%"); // white-hot core
    const anims = buildStarsAnimations(stars);
    expect(anims).toHaveLength(160); // 80 stars × (scale sparkle + opacity twinkle)
    const spark = anims.find((a) => a.selector === ".st-pos-0")!;
    const twinkle = anims.find((a) => a.selector === ".st-star-0")!;
    expect(spark.property).toBe("scale");
    expect(spark.transformOrigin).toBe("center"); // sparkle about the star's center
    expect(twinkle.property).toBe("opacity");
    for (const a of anims) {
      expect(a.repeat).toBe("infinite");
      expect(a.alternate).toBe(true);
      expect(a.duration).toBeLessThanOrEqual(3300); // fast twinkle, not the slow loop period
    }
  });

  // DM-1298: gradient-pan pans CONTINUOUSLY in one direction (no `alternate`),
  // a repeating gradient translated by exactly one period.
  it("gradient-pan pans continuously by one period (linear, no alternate)", () => {
    const p = parse({ variant: "gradient-pan", colors: ["#111", "#222", "#333"], width: 800, height: 450 });
    const html = buildGradientPanHtml(p);
    expect(html).toContain("repeating-linear-gradient(60deg");
    const anims = buildGradientPanAnimations(p);
    expect(anims).toHaveLength(1);
    expect(anims[0].property).toBe("transform");
    expect(anims[0].easing).toBe("linear");
    expect(anims[0].alternate).toBeUndefined(); // continuous, never backs out
    expect(anims[0].to).toMatch(/^translate\(-\d+px, 0px\)$/);
  });

  // DM-1285/DM-1298: grid drifts CONTINUOUSLY by one cell (no alternate, linear).
  it("grid is one inline <svg> of circles covering a cell beyond every edge, drifting one cell continuously", () => {
    const p = parse({ variant: "grid", width: 800, height: 450, colors: ["#a", "#b"] });
    const grid = planGridDots(p);
    // The layer extends one cell past each edge (so margin dots slide in), in its
    // own (svg-local) coords from 0.
    expect(grid.layerW).toBe(p.width + grid.cell * 2);
    expect(grid.layerH).toBe(p.height + grid.cell * 2);
    expect(grid.dots[0]).toMatchObject({ cx: 0, cy: 0 });
    expect(grid.dots.some((d) => d.cx >= p.width + grid.cell)).toBe(true);

    // DM-1299: a single inline <svg> of <circle>s (offset -cell), NOT individual
    // <div>s — so the off-canvas margin dots survive capture instead of being
    // culled (which left an empty top-left margin as the grid drifted down-right).
    const html = buildGridHtml(p, grid);
    expect(html).toMatch(/class="gd-layer"/);
    expect(html).toContain("<svg");
    expect(html).toContain("<circle");
    expect(html).toContain(`left: -${grid.cell}px`);

    const anims = buildGridAnimations(p, grid.cell);
    expect(anims).toHaveLength(1);
    expect(anims[0].to).toBe(`translate(${grid.cell}px, ${grid.cell}px)`);
    expect(anims[0].easing).toBe("linear");
    expect(anims[0].alternate).toBeUndefined(); // continuous one-direction drift
  });

  // DM-1299: grid colours are diagonal, so a dot and its down-right neighbour
  // share a colour — invariant under the one-cell drift, so the loop seam doesn't
  // flicker (a dot sliding in carries the colour of the dot it replaces).
  it("grid colours are invariant under the one-cell diagonal shift (no seam flicker)", () => {
    const p = parse({ variant: "grid", width: 800, height: 450, colors: ["#a", "#b", "#c"] });
    const { dots, cell } = planGridDots(p);
    const colorAt = (col: number, row: number) =>
      dots.find((d) => d.cx === col * cell && d.cy === row * cell)?.color;
    // Down-right diagonal neighbours share a colour (the shift maps each onto the next).
    expect(colorAt(1, 1)).toBe(colorAt(2, 2));
    expect(colorAt(2, 1)).toBe(colorAt(3, 2));
    // Still multi-colour: neighbours along a row differ.
    expect(colorAt(1, 1)).not.toBe(colorAt(2, 1));
  });

  // DM-1295/DM-1298: wave — layered sine-wave fills panning at parallax speeds.
  it("wave plans `count` sine-wave layers that pan one canvas width at different speeds", () => {
    const p = parse({ variant: "wave", width: 800, height: 450, count: 4, colors: ["#a", "#b"] });
    const layers = planWaves(p);
    expect(layers).toHaveLength(4);
    expect(layers.map((l) => l.color)).toEqual(["#a", "#b", "#a", "#b"]); // colors cycle
    for (const l of layers) expect(l.path).toMatch(/^M [\d.]+ [\d.]+ (L [\d.]+ [\d.]+ )+L 1600 450 L 0 450 Z$/);
    // Front layers are more opaque than back layers (depth).
    expect(layers[layers.length - 1].opacity).toBeGreaterThan(layers[0].opacity);
    // Parallax: the layer speeds (drift durations) are not all equal.
    expect(new Set(layers.map((l) => l.driftMs)).size).toBeGreaterThan(1);

    const html = buildWaveHtml(p, layers);
    expect(html).toMatch(/class="wv-layer wv-layer-0"/);
    expect(html).toContain("<svg"); // inline SVG wave paths
    const anims = buildWaveAnimations(p, layers);
    expect(anims).toHaveLength(4); // one continuous pan per layer
    for (const a of anims) {
      expect(a.property).toBe("transform");
      expect(a.to).toBe(`translate(-${p.width}px, 0px)`); // exactly one canvas width
      expect(a.easing).toBe("linear");
      expect(a.alternate).toBeUndefined();
    }
  });

  it("wave is deterministic per seed", () => {
    const mk = (seed: number) => planWaves(parse({ variant: "wave", seed }));
    expect(mk(3)).toEqual(mk(3));
    expect(mk(3)).not.toEqual(mk(4));
  });
});

describe("kinetic-text generation (pure, no browser) — DM-1277", () => {
  const parse = (o: Record<string, unknown>) => kineticTextParamsSchema.parse(o);

  it("splits into one unit per word (word mode), assigning sequential indices", () => {
    const plan = planUnits(parse({ text: "Ship it now" }));
    expect(plan.count).toBe(3);
    expect(plan.lines[0].map((w) => w.map(unitText))).toEqual([["Ship"], ["it"], ["now"]]);
    expect(allUnits(plan).map((u) => u.index)).toEqual([0, 1, 2]);
  });

  it("splits into one unit per character (char mode), indexing across words", () => {
    const plan = planUnits(parse({ text: "Hi yo", by: "char" }));
    expect(plan.count).toBe(4); // H,i,y,o (space is a word boundary, not a unit)
    expect(plan.lines[0].map((w) => w.map(unitText))).toEqual([["H", "i"], ["y", "o"]]);
    expect(allUnits(plan).map((u) => u.index)).toEqual([0, 1, 2, 3]);
  });

  it("collapses extra whitespace and ignores empty tokens", () => {
    expect(planUnits(parse({ text: "  a   b  " })).count).toBe(2);
  });

  it("emits a wrapper+inner span pair per unit and escapes literal text", () => {
    // `<` not forming a tag, and `&`, are literal characters (escaped); they are
    // NOT the emphasis tags, which are consumed (covered below).
    const p = parse({ text: "5 < 10 & up" });
    const html = buildKineticHtml(p, planUnits(p));
    expect(html).toMatch(/class="kt-w kt-w-0"/);
    expect(html).toMatch(/class="kt-wi kt-wi-0"/);
    expect(html).toContain("&lt;");
    expect(html).toContain("&amp;");
  });

  it("char mode wraps each word in a nowrap group so words don't break mid-word", () => {
    const p = parse({ text: "Go", by: "char" });
    const html = buildKineticHtml(p, planUnits(p));
    expect(html).toMatch(/class="kt-word"/);
  });

  it("rise fuses the fade into ONE translateY animation on the wrapper (DM-1512/1513)", () => {
    const p = parse({ text: "Hi", variant: "rise" });
    const anims = buildKineticAnimations(p, planUnits(p));
    // No separate opacity animation on the inner span — the fade is fused into
    // the move so they're one CSS timeline (can't desync under Firefox OMTA).
    expect(anims.some((a) => a.selector === ".kt-wi-0")).toBe(false);
    const move = anims.find((a) => a.selector === ".kt-w-0")!;
    expect(move.property).toBe("translateY");
    expect(move.repeat).toBeUndefined(); // one-shot reveal, not a loop
    expect(move.fuse).toEqual([{ property: "opacity", from: "0", to: "1" }]);
  });

  it("slide uses translateX; fade has no transform animation (opacity only)", () => {
    const slide = buildKineticAnimations(parse({ text: "Hi", variant: "slide" }), planUnits(parse({ text: "Hi" })));
    expect(slide.some((a) => a.property === "translateX")).toBe(true);
    const fade = buildKineticAnimations(parse({ text: "Hi there", variant: "fade" }), planUnits(parse({ text: "Hi there" })));
    expect(fade.every((a) => a.property === "opacity")).toBe(true);
    expect(fade).toHaveLength(2); // 2 words, opacity-only
  });

  // DM-1286: clip variant — a left-to-right wipe via the clipPath property.
  it("clip wipes the wrapper via clipPath inset (100% → 0% right inset)", () => {
    const p = parse({ text: "Hi", variant: "clip" });
    const anims = buildKineticAnimations(p, planUnits(p));
    const wipe = anims.find((a) => a.selector === ".kt-w-0" && a.property === "clipPath")!;
    expect(wipe).toBeDefined();
    expect(wipe.from).toMatch(/100%/); // fully clipped from the right
    expect(wipe.to).toMatch(/0%/);     // fully revealed
    expect(wipe.repeat).toBeUndefined(); // one-shot
    // The fade is fused into the wipe (not a separate inner opacity animation).
    expect(anims.some((a) => a.selector === ".kt-wi-0")).toBe(false);
    expect(wipe.fuse).toEqual([{ property: "opacity", from: "0", to: "1" }]);
  });

  // DM-1297: pop variant — a center-origin scale-up (needs transformOrigin so the
  // SVG scale resolves about the unit's own box, not the canvas origin).
  it("pop scales the wrapper from small to full about its own center", () => {
    const p = parse({ text: "Hi", variant: "pop" });
    const anims = buildKineticAnimations(p, planUnits(p));
    const scale = anims.find((a) => a.selector === ".kt-w-0" && a.property === "scale")!;
    expect(scale).toBeDefined();
    expect(scale.from).toBe("0.3");
    expect(scale.to).toBe("1");
    expect(scale.transformOrigin).toBe("center"); // the key — center-origin scale
  });

  it("staggers each unit by staggerMs and sizes the duration to reveal-end + hold", () => {
    const p = parse({ text: "a b c", staggerMs: 100, revealMs: 500, holdMs: 1000 });
    const plan = planUnits(p);
    const anims = buildKineticAnimations(p, plan);
    expect(anims.find((a) => a.selector === ".kt-w-2")!.delay).toBe(200); // 3rd unit
    expect(kineticDurationMs(p, plan.count)).toBe(200 + 500 + 1000); // last start + reveal + hold
  });

  // DM-1286: multi-line via `\n` (literal backslash-n OR an actual newline).
  it("splits the headline into lines on \\n, indexing units across lines", () => {
    const plan = planUnits(parse({ text: "one two\\nthree" }));
    expect(plan.lines).toHaveLength(2);
    expect(plan.lines[0].map((w) => w.map(unitText))).toEqual([["one"], ["two"]]);
    expect(plan.lines[1].map((w) => w.map(unitText))).toEqual([["three"]]);
    expect(plan.count).toBe(3); // global indices continue across the line break
    const html = buildKineticHtml(parse({ text: "a\\nb" }), planUnits(parse({ text: "a\\nb" })));
    expect((html.match(/class="kt-line"/g) ?? [])).toHaveLength(2);
  });

  // DM-1286: light inline-markup emphasis.
  it("parses the emphasis safelist into inline styles and drops unknown tags", () => {
    const lines = parseStyledText('a <b>B</b> <i>c</i> <font color="#f00">d</font> <x>e</x>');
    const flat = lines[0].map((sc) => sc.ch + "|" + sc.style).join(" ");
    expect(flat).toContain("B|font-weight:900");
    expect(flat).toContain("c|font-style:italic");
    expect(flat).toContain("d|color:#f00");
    // The unknown <x> tag is dropped; its text content "e" survives unstyled.
    expect(lines[0].some((sc) => sc.ch === "e" && sc.style === "")).toBe(true);
    expect(lines[0].some((sc) => sc.ch === "<")).toBe(false); // the tag chars are consumed
  });

  it("groups a word's mixed styles into segments and sanitizes a font color", () => {
    const p = parse({ text: '<b>Bo<font color="red;}#evil">ld</font></b>' });
    const u = planUnits(p).lines[0][0][0]; // single word, one unit
    expect(unitText(u)).toBe("Bold");
    expect(u.segments).toHaveLength(2); // "Bo" (bold) then "ld" (bold + color)
    expect(u.segments[0].style).toBe("font-weight:900");
    // `;` and `}` are stripped from the color so it can't break out of the style attr.
    expect(u.segments[1].style).toBe("font-weight:900;color:red#evil");
    expect(u.segments[1].style).not.toMatch(/[;]\s*}/);
  });

  // DM-1286: boomerang loop mode → reveal animations repeat with alternate.
  it("boomerang makes the reveal animations repeat infinitely with alternate", () => {
    const loop = buildKineticAnimations(parse({ text: "Hi", loop: "loop" }), planUnits(parse({ text: "Hi" })));
    expect(loop.every((a) => a.repeat == null)).toBe(true); // default: one-shot

    const boom = buildKineticAnimations(parse({ text: "Hi", loop: "boomerang" }), planUnits(parse({ text: "Hi", loop: "boomerang" })));
    expect(boom.every((a) => a.repeat === "infinite" && a.alternate === true)).toBe(true);
    // Boomerang's play time frames an assemble + disassemble cycle (no hold).
    const p = parse({ text: "a b", loop: "boomerang", staggerMs: 100, revealMs: 500, holdMs: 9999 });
    expect(kineticDurationMs(p, planUnits(p).count)).toBe(100 + 500 * 2);
  });

  it("the template is registered and rejects empty / overlong text", () => {
    expect(kineticTextTemplate.name).toBe("kinetic-text");
    expect(() => parse({ text: "" })).toThrow();
    expect(() => parse({ text: "x".repeat(401) })).toThrow();
  });
});

describe("chart generation (pure, no browser) — DM-1279", () => {
  const parse = (o: Record<string, unknown>) => chartParamsSchema.parse(o);

  it("normalizes data to series: number[] → one series, string and 2D → multi (DM-1301)", () => {
    expect(parse({ data: "10, 20 ,30" }).data).toEqual([[10, 20, 30]]);       // single series
    expect(parse({ data: "1,2,3;4,5,6" }).data).toEqual([[1, 2, 3], [4, 5, 6]]); // ; splits series
    expect(parse({ data: [1, 2] }).data).toEqual([[1, 2]]);                    // number[] wrapped
    expect(parse({ data: [[1, 2], [3, 4]] }).data).toEqual([[1, 2], [3, 4]]);  // 2D as-is
    expect(parse({ data: [1, 2], labels: "a,b" }).labels).toEqual(["a", "b"]);
    expect(() => parse({ data: "x,y" })).toThrow(); // non-numeric → filtered → min(1) fails
  });

  it("column bars are sized to the data over a nice axis max, anchored at the baseline", () => {
    const p = parse({ type: "column", data: [50, 100], width: 1000, height: 600 });
    const plan = planChart(p);
    expect(plan.maxVal).toBe(100); // niceMax(100)
    expect(plan.bars).toHaveLength(2);
    // taller datum → taller bar; bar bottoms sit on the baseline.
    expect(plan.bars[1].height).toBeGreaterThan(plan.bars[0].height);
    for (const b of plan.bars) expect(b.top + b.height).toBe(plan.plot.y + plan.plot.h);
    expect(plan.bars[1].height).toBe(plan.plot.h); // 100/100 of the plot height
  });

  it("grows columns with scaleY from the bottom and bars with scaleX from the left (transform + origin)", () => {
    const col = buildChartAnimations(parse({ type: "column", data: [3, 7] }), planChart(parse({ type: "column", data: [3, 7] })));
    const g = col.find((a) => a.selector === ".ch-bar-0")!;
    expect(g.property).toBe("transform");
    expect(g.from).toBe("scaleY(0)");
    expect(g.transformOrigin).toBe("bottom");

    const bar = buildChartAnimations(parse({ type: "bar", data: [3, 7] }), planChart(parse({ type: "bar", data: [3, 7] })));
    expect(bar.find((a) => a.selector === ".ch-bar-0")!.from).toBe("scaleX(0)");
    expect(bar.find((a) => a.selector === ".ch-bar-0")!.transformOrigin).toBe("left");
  });

  it("line draws in via a clipPath wipe per series, with dots popping", () => {
    const p = parse({ type: "line", data: [4, 8, 6, 12] });
    const plan = planChart(p);
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0].dots).toHaveLength(4);
    const html = buildChartHtml(p, plan);
    expect(html).toContain("<polyline");
    expect(html).toMatch(/ch-reveal-0/);
    const anims = buildChartAnimations(p, plan);
    const reveal = anims.find((a) => a.selector === ".ch-reveal-0")!;
    expect(reveal.property).toBe("clipPath");
    expect(reveal.from).toMatch(/100%/);
    expect(anims.some((a) => a.selector === ".ch-dot-0-0" && a.property === "scale")).toBe(true);
  });

  it("renders the title, gridlines + value-axis ticks, value labels, and category labels", () => {
    const p = parse({ type: "column", data: [5, 9], labels: ["A", "B"], title: "Sales", yTicks: 4 });
    const html = buildChartHtml(p, planChart(p));
    expect(html).toContain("Sales");
    expect(html).toMatch(/class="ch-grid"/);            // gridlines
    expect(html).toMatch(/class="ch-tick"/);            // axis tick labels
    expect(html).toMatch(/class="ch-val ch-val-0"/);
    expect(html).toContain(">A<");
    expect(html).toContain(">B<");
  });

  // DM-1560: adaptive per-ratio type + bar-thickness scaling.
  it("scales the title / tick / value / category type by the format scale factor (sf), no-op at sf=1", () => {
    const p = parse({ type: "column", data: [5, 9], labels: ["A", "B"], title: "Sales", yTicks: 4 });
    const plan = planChart(p);
    // sf === 1 (the no-format default) leaves every authored size at its px.
    const base = buildChartHtml(p, plan);
    expect(base).toContain(".ch-title { position: absolute; left: 40px; top: 22px; font-size: 30px");
    expect(base).toContain(".ch-tick { position: absolute; font-size: 15px");
    expect(base).toContain(".ch-val { position: absolute; font-size: 19px");
    expect(base).toContain(".ch-cat { position: absolute; font-size: 17px");
    // Passing sf===1 explicitly is byte-identical to the default.
    expect(buildChartHtml(p, plan, undefined, 1)).toBe(base);
    // sf = 1.5 scales each font-size (round): 30→45, 15→23, 19→29, 17→26, 17(legend)→26.
    const scaled = buildChartHtml(p, plan, undefined, 1.5);
    expect(scaled).toContain("font-size: 45px");  // title 30 · 1.5
    expect(scaled).toContain("font-size: 23px");  // tick 15 · 1.5 = 22.5 → 23
    expect(scaled).toContain("font-size: 29px");  // value 19 · 1.5 = 28.5 → 29
    expect(scaled).toContain("font-size: 26px");  // category 17 · 1.5 = 25.5 → 26
    expect(scaled).not.toContain("font-size: 30px"); // the authored title size is gone
  });

  it("scales the single-series bar-thickness cap by sf (byte-identical at sf=1)", () => {
    // A wide plot + few categories hits the absolute cap (130px column / 90 bar).
    const p = parse({ type: "column", data: [10, 20], width: 1000, height: 600 });
    const capped = planChart(p);               // sf defaults to 1
    expect(capped.bars.every((b) => b.width === 130)).toBe(true);
    // sf = 2 doubles the cap → 260px bars (still ≤ slot·0.7, so the cap governs).
    const scaled = planChart(p, 2);
    expect(scaled.bars.every((b) => b.width === 260)).toBe(true);
    // planChart(p, 1) equals planChart(p) — the sf default is a true no-op.
    expect(planChart(p, 1)).toEqual(capped);
  });

  // DM-1301: multi-series.
  it("grouped multi-series lays one bar per (category, series), colored per series, with a legend", () => {
    const p = parse({ type: "column", data: [[10, 20], [30, 40]], labels: ["P", "Q"], seriesNames: ["A", "B"], layout: "grouped", colors: ["#aaa", "#bbb"] });
    const plan = planChart(p);
    expect(plan.stacked).toBe(false);
    expect(plan.bars).toHaveLength(4); // 2 categories × 2 series
    expect(plan.legend).toEqual([{ name: "A", color: "#aaa" }, { name: "B", color: "#bbb" }]);
    expect(new Set(plan.bars.map((b) => b.color))).toEqual(new Set(["#aaa", "#bbb"])); // per-series color
    expect(buildChartHtml(p, plan)).toMatch(/class="ch-legend"/);
  });

  it("stacked multi-series sums per category for the axis max and grows each stack as one unit", () => {
    const p = parse({ type: "column", data: [[10, 20], [30, 40]], layout: "stacked" });
    const plan = planChart(p);
    expect(plan.stacked).toBe(true);
    expect(plan.maxVal).toBe(niceMaxOf(70)); // category Q total = 30+40 = 70 is the peak
    expect(plan.stacks).toHaveLength(2);
    expect(plan.stacks[0].segments).toHaveLength(2);
    const anims = buildChartAnimations(p, plan);
    const grow = anims.find((a) => a.selector === ".ch-stack-0")!;
    expect(grow.property).toBe("transform");
    expect(grow.from).toBe("scaleY(0)"); // whole stack scales up together
  });

  // DM-1300: pie / donut.
  it("pie lays one arc-path slice per value with a legend of label + percentage", () => {
    const p = parse({ type: "pie", data: [50, 30, 20], labels: ["A", "B", "C"], title: "T" });
    const plan = planChart(p);
    expect(plan.slices).toHaveLength(3);
    expect(plan.pie).not.toBeNull();
    expect(plan.slices.every((s) => s.path.startsWith("M"))).toBe(true); // arc paths
    expect(plan.legend.map((l) => l.name)).toEqual(["A · 50%", "B · 30%", "C · 20%"]);

    const html = buildChartHtml(p, plan);
    expect(html).toMatch(/class="ch-pie-slice ch-pie-slice-0"/);
    expect(html).toMatch(/class="ch-pie-group"/);
    expect(html).toMatch(/class="ch-legend-v"/); // vertical legend

    const anims = buildChartAnimations(p, plan);
    const spin = anims.find((a) => a.selector === ".ch-pie-group")!;
    expect(spin.property).toBe("transform");        // scale + rotate sweep-in
    expect(spin.to).toMatch(/scale\(1\)/);
    expect(anims.some((a) => a.selector === ".ch-pie-slice-2" && a.property === "opacity")).toBe(true);
  });

  it("donut slices are ring segments (inner + outer arc)", () => {
    const pie = planChart(parse({ type: "pie", data: [1, 1] })).slices[0].path;
    const donut = planChart(parse({ type: "donut", data: [1, 1] })).slices[0].path;
    expect((pie.match(/A /g) ?? []).length).toBe(1);   // wedge: one arc
    expect((donut.match(/A /g) ?? []).length).toBe(2); // ring segment: outer + inner arc
  });

  it("the template is registered and validates params", () => {
    expect(chartTemplate.name).toBe("chart");
    const p = parse({ type: "column", data: [1, 2, 3], staggerMs: 100, growMs: 600, holdMs: 1000 });
    expect(chartDurationMs(p, planChart(p))).toBe(200 + 600 + 1000); // last cat start + grow + hold
  });
});

/** niceMax mirror for the stacked-axis assertion (1/2/2.5/5 × 10ⁿ). */
function niceMaxOf(v: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / pow;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * pow;
}

describe("chat generation (pure, no browser) — DM-1278", () => {
  const parse = (o: Record<string, unknown>) => chatParamsSchema.parse(o);

  it("parses the compact `me:` / `them:` line format and a JSON array", () => {
    const fromLines = parse({ messages: "them: Hi\nme: Hey there\nthem: 👋" }).messages;
    expect(fromLines).toEqual([
      { from: "them", text: "Hi" },
      { from: "me", text: "Hey there" },
      { from: "them", text: "👋" },
    ]);
    const fromArr = parse({ messages: [{ from: "me", text: "yo" }] }).messages;
    expect(fromArr).toEqual([{ from: "me", text: "yo" }]);
    expect(() => parse({ messages: "" })).toThrow(); // no messages → min(1) fails
  });

  it("renders me-bubbles right and them-bubbles left, with a header when titled", () => {
    const html = buildChatHtml(parse({ messages: [{ from: "me", text: "A" }, { from: "them", text: "B" }], title: "Sam", accent: "#abc123" }));
    expect(html).toMatch(/class="ct-row ct-me"/);
    expect(html).toMatch(/class="ct-row ct-them"/);
    expect(html).toContain("#abc123");           // me-bubble accent
    expect(html).toMatch(/class="ct-head"/);      // header present
    expect(html).toContain(">S<");                // avatar initial
    // No header when untitled.
    expect(buildChatHtml(parse({ messages: [{ from: "me", text: "x" }] }))).not.toMatch(/class="ct-head"/);
  });

  it("pops each message from its anchored corner (scale + origin) with a fade, staggered", () => {
    const p = parse({ messages: [{ from: "me", text: "a" }, { from: "them", text: "b" }], staggerMs: 500, popMs: 300, typing: false });
    const anims = buildChatAnimations(p);
    const pop0 = anims.find((a) => a.selector === ".ct-pop-0")!;
    expect(pop0.property).toBe("scale");
    expect(pop0.transformOrigin).toBe("bottom right"); // me → right
    expect(anims.find((a) => a.selector === ".ct-pop-1")!.transformOrigin).toBe("bottom left"); // them → left
    expect(anims.find((a) => a.selector === ".ct-bubble-1")!.delay).toBe(500); // staggered
    expect(chatDurationMs(p)).toBe(500 + 300 + p.holdMs);
  });

  // DM-1302: a "…" indicator precedes each them message; the thread runs
  // sequentially (type, send, type, send).
  it("inserts a typing indicator before each them message and runs the timeline sequentially", () => {
    const p = parse({ messages: [{ from: "them", text: "a" }, { from: "me", text: "b" }, { from: "them", text: "c" }], typingMs: 900, staggerMs: 500, popMs: 300 });
    const { popStart, typingStart } = chatTimeline(p);
    // them0: type[0..900], pop 900, +stagger→1400; me1: pop 1400, +stagger→1900;
    // them2: type[1900..2800], pop 2800.
    expect(typingStart).toEqual([0, null, 1900]); // them msgs type; me msg doesn't
    expect(popStart).toEqual([900, 1400, 2800]);   // them pops after typingMs; sequential
    expect(chatDurationMs(p)).toBe(2800 + 300 + p.holdMs);

    const html = buildChatHtml(p);
    expect(html).toMatch(/class="ct-typing-wrap ct-typing-wrap-0"/);
    expect(html).toMatch(/ct-dot-0-2/);                 // three dots
    expect(html).not.toMatch(/ct-typing-wrap-1/);        // not on the me message

    const anims = buildChatAnimations(p);
    expect(anims.find((a) => a.selector === ".ct-typing-wrap-0")!.from).toBe("0");   // fade in
    expect(anims.find((a) => a.selector === ".ct-typing-inner-0")!.to).toBe("0");    // fade out
    const dot = anims.find((a) => a.selector === ".ct-dot-0-1")!;
    expect(dot.property).toBe("translateY"); // bouncing
    expect(dot.repeat).toBe("infinite");
  });

  it("omits typing entirely when typing is off", () => {
    const p = parse({ messages: [{ from: "them", text: "a" }], typing: false });
    expect(buildChatHtml(p)).not.toMatch(/class="ct-typing-wrap/); // no typing element (CSS rule is harmless)
    expect(buildChatAnimations(p).some((a) => a.selector!.includes("ct-typing"))).toBe(false);
    expect(chatTimeline(p).typingStart).toEqual([null]);
  });

  it("escapes HTML in message text", () => {
    expect(buildChatHtml(parse({ messages: [{ from: "me", text: "<script>" }] }))).toContain("&lt;script&gt;");
  });
});

describe("subscribe generation (pure, no browser) — DM-1278", () => {
  const parse = (o: Record<string, unknown>) => subscribeParamsSchema.parse(o);

  it("renders the name, subtitle, CTA, avatar initial, and bell (toggleable)", () => {
    const html = buildSubscribeHtml(parse({ name: "Domotion", subtitle: "1.2M subs", action: "Subscribe", accent: "#ff0000" }));
    expect(html).toContain("Domotion");
    expect(html).toContain("1.2M subs");
    expect(html).toMatch(/class="sub-cta">Subscribe</);
    expect(html).toContain("#ff0000");
    expect(html).toContain(">D<");               // avatar initial
    expect(html).toMatch(/class="sub-bell"/);
    expect(buildSubscribeHtml(parse({ name: "X", showBell: false }))).not.toMatch(/class="sub-bell"/);
  });

  it("uses a dark card under the dark theme", () => {
    const dark = buildSubscribeHtml(parse({ name: "X", theme: "dark" }));
    expect(dark).toContain("#1f2430"); // dark card bg
  });

  it("pops the card in and keeps the CTA pulsing (looping alternate scale)", () => {
    const anims = buildSubscribeAnimations(parse({ name: "X" }));
    const pop = anims.find((a) => a.selector === ".sub-pop")!;
    expect(pop.property).toBe("scale");
    expect(pop.transformOrigin).toBe("center");
    const pulse = anims.find((a) => a.selector === ".sub-cta")!;
    expect(pulse.repeat).toBe("infinite");
    expect(pulse.alternate).toBe(true);
    expect(anims.some((a) => a.selector === ".sub-inner" && a.property === "opacity")).toBe(true);
  });

  // DM-1303: a simulated click cross-fades Subscribe → Subscribed and fills the bell.
  it("renders a click-through second state (Subscribed + filled bell) when clickAfterMs > 0", () => {
    const on = buildSubscribeHtml(parse({ name: "X", subscribedLabel: "Subscribed", clickAfterMs: 1500 }));
    expect(on).toMatch(/class="sub-state sub-state-done"/);
    expect(on).toContain("✓ Subscribed");
    expect(on).toMatch(/class="sub-bell sub-bell-filled"/); // the filled-bell element (not just the CSS rule)
    // No second state when disabled (sub-state-done appears only as an element, not in CSS).
    const off = buildSubscribeHtml(parse({ name: "X", clickAfterMs: 0 }));
    expect(off).not.toMatch(/sub-state-done/);
    expect(off).not.toMatch(/class="sub-bell sub-bell-filled"/);
  });

  it("cross-fades the two states at clickAfterMs (and the done button pops); durationMs extends to the click", () => {
    const p = parse({ name: "X", clickAfterMs: 1500, holdMs: 1000 });
    const anims = buildSubscribeAnimations(p);
    const out = anims.find((a) => a.selector === ".sub-state-cta")!;
    const inn = anims.find((a) => a.selector === ".sub-state-done")!;
    expect(out.from).toBe("1"); expect(out.to).toBe("0"); expect(out.delay).toBe(1500);
    expect(inn.from).toBe("0"); expect(inn.to).toBe("1"); expect(inn.delay).toBe(1500);
    expect(anims.find((a) => a.selector === ".sub-done")!.property).toBe("scale"); // a tap pop
    expect(anims.some((a) => a.selector === ".sub-bell-on")).toBe(true);
    // duration runs to the click + cross-fade + hold (not just the pop).
    expect(subscribeDurationMs(p)).toBe(1500 + 280 + 1000);
    // disabled → no click anims, duration is pop + hold.
    const off = parse({ name: "X", clickAfterMs: 0, holdMs: 1000 });
    expect(buildSubscribeAnimations(off).some((a) => a.selector === ".sub-state-done")).toBe(false);
    expect(subscribeDurationMs(off)).toBe(off.popMs + 1000);
  });

  it("the templates are registered", () => {
    expect(chatTemplate.name).toBe("chat");
    expect(subscribeTemplate.name).toBe("subscribe");
  });
});

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

describe("template registry (DM-1276)", () => {
  it("lists the two built-in templates", () => {
    const names = listBuiltinTemplates().map((t) => t.name).sort();
    expect(names).toEqual(["device-mockup", "lower-third"]);
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

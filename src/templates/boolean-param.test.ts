/**
 * Strict boolean template params: `z.coerce.boolean()` turned the string "false" into `true`, and the
 * CLI only had presence flags, so a default-`true` param (cta `pulse`, stat `animateValue`, chat
 * `typing`, …) could not be switched off. These tests pin the strict parse and the `--no-<param>`
 * negation across every built-in boolean param, so a new boolean param is covered automatically.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseTemplateArgs } from "../cli/template.js";
import { parseTemplateBoolean, templateBoolean } from "./boolean-param.js";
import { describeTemplateParams } from "./json-schema.js";
import { getBuiltinTemplate, listBuiltinTemplates } from "./registry.js";
import type { Template } from "./types.js";

/** Minimal valid params for each built-in template that has a required param. */
const REQUIRED: Record<string, Record<string, unknown>> = {
  cta: { cta: "Go" },
  counter: { to: 10 },
  stat: { value: 42 },
  chart: { data: [1, 2, 3] },
  "device-mockup": { url: "https://example.com" },
};

function booleanParams(): { template: Template; name: string; default: unknown }[] {
  const out: { template: Template; name: string; default: unknown }[] = [];
  for (const { name } of listBuiltinTemplates()) {
    const template = getBuiltinTemplate(name);
    if (template == null) continue;
    for (const p of describeTemplateParams(template)) {
      if (p.kind === "boolean") out.push({ template, name: p.name, default: p.default });
    }
  }
  return out;
}

function parseParam(template: Template, name: string, value: unknown): z.ZodSafeParseResult<unknown> {
  const base = REQUIRED[template.name] ?? {};
  const params = value === undefined ? { ...base } : { ...base, [name]: value };
  return template.paramsSchema.safeParse(params) as z.ZodSafeParseResult<unknown>;
}

describe("parseTemplateBoolean", () => {
  it("maps the accepted spellings and passes everything else through", () => {
    expect(parseTemplateBoolean(true)).toBe(true);
    expect(parseTemplateBoolean(false)).toBe(false);
    for (const s of ["true", "TRUE", " True ", "1"]) expect(parseTemplateBoolean(s)).toBe(true);
    for (const s of ["false", "FALSE", " False ", "0"]) expect(parseTemplateBoolean(s)).toBe(false);
    expect(parseTemplateBoolean(1)).toBe(true);
    expect(parseTemplateBoolean(0)).toBe(false);
    for (const v of ["yes", "", "off", 2, null, undefined, {}]) expect(parseTemplateBoolean(v)).toBe(v);
  });

  it("templateBoolean keeps its default visible to the JSON-Schema projection", () => {
    const schema = z.object({ flag: templateBoolean(true).describe("d") });
    const js = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) as {
      properties: Record<string, Record<string, unknown>>;
      required?: string[];
    };
    expect(js.properties.flag).toMatchObject({ type: "boolean", default: true, description: "d" });
    expect(js.required ?? []).not.toContain("flag");
    expect(schema.parse({})).toEqual({ flag: true });
    expect(schema.safeParse({ flag: "nope" }).success).toBe(false);
  });
});

describe("every built-in boolean template param", () => {
  const params = booleanParams();

  it("covers the known boolean params (guards the discovery itself)", () => {
    const names = params.map((p) => `${p.template.name}.${p.name}`).sort();
    expect(names).toEqual(
      expect.arrayContaining([
        "chart.showValues",
        "chat.typing",
        "counter.grouping",
        "cta.pulse",
        "device-mockup.mobile",
        "stat.animateValue",
        "stat.grouping",
        "subscribe.showBell",
      ]),
    );
  });

  for (const { template, name, default: def } of params) {
    it(`${template.name}.${name} parses strictly from booleans and strings`, () => {
      const get = (v: unknown): unknown => {
        const r = parseParam(template, name, v);
        if (!r.success) throw new Error(`${template.name}.${name}=${String(v)}: ${r.error.message}`);
        return (r.data as Record<string, unknown>)[name];
      };
      expect(typeof def).toBe("boolean");
      expect(get(undefined)).toBe(def);
      expect(get(true)).toBe(true);
      expect(get(false)).toBe(false);
      expect(get("true")).toBe(true);
      expect(get("false")).toBe(false);
      expect(get("1")).toBe(true);
      expect(get("0")).toBe(false);
      expect(parseParam(template, name, "maybe").success).toBe(false);
    });

    it(`${template.name}.${name} accepts --${name} and --no-${name} on the CLI`, async () => {
      const base = ["--params", JSON.stringify(REQUIRED[template.name] ?? {})];
      const on = await parseTemplateArgs([template.name, ...base, `--${name}`]);
      const off = await parseTemplateArgs([template.name, ...base, `--no-${name}`]);
      if ("help" in on || "help" in off) throw new Error("unexpected help");
      expect(on.raw[name]).toBe(true);
      expect(off.raw[name]).toBe(false);
      await expect(parseTemplateArgs([template.name, ...base, `--${name}`, `--no-${name}`])).rejects.toThrow(
        /mutually exclusive/,
      );
    });
  }

  it('--no-<param> overrides a JSON true, and a JSON "false" string turns the param off', async () => {
    const flag = await parseTemplateArgs(["cta", "--params", '{"cta":"Go","pulse":true}', "--no-pulse"]);
    if ("help" in flag) throw new Error("unexpected help");
    expect(flag.raw.pulse).toBe(false);
    const cta = getBuiltinTemplate("cta");
    if (cta == null) throw new Error("cta missing");
    const parsed = cta.paramsSchema.parse({ cta: "Go", pulse: "false" }) as { pulse: boolean };
    expect(parsed.pulse).toBe(false);
    await expect(parseTemplateArgs(["cta", "--params", '{"cta":"Go","pulse":"maybe"}'])).rejects.toThrow();
  });

  it("template --help lists boolean params as --[no-]<param>", async () => {
    const help = await parseTemplateArgs(["cta", "--help"]);
    if (!("help" in help)) throw new Error("expected help");
    expect(help.help).toMatch(/--\[no-\]pulse\s+\[default: true\]/);
    expect(help.help).toMatch(/--no-<param> turns it off/);
  });
});

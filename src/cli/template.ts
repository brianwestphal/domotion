/**
 * `domotion template <name>` — render a parameterized template to an SVG
 * (DM-1276, doc 70).
 *
 *   domotion template list                       list built-in templates
 *   domotion template <name> --help              show a template's parameters
 *   domotion template <name> [--param …] -o out.svg   render it
 *
 * Params arrive as scalar flags derived from the template's zod schema (e.g.
 * `--title "…"`), and/or as a JSON blob via `--params` / `--params-file` for
 * nested / array params. Flags win over `--params` win over `--params-file`.
 * Templates are pure front-ends onto the animate pipeline (see doc 70), so this
 * verb shares the same optimize / svgz / output handling as `animate`.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { optimizeSvg } from "../post-processing/index.js";
import { isSvgzPath, makeLogger, timed, writeOutput } from "./common.js";
import {
  describeTemplateParams,
  listBuiltinTemplates,
  loadTemplate,
  renderTemplateToSvg,
  resolveFormat,
  applyFormatSize,
  formatNames,
  loadBrand,
  type ParamInfo,
  type ResolvedFormat,
  type Brand,
  type Template,
} from "../templates/index.js";

type ArgOptions = NonNullable<ParseArgsConfig["options"]>;

const FIXED_OPTIONS: ArgOptions = {
  output: { type: "string", short: "o" },
  params: { type: "string" },
  "params-file": { type: "string" },
  format: { type: "string" },
  brand: { type: "string" },
  optimize: { type: "boolean" },
  "no-optimize": { type: "boolean" },
  quiet: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

export async function runTemplate(args: string[], _help: string): Promise<void> {
  const name = args[0];

  // `domotion template` / `--help` (no name) → overview + list.
  if (name == null || name === "-h" || name === "--help") {
    process.stdout.write(overviewHelp());
    return;
  }
  if (name === "list") {
    process.stdout.write(listHelp());
    return;
  }

  const template = await loadTemplate(name);
  const paramInfos = describeTemplateParams(template);

  // Derive parseArgs options from the params schema: booleans get a presence
  // flag, everything scalar takes a string value (numeric coercion lives in the
  // template's zod schema, so a string flag validates fine).
  const options: ArgOptions = { ...FIXED_OPTIONS };
  for (const p of paramInfos) {
    if (p.name in options) continue; // never shadow a fixed option
    options[p.name] = { type: p.kind === "boolean" ? "boolean" : "string" };
  }

  const { values } = parseArgs({ args: args.slice(1), options, allowPositionals: false, strict: true });

  if (values.help === true) {
    process.stdout.write(templateHelp(template, paramInfos));
    return;
  }
  if (values.optimize === true && values["no-optimize"] === true) {
    throw new Error("template: --optimize and --no-optimize are mutually exclusive");
  }

  // Merge params: --params-file < --params < individual flags.
  const raw: Record<string, unknown> = {};
  const paramsFile = values["params-file"] as string | undefined;
  if (paramsFile != null) {
    const path = resolve(paramsFile);
    if (!existsSync(path)) throw new Error(`template: --params-file not found: ${path}`);
    Object.assign(raw, parseParamsJson(readFileSync(path, "utf8"), `--params-file ${paramsFile}`));
  }
  const paramsInline = values.params as string | undefined;
  if (paramsInline != null) Object.assign(raw, parseParamsJson(paramsInline, "--params"));
  for (const p of paramInfos) {
    const v = (values as Record<string, unknown>)[p.name];
    if (v !== undefined) raw[p.name] = v;
  }

  // --format supplies the canvas width/height + a safe-area inset. Precedence
  // (docs/87): explicit --width/--height > format preset > template default. The
  // explicit flags are already in `raw` above (width/height are template params),
  // so `??=` lets a preset fill only the axes the author didn't set — and an
  // unset axis still falls through to the template's own zod default when no
  // format is given. `safeInset` rides the render context, not the params.
  let fmt: ResolvedFormat | undefined;
  const formatArg = values.format as string | undefined;
  if (formatArg != null) {
    fmt = resolveFormat(formatArg);
    applyFormatSize(raw, fmt);
  }

  // --brand supplies template-param defaults from a brand file (docs/85). Its
  // tokens sit beneath the explicit flags in `raw` (the merge happens inside
  // renderTemplateToSvg, before zod defaults) — explicit > brand > default.
  let brand: Brand | undefined;
  const brandArg = values.brand as string | undefined;
  if (brandArg != null) brand = loadBrand(resolve(brandArg));

  const log = makeLogger(values.quiet === true);
  log("Launching Chromium…");
  const result = await renderTemplateToSvg(template, raw, {
    log,
    ...(fmt != null ? { safeInset: fmt.safeInset } : {}),
    ...(brand != null ? { brand } : {}),
  });
  let svg = result.svg;

  const outputArg = values.output as string | undefined;
  const svgz = isSvgzPath(outputArg);
  const optimize = values.optimize === true || (svgz && values["no-optimize"] !== true);
  if (optimize) {
    svg = await timed(log, `Optimizing SVG (${(svg.length / 1024).toFixed(1)} KB → …)`, () =>
      Promise.resolve(optimizeSvg(svg)),
    );
  }

  const outPath = outputArg != null && outputArg !== "-" ? resolve(outputArg) : null;
  writeOutput(svg, outPath, svgz, `, ${template.name} ${result.width}×${result.height}`);
}

function parseParamsJson(text: string, where: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`template: ${where} is not valid JSON — ${(e as Error).message}`);
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`template: ${where} must be a JSON object of params`);
  }
  return parsed as Record<string, unknown>;
}

function overviewHelp(): string {
  return (
    "domotion template — render a parameterized template to a self-contained SVG\n\n"
    + "Usage:\n"
    + "  domotion template list                          List the built-in templates.\n"
    + "  domotion template <name> --help                 Show a template's parameters.\n"
    + "  domotion template <name> [--param …] -o out.svg Render it.\n\n"
    + "Params are passed as flags derived from the template (e.g. --title \"…\"), or as\n"
    + "JSON via --params '<json>' / --params-file <file.json>. Third-party templates are\n"
    + "npm packages named domotion-template-<name>; install one and use it by <name>\n"
    + "(search npm for the 'domotion-template' keyword). Write your own: see\n"
    + "docs/74-template-authoring.md + examples/template-package/.\n\n"
    + listHelp()
  );
}

function listHelp(): string {
  const rows = listBuiltinTemplates().map((t) => `  ${t.name.padEnd(16)} ${t.description}`);
  return `Built-in templates:\n${rows.join("\n")}\n`;
}

function templateHelp(template: Template, params: ParamInfo[]): string {
  const lines: string[] = [`domotion template ${template.name} — ${template.description}`, "", "Parameters:"];
  for (const p of params) {
    const typeHint = p.enumValues != null ? p.enumValues.join("|") : p.kind === "boolean" ? "" : `<${p.kind}>`;
    const flag = p.kind === "boolean" ? `--${p.name}` : `--${p.name} ${typeHint}`;
    const note = p.required
      ? "(required)"
      : p.default !== undefined
        ? `[default: ${JSON.stringify(p.default)}]`
        : "(optional)";
    lines.push(`  ${flag.padEnd(30)} ${note}`);
    if (p.description != null) lines.push(`  ${" ".repeat(30)} ${p.description}`);
  }
  lines.push(
    "",
    "Common options:",
    "  -o, --output <path>   Output SVG path (default: stdout). .svgz → gzip + optimize.",
    "      --params <json>   Params as a JSON object (merged under individual flags).",
    "      --params-file <f> Params from a JSON file.",
    `      --format <fmt>    Canvas preset (${formatNames().join(", ")}) or WIDTHxHEIGHT.`,
    "                        Sets width/height + a safe-area inset. --width/--height win.",
    "      --brand <file>    Brand-kit JSON (palette/font/…) supplying param defaults.",
    "                        Explicit flags win over the brand.",
    "      --optimize        Run the output through SVGO.",
    "      --quiet           Suppress progress messages on stderr.",
    "",
  );
  return lines.join("\n");
}

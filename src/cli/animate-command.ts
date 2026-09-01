/** CLI parsing and process-level browser lifecycle for `domotion animate`. */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { launchChromium } from "../capture/index.js";
import { loadBrand, type Brand } from "../templates/brand.js";
import { resolveFormat, type SafeInset } from "../templates/formats.js";
import { makeLogger, parseIntFlag } from "./common.js";
import { composeAnimateConfig, validateAnimateConfig } from "./animate-orchestrator.js";
import { writeAnimateArtifact } from "./animate-artifact.js";

export async function runAnimate(args: string[], help: string): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      output: { type: "string", short: "o" },
      format: { type: "string" },
      width: { type: "string" },
      height: { type: "string" },
      optimize: { type: "boolean" },
      "no-optimize": { type: "boolean" },
      "auto-compress": { type: "boolean" },
      "no-auto-compress": { type: "boolean" },
      brand: { type: "string" },
      quiet: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help === true) { process.stdout.write(help); process.exit(0); }
  if (positionals.length === 0) throw new Error("animate: missing <config.json>");
  if (positionals.length > 1) throw new Error(`animate: unexpected extra argument "${positionals[1]}"`);
  if (values.optimize === true && values["no-optimize"] === true) {
    throw new Error("animate: --optimize and --no-optimize are mutually exclusive");
  }
  if (values["auto-compress"] === true && values["no-auto-compress"] === true) {
    throw new Error("animate: --auto-compress and --no-auto-compress are mutually exclusive");
  }

  const configPath = resolve(positionals[0]);
  if (!existsSync(configPath)) throw new Error(`animate: config not found: ${configPath}`);
  const cfg = validateAnimateConfig(JSON.parse(readFileSync(configPath, "utf8")) as unknown);
  const configDir = dirname(configPath);
  if (values["auto-compress"] === true) cfg.autoCompress = true;
  if (values["no-auto-compress"] === true) cfg.autoCompress = false;

  let safeInset: SafeInset | undefined;
  if (values.format != null) {
    const format = resolveFormat(values.format);
    cfg.width = format.width;
    cfg.height = format.height;
    safeInset = format.safeInset;
  }
  if (values.width != null) cfg.width = parseIntFlag(values.width, "width", cfg.width);
  if (values.height != null) cfg.height = parseIntFlag(values.height, "height", cfg.height);

  const log = makeLogger(values.quiet === true);
  const brand: Brand | undefined = values.brand != null ? loadBrand(resolve(values.brand)) : undefined;
  log("Launching Chromium…");
  const browser = await launchChromium();
  let svg: string;
  try {
    svg = await composeAnimateConfig(browser, cfg, {
      configDir,
      log,
      ...(brand != null ? { brand } : {}),
      ...(safeInset != null ? { safeInset } : {}),
    });
  } finally {
    await browser.close();
  }

  await writeAnimateArtifact({
    svg,
    outputArg: values.output ?? cfg.output,
    configPath,
    frameCount: cfg.frames.length,
    optimizeRequested: values.optimize === true,
    optimizeConfigured: cfg.optimize === true,
    noOptimize: values["no-optimize"] === true,
    log,
  });
}

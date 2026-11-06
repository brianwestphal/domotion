/** CLI parsing and process-level browser lifecycle for `domotion animate`. */

import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { launchChromium } from "../capture/index.js";
// Import from the RENDER barrel, not the top-level `../index.js` barrel: the top
// barrel re-exports the studio graph, and pulling it in here creates a
// circular-import TDZ that breaks the storyboard-schema build. Routing through
// `../render/index.js` (rather than `../render/font-resolution.js` directly)
// also keeps to the font-subsystem import boundary (DM-1980 / DM-FJZQ34).
import { RENDER_TEXT_MODES, isRenderTextMode } from "../render/index.js";
import { withProcessRenderSettings } from "./process-render-settings.js";
import { loadBrand, type Brand } from "../templates/brand.js";
import { resolveFormat, type SafeInset } from "../templates/formats.js";
import { errorMessage, makeLogger, parseIntFlag, readInputFile, UsageError } from "./common.js";
import { composeAnimateConfig, validateAnimateConfig } from "./animate-orchestrator.js";
import { writeAnimateArtifact } from "./animate-artifact.js";
import { logAnimateDebugBundle, writeAnimateDebugActual } from "./animate-debug.js";
import { setupDebugBundle } from "./debug-bundle.js";

export function parseAnimateArgs(args: string[]) {
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
      "text-mode": { type: "string" },
      "real-text": { type: "boolean" },
      quiet: { type: "boolean" },
      debug: { type: "boolean" },
      "debug-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help === true) return { help: true as const };
  if (positionals.length === 0) throw new UsageError("animate: missing <config.json>");
  if (positionals.length > 1) throw new UsageError(`animate: unexpected extra argument "${positionals[1]}"`);
  if (values.optimize === true && values["no-optimize"] === true) {
    throw new UsageError("animate: --optimize and --no-optimize are mutually exclusive");
  }
  if (values["auto-compress"] === true && values["no-auto-compress"] === true) {
    throw new UsageError("animate: --auto-compress and --no-auto-compress are mutually exclusive");
  }
  if (typeof values["text-mode"] === "string" && !isRenderTextMode(values["text-mode"])) {
    throw new UsageError(
      `animate: --text-mode expects one of ${RENDER_TEXT_MODES.join(", ")}, got "${values["text-mode"]}"`,
    );
  }
  const configPath = resolve(positionals[0]);
  let rawConfig: unknown;
  try {
    rawConfig = JSON.parse(readInputFile(configPath, "animate: config"));
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError(`animate: config ${configPath} is not valid JSON: ${errorMessage(e)}`);
  }
  const cfg = validateAnimateConfig(rawConfig);
  const configDir = dirname(configPath);
  if (values["auto-compress"] === true) cfg.autoCompress = true;
  if (values["no-auto-compress"] === true) cfg.autoCompress = false;
  // DM-6SQXGF: append the paintless real-text layer to every frame (doc 260).
  if (values["real-text"] === true) cfg.realText = true;

  let safeInset: SafeInset | undefined;
  if (values.format != null) {
    const format = resolveFormat(values.format);
    cfg.width = format.width;
    cfg.height = format.height;
    safeInset = format.safeInset;
  }
  if (values.width != null) cfg.width = parseIntFlag(values.width, "width", cfg.width);
  if (values.height != null) cfg.height = parseIntFlag(values.height, "height", cfg.height);

  const brand: Brand | undefined = values.brand != null ? loadBrand(resolve(values.brand)) : undefined;

  return { help: false as const, values, cfg, configPath, configDir, safeInset, brand };
}

export async function runAnimate(args: string[], help: string): Promise<void> {
  const parsed = parseAnimateArgs(args);
  if (parsed.help) {
    process.stdout.write(help);
    return;
  }
  await executeAnimate(parsed);
}

type ParsedAnimate = Exclude<ReturnType<typeof parseAnimateArgs>, { help: true }>;

export async function executeAnimate(parsed: ParsedAnimate): Promise<void> {
  // The text mode is a process-global render setting: applied for this
  // execution only and restored when it settles (see process-render-settings).
  const textMode = parsed.values["text-mode"];
  await withProcessRenderSettings(
    typeof textMode === "string" && isRenderTextMode(textMode) ? { renderTextMode: textMode } : {},
    () => runAnimateExecution(parsed),
  );
}

async function runAnimateExecution(parsed: ParsedAnimate): Promise<void> {
  const { values, cfg, configPath, configDir, safeInset, brand } = parsed;
  const log = makeLogger(values.quiet === true);
  const outputArg = values.output ?? cfg.output;
  const { debug, debugDir } = setupDebugBundle("animate", values.debug, values["debug-dir"], outputArg, log);
  log("Launching Chromium…");
  const browser = await launchChromium();
  let svg: string;
  try {
    svg = await composeAnimateConfig(browser, cfg, {
      configDir,
      log,
      ...(brand != null ? { brand } : {}),
      ...(safeInset != null ? { safeInset } : {}),
      ...(debugDir != null ? { debugDir } : {}),
    });
  } finally {
    await browser.close();
  }

  const artifact = await writeAnimateArtifact({
    svg,
    outputArg,
    configPath,
    frameCount: cfg.frames.length,
    optimizeRequested: values.optimize === true,
    optimizeConfigured: cfg.optimize === true,
    noOptimize: values["no-optimize"] === true,
    log,
  });
  if (debug && debugDir != null) {
    writeAnimateDebugActual(debugDir, artifact.svg);
    logAnimateDebugBundle(debugDir, log);
  }
}

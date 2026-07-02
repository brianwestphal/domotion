/**
 * Template subsystem contract (DM-1276, DM-1210 option A; doc 70).
 *
 * A Domotion "template" is NOT a baked vector asset (the After Effects / Lottie
 * model). It is a *parameterized generator*: a `render(params)` function that
 * produces a self-contained SVG by driving Domotion's EXISTING capture → compose
 * pipeline. Generator templates (e.g. lower-third) synthesize HTML/CSS + an
 * `animate` config and run it; decorator templates (e.g. device-mockup) capture
 * a user input and wrap the result. Either way a template is a thin front-end
 * onto `composeAnimateConfig` — exactly like the terminal / `--cast` front-ends
 * are two front-ends onto one rendering backend — so templates add no new
 * rendering code and inherit every fidelity fix automatically.
 *
 * The expensive work a template does (build morph paths, synthesize per-word
 * keyframes, lay out a chart, capture a page) runs ONCE at author time; the
 * emitted SVG then replays for free. That's why templates can afford arbitrary
 * pre-processing the spec calls out.
 */

import type { Browser } from "@playwright/test";
import type { ZodType } from "zod";
import type { AnimateConfig } from "../cli/animate.js";
import type { SafeInset } from "./formats.js";

/**
 * The building blocks Domotion hands a template's `render()`. A template MUST
 * NOT close `browser` (the caller owns its lifecycle) and should write any
 * generated HTML/assets into `workDir` (the default base for a generated
 * config's relative `input` paths).
 */
export interface TemplateRenderContext {
  /** Shared Chromium browser. Do not close it. */
  browser: Browser;
  /**
   * Scratch directory the template may write generated HTML / assets into. It is
   * the default `configDir` for `runAnimateConfig`, so a config whose `input` is
   * a bare filename resolves a file written here.
   */
  workDir: string;
  /** Progress logger (stderr in the CLI; no-op by default). */
  log: (msg: string) => void;
  /**
   * Resolved safe-area inset (px per side) for the current canvas, supplied when
   * the caller picked a format preset (docs/87, `--format`). Templates SHOULD lay
   * content out within `canvas − safeInset` (vertical formats reserve top/bottom
   * room for platform UI). Omitted when no format was chosen — treat as a zero
   * inset (place against the raw canvas). Per-template responsive reflow that
   * consumes this at every ratio is a follow-up; v1 just plumbs it through.
   */
  safeInset?: SafeInset;
  /**
   * Run an in-memory `AnimateConfig` through the existing animate pipeline and
   * return the rendered SVG. `configDir` resolves the config's relative `input`
   * / svg-overlay `src` paths; defaults to `workDir`. Use this for *animated*
   * output (generator templates).
   */
  runAnimateConfig(cfg: AnimateConfig, configDir?: string): Promise<string>;
  /**
   * Capture a page to a STATIC SVG (the `domotion capture` recipe: load → settle
   * → webfont registration → element tree → glyph-path render). Use this for a
   * decorator template that wraps a captured page (a static SVG nests cleanly in
   * a bezel; an animated SVG does not).
   */
  captureToSvg(params: CaptureToSvgParams): Promise<TemplateOutput>;
}

/** Parameters for `TemplateRenderContext.captureToSvg` — a plain single-frame
 *  capture of a page to a static SVG (the `domotion capture` recipe). */
export interface CaptureToSvgParams {
  /** URL or local HTML file path. Local paths should be absolute (a relative one
   *  resolves against the browser's CWD, not the template's workDir). */
  input: string;
  width: number;
  height: number;
  /** Element to capture. Default `"body"`. */
  selector?: string;
  /** Emulate a mobile device (iOS UA + isMobile). Default false. */
  mobile?: boolean;
  /** prefers-color-scheme for the page. */
  colorScheme?: "light" | "dark" | "no-preference";
  /** Settle delay (ms) after readiness. Default 200. */
  wait?: number;
  /** Wait for this selector to be visible before capturing. */
  waitFor?: string;
}

/** What a template's `render()` returns: a finished SVG plus its dimensions. */
export interface TemplateOutput {
  /** A complete, self-contained `<svg>` document. */
  svg: string;
  /** The output's intrinsic width / height in px (after any bezel growth). */
  width: number;
  height: number;
  /**
   * The output's intrinsic play time in ms — how long the template's own
   * animation runs before it settles (or one loop period for an infinite loop).
   * A *generator* knows this (its `holdMs` / computed reveal end / loop period);
   * a static *decorator* (e.g. `device-mockup`) omits it. Used by a `template`
   * frame in an `animate` config (DM-1294 / doc 73) to default the frame's
   * `duration` when the author omits it, and to warn when an explicit `duration`
   * is shorter than the template would play.
   */
  durationMs?: number;
}

/**
 * A Domotion template. `paramsSchema` is a zod schema validated (and projected
 * to JSON Schema for `--help` / editor tooling) before `render` is called, so
 * `render` receives already-validated, typed params with defaults applied.
 *
 * Use `z.coerce.number()` for numeric params so a CLI string flag (`--width 960`)
 * and a JSON value (`"width": 960`) both validate.
 */
export interface Template<P = unknown> {
  /** Stable identifier — the `domotion template <name>` verb and registry key. */
  name: string;
  /** One-line human description shown by `domotion template list` / `--help`. */
  description: string;
  /** Zod schema for the template's parameters. */
  paramsSchema: ZodType<P>;
  /** Produce the SVG from validated params using the supplied context. */
  render(params: P, ctx: TemplateRenderContext): Promise<TemplateOutput>;
}

/** Runtime shape-check used by the loader to validate a dynamically-imported
 *  (third-party `domotion-template-*`) module before trusting it as a Template. */
export function isTemplate(value: unknown): value is Template {
  if (value == null || typeof value !== "object") return false;
  const t = value as Partial<Template>;
  return (
    typeof t.name === "string" &&
    typeof t.description === "string" &&
    t.paramsSchema != null &&
    typeof (t.paramsSchema as { safeParse?: unknown }).safeParse === "function" &&
    typeof t.render === "function"
  );
}

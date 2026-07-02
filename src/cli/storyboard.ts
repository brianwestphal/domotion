/**
 * `domotion storyboard` (DM-1527) — declarative scene sequencing.
 *
 * Sequences DISTINCT SCENES end-to-end into ONE self-contained animated SVG with
 * an inter-scene transition between each (title card → device-mockup demo →
 * lower-third → CTA). It sits alongside the two existing multi-source composers:
 *
 *   - `composite` LAYERS animated SVGs spatially (z-ordered, each placed).
 *   - `animate`   sequences CAPTURED frames of one evolving page.
 *   - `storyboard` (this) sequences WHOLE SCENES — each an independent
 *     `template`, `capture` (url/file), `cast` (terminal), or existing `svg` —
 *     played one after another with a transition between each.
 *
 * Each scene is rendered to a self-contained (possibly animated) SVG, then
 * embedded as a "frame" whose nested animation runs while it's on screen and
 * HOLDS otherwise — exactly the template-frame / cast-frame machinery `animate`
 * already uses (`namespaceEmbeddedAnimatedSvg` for name collisions,
 * `placeEmbeddedFrame` for canvas placement, `embeddedAnimationPeriodMs` +
 * `offsetEmbeddedAnimatedSvgTimeline` for per-scene timeline re-anchoring). The
 * assembled frames are handed to `generateAnimatedSvg`, which emits the CSS
 * `@keyframes` inter-scene transitions (crossfade / cut / push-left / scroll).
 *
 * Because the output is a normal animated SVG, it exports to MP4 via `svg-to-video`
 * like any other Domotion animation — see docs/89-storyboard-sequencing.md.
 *
 * Config shape (validated by `storyboardConfigSchema`):
 *   { width, height, output?, background?, title?, desc?, scenes: [ {
 *       <source>,                  // exactly one of: template | capture | cast | svg
 *       params?, term?,            // for `template` / `cast` sources
 *       fit?,                      // center | contain | cover (placement in the canvas)
 *       period?,                   // play length of an animated `svg` source (ms), when undetectable
 *       duration?,                 // ms on screen (optional for an animated source — inherits its play time)
 *       transition?: { type, duration }   // inter-scene transition TO the next scene
 *     } ] }
 */

import { parseArgs } from "node:util";
import { resolve, dirname } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import type { Browser } from "@playwright/test";
import { z } from "zod";
import {
  launchChromium,
  captureElementTree,
  attachWebfontTracker,
  discoverAndRegisterWebfonts,
} from "../capture/index.js";
import { castToAnimatedSvg } from "../terminal/index.js";
import {
  elementTreeToSvg,
  clearEmbeddedFonts,
  clearGlyphDefs,
  clearWebfonts,
} from "../render/index.js";
import { cullElementsOutsideViewBox } from "../tree-ops/index.js";
import { generateAnimatedSvg, type AnimationConfig, type AnimationFrame } from "../animation/index.js";
import { namespaceEmbeddedAnimatedSvg } from "../animation/embed-namespace.js";
import { placeEmbeddedFrame } from "./animate.js";
import { parseSvgIntrinsicSize, detectAnimationPeriodMs } from "../animation/svg-meta.js";
import { cliFail, loadInputIntoPage, applyReadyWaits } from "./common.js";

/** iOS UA used when a `capture` scene sets `mobile: true` (mirrors the capture path). */
const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";

// ── Config schema ────────────────────────────────────────────────────────────
// The storyboard config is external `JSON.parse`'d input, so it's validated with
// a zod schema (the single source of truth for the shape; the JSON Schema we ship
// is projected from it). Scene sources mirror the `composite` layer sources plus a
// `capture` source (a live url/file capture, which `composite` lacks).

// Inter-scene transitions reuse the animator's frame-transition enum — the SAME
// set `animate` / `generateAnimatedSvg` already emit as CSS `@keyframes`. Only the
// opaque-scene-safe subset is exposed: `crossfade` (dissolve), `cut` (instant),
// `push-left` (horizontal directional), `scroll` (vertical directional).
// `magic-move` is intentionally omitted — it needs a per-frame element-tree bridge
// built from two captured DOMs, which distinct opaque scenes don't share.
const transitionSchema = z.object({
  type: z.enum(["crossfade", "push-left", "scroll", "cut"]),
  duration: z.number().nonnegative(),
});

const captureSourceSchema = z
  .object({
    url: z.string().optional().describe("A URL to capture (http/https)."),
    file: z.string().optional().describe("A local HTML file path to capture (relative to the config)."),
    selector: z.string().optional().describe("Element selector to capture (default: body)."),
    wait: z.number().nonnegative().optional().describe("Settle time (ms) after load (default 200)."),
    waitFor: z.string().optional().describe("Wait for this selector to be visible before capture."),
    mobile: z.boolean().optional().describe("Emulate a mobile device (iOS UA)."),
    colorScheme: z.enum(["light", "dark", "no-preference"]).optional(),
  })
  .superRefine((c, ctx) => {
    const n = [c.url, c.file].filter((s) => s != null).length;
    if (n !== 1) {
      ctx.addIssue({ code: "custom", message: "a `capture` scene needs exactly one of `url` or `file`" });
    }
  });

const sceneSchema = z
  .object({
    // Exactly one source — enforced in the superRefine below.
    template: z.string().optional().describe("A template name to render as this scene."),
    params: z.record(z.string(), z.unknown()).optional().describe("Params for a `template` scene."),
    capture: captureSourceSchema.optional().describe("Capture a live url/file as this scene."),
    cast: z.string().optional().describe("Path to an asciinema v2 .cast (rendered as an animated terminal scene)."),
    term: z.record(z.string(), z.unknown()).optional().describe("Terminal options for a `cast` scene."),
    svg: z.string().optional().describe("Path to a pre-rendered SVG (static or animated) as this scene."),
    // Play length of an animated `svg` scene (ms), when it can't be auto-detected.
    period: z.number().positive().optional(),
    // Placement of a scene whose intrinsic size differs from the canvas.
    fit: z.enum(["center", "contain", "cover"]).optional(),
    // How long this scene is held on screen. Optional for an animated source
    // (template / cast / animated svg) — it then inherits the scene's own play
    // time. Required for a static source (a `capture` or a static `svg`).
    duration: z.number().positive().optional(),
    // Transition FROM this scene TO the next (the last scene's transition, if any,
    // dissolves back to scene 0 on loop).
    transition: transitionSchema.optional(),
  })
  .superRefine((s, ctx) => {
    const sources = [s.template, s.capture, s.cast, s.svg].filter((x) => x != null);
    if (sources.length !== 1) {
      ctx.addIssue({ code: "custom", message: "each scene must have exactly one source: `template`, `capture`, `cast`, or `svg`" });
    }
    if (s.params != null && s.template == null) {
      ctx.addIssue({ code: "custom", message: "`params` requires a `template` scene" });
    }
    if (s.term != null && s.cast == null) {
      ctx.addIssue({ code: "custom", message: "`term` requires a `cast` scene" });
    }
    if (s.period != null && s.svg == null) {
      ctx.addIssue({ code: "custom", message: "`period` requires an `svg` scene" });
    }
  });

export const storyboardConfigSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  output: z.string().optional(),
  background: z.string().optional(),
  /** DM-1488: accessible name → role="img" + <title> on the root <svg>. */
  title: z.string().optional(),
  /** DM-1488: accessible long description → <desc> on the root <svg>. */
  desc: z.string().optional(),
  scenes: z.array(sceneSchema).min(1),
});

export type StoryboardConfig = z.infer<typeof storyboardConfigSchema>;
type SceneCfg = z.infer<typeof sceneSchema>;

export function validateStoryboardConfig(raw: unknown): StoryboardConfig {
  const parsed = storyboardConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`storyboard: ${first.path.join(".")}: ${first.message}`);
  }
  return parsed.data;
}

/** A rendered scene source: a self-contained SVG + its intrinsic size + (for an
 *  animated scene) its own play length. `periodMs` undefined → a static scene. */
interface RenderedScene {
  svg: string;
  w: number;
  h: number;
  periodMs?: number;
}

/** Capture a live url/file to a full, self-contained (static) SVG document. */
async function captureSceneToSvg(
  browser: Browser,
  cap: NonNullable<SceneCfg["capture"]>,
  configDir: string,
  canvasW: number,
  canvasH: number,
  log: (m: string) => void,
): Promise<RenderedScene> {
  const ctx = await browser.newContext({
    viewport: { width: canvasW, height: canvasH },
    isMobile: cap.mobile === true,
    ...(cap.mobile === true ? { userAgent: MOBILE_UA } : {}),
    ...(cap.colorScheme != null ? { colorScheme: cap.colorScheme } : {}),
  });
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(90_000);
    page.setDefaultNavigationTimeout(90_000);
    const tracker = attachWebfontTracker(page);
    const input = cap.url ?? resolve(configDir, cap.file!);
    await loadInputIntoPage(page, input);
    await applyReadyWaits(page, { wait: cap.wait ?? 200, waitFor: cap.waitFor, fontsReady: true });
    clearWebfonts();
    await discoverAndRegisterWebfonts(page, tracker.urls);
    tracker.detach();
    const tree = await captureElementTree(page, cap.selector ?? "body", {
      x: 0, y: 0, width: canvasW, height: canvasH,
    });
    cullElementsOutsideViewBox(tree, canvasW, canvasH, undefined, 0, 1);
    clearEmbeddedFonts();
    clearGlyphDefs(); // DM-1338: glyph registry shares the per-generation lifecycle
    const svg = elementTreeToSvg(tree, canvasW, canvasH);
    log(`  captured ${canvasW}×${canvasH} of ${input}`);
    return { svg, w: canvasW, h: canvasH };
  } finally {
    await ctx.close();
  }
}

/** Render one scene's source to a self-contained SVG + intrinsic size + period. */
async function renderScene(
  scene: SceneCfg,
  browser: Browser,
  configDir: string,
  canvasW: number,
  canvasH: number,
  log: (m: string) => void,
): Promise<RenderedScene> {
  if (scene.template != null) {
    const { loadTemplate } = await import("../templates/registry.js");
    const { renderTemplateToSvg } = await import("../templates/render.js");
    let template;
    try {
      template = await loadTemplate(scene.template);
    } catch (e) {
      throw new Error(`template "${scene.template}": ${(e as Error).message}`);
    }
    // Inherit the canvas size into the template's width/height params when its
    // schema declares them and the author left them unset (so a scene fills the
    // canvas by default) — the same rule `animate`'s template frames follow.
    const shape = (template.paramsSchema as { shape?: Record<string, unknown> }).shape;
    const base: Record<string, unknown> = {};
    if (shape != null && Object.prototype.hasOwnProperty.call(shape, "width")) base.width = canvasW;
    if (shape != null && Object.prototype.hasOwnProperty.call(shape, "height")) base.height = canvasH;
    const out = await renderTemplateToSvg(template, { ...base, ...(scene.params ?? {}) }, {
      browser,
      log: (m) => log(`  ${m}`),
    });
    return { svg: out.svg, w: out.width, h: out.height, periodMs: out.durationMs ?? undefined };
  }
  if (scene.cast != null) {
    const castText = readFileSync(resolve(configDir, scene.cast), "utf8");
    const { svg, width, height, totalDurationMs } = await castToAnimatedSvg(castText, browser, {
      ...(scene.term ?? {}),
      log: (m) => log(`  ${m}`),
    });
    return { svg, w: width, h: height, periodMs: totalDurationMs };
  }
  if (scene.capture != null) {
    return captureSceneToSvg(browser, scene.capture, configDir, canvasW, canvasH, log);
  }
  // svg source: a pre-rendered (static or animated) SVG.
  const svg = readFileSync(resolve(configDir, scene.svg!), "utf8");
  const size = parseSvgIntrinsicSize(svg) ?? { w: canvasW, h: canvasH };
  return { svg, w: size.w, h: size.h, periodMs: scene.period ?? detectAnimationPeriodMs(svg) };
}

/** A short human label for the scene's source (for progress logs). */
function sceneLabel(scene: SceneCfg): string {
  if (scene.template != null) return `template "${scene.template}"`;
  if (scene.cast != null) return `cast ${scene.cast}`;
  if (scene.capture != null) return `capture ${scene.capture.url ?? scene.capture.file}`;
  return `svg ${scene.svg}`;
}

/**
 * Render every scene to a self-contained SVG, wrap each as an embedded animation
 * "frame" (namespaced, placed, timeline-re-anchored), and sequence them into one
 * animated SVG via `generateAnimatedSvg`. Exported so library callers can run the
 * storyboard pipeline in-process (the CLI is just a thin wrapper around it).
 */
export async function composeStoryboardConfig(
  browser: Browser,
  cfg: StoryboardConfig,
  configDir: string,
  log: (m: string) => void = () => {},
): Promise<string> {
  const n = cfg.scenes.length;
  const frames: AnimationFrame[] = [];

  for (let i = 0; i < n; i++) {
    const scene = cfg.scenes[i];
    log(`Scene ${i + 1}/${n}: ${sceneLabel(scene)}…`);
    const r = await renderScene(scene, browser, configDir, cfg.width, cfg.height, log);

    // Resolve the on-screen duration. An animated scene may inherit its own play
    // time; a static scene MUST carry an explicit `duration`.
    let duration = scene.duration ?? 0;
    if (duration <= 0) {
      if (r.periodMs == null) {
        throw new Error(`storyboard: scenes[${i}].duration: this scene has no intrinsic play time (it's static) — set an explicit "duration"`);
      }
      duration = r.periodMs;
      log(`  duration defaulted to the scene's play time: ${duration}ms`);
    } else if (r.periodMs != null && duration < r.periodMs) {
      log(`  note: scene duration ${duration}ms < scene play time ${r.periodMs}ms — the scene will be cut off; size duration to ≈ ${r.periodMs}ms`);
    }

    // Namespace the scene's document-global names (ids, font families, frame
    // classes, @keyframes, --scene-dur) with a per-scene token so they can't
    // collide with sibling scenes once concatenated into one document, strip the
    // XML prolog so the `<svg>` nests cleanly in the frame group, then place it in
    // the canvas per `fit` (centered when smaller; oversized → clipped).
    let content = namespaceEmbeddedAnimatedSvg(r.svg, `sb${i}_`);
    content = content.replace(/^<\?xml[^>]*\?>\s*/, "");
    content = placeEmbeddedFrame(content, r.w, r.h, cfg.width, cfg.height, scene.fit ?? "center");

    frames.push({
      svgContent: content,
      duration,
      transition: scene.transition,
      // An animated scene is a self-contained animated SVG with its own internal
      // period — tell the animator so it re-anchors the scene's timeline to start
      // when THIS scene is shown (and hold before/after), rather than running on
      // the shared document origin. Static scenes carry no internal animation.
      ...(r.periodMs != null ? { embeddedAnimationPeriodMs: r.periodMs } : {}),
    });
  }

  const config: AnimationConfig = {
    width: cfg.width,
    height: cfg.height,
    frames,
    background: cfg.background,
    title: cfg.title,
    desc: cfg.desc,
  };
  const svg = generateAnimatedSvg(config);
  const totalMs = frames.reduce((sum, f) => sum + f.duration + (f.transition?.duration ?? 0), 0);
  log(`Storyboard: ${n} scenes → ${cfg.width}×${cfg.height}px, ${(totalMs / 1000).toFixed(1)}s loop`);
  return svg;
}

const HELP = `domotion storyboard — sequence distinct scenes into one animated SVG

Usage:
  domotion storyboard <config.json> [-o out.svg]

Each scene is a template, a live capture (url/file), a terminal cast, or a
pre-rendered SVG (any may be animated), played one after another with an
inter-scene transition (crossfade | cut | push-left | scroll). Each scene runs
its own animation while on screen and holds otherwise. The output is a normal
animated SVG — export it to MP4 with svg-to-video. See
docs/89-storyboard-sequencing.md.

Options:
  -o, --output <path>  Output SVG path (default: the config's "output", else stdout).
  -h, --help           Show this help.
`;

export async function runStoryboard(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { output: { type: "string", short: "o" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help || positionals.length === 0) {
    (values.help ? process.stdout : process.stderr).write(HELP);
    if (!values.help) process.exit(2);
    return;
  }
  const configPath = resolve(positionals[0]);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    cliFail("domotion storyboard", `could not read config ${configPath}: ${(e as Error).message}`, "usage");
    return;
  }
  const cfg = validateStoryboardConfig(raw);
  const configDir = dirname(configPath);
  const browser = await launchChromium();
  try {
    const svg = await composeStoryboardConfig(browser, cfg, configDir, (m) => process.stderr.write(m + "\n"));
    const outPath = values.output ?? cfg.output;
    if (outPath == null) {
      process.stdout.write(svg);
    } else {
      writeFileSync(resolve(outPath), svg);
      process.stderr.write(`Wrote ${resolve(outPath)} — ${(svg.length / 1024).toFixed(1)} KB\n`);
    }
  } finally {
    await browser.close();
  }
}

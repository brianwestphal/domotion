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
 *   { width, height, output?, background?, title?, desc?,
 *     cursor?,                     // DM-1554: a scene-spanning cursor track (explicit `to` events)
 *     scenes: [ {
 *       <source>,                  // exactly one of: template | capture | cast | svg
 *       params?, term?,            // for `template` / `cast` sources
 *       fit?,                      // center | contain | cover (placement in the canvas)
 *       period?,                   // play length of an animated `svg` source (ms), when undetectable
 *       duration?,                 // ms on screen (optional for an animated source — inherits its play time)
 *       overlays?,                 // DM-1554: per-scene typing / tap / svg / blink / shine overlays
 *       transition?: { type, duration }   // inter-scene transition TO the next scene (docs/88 set)
 *     } ] }
 *
 * DM-1553: scenes that share a font are deduped — cast scenes through one shared
 * embedded-font builder (union subset embedded once), plus a byte-identical
 * `@font-face` collapse across all scenes (`dedupeCompositeFonts`).
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
  getEmbeddedFontFaceCss,
} from "../render/index.js";
import { cullElementsOutsideViewBox } from "../tree-ops/index.js";
import {
  generateAnimatedSvg,
  type AnimationConfig,
  type AnimationFrame,
  type CursorOverlay,
} from "../animation/index.js";
import { namespaceEmbeddedAnimatedSvg } from "../animation/embed-namespace.js";
import { dedupeCompositeFonts } from "../animation/composite.js";
import { frameAdvanceMs } from "../animation/frame-timeline.js";
import {
  placeEmbeddedFrame,
  resolveEmbeddedFrameOverlays,
  buildCursorOverlay,
  overlaySchema as authoringOverlaySchema,
  cursorEventSchema,
  cursorStyleSchema,
} from "./animate.js";
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
// set `animate` / `generateAnimatedSvg` already emit as CSS `@keyframes` (docs/88).
// The full cross-engine-safe (opaque-scene-safe) vocabulary is exposed: the
// originals `crossfade` (dissolve) / `cut` (instant) / `push-left` / `scroll`
// (== `push-up`), plus the DM-1524 expansion — the remaining directional pushes
// (`push-right` / `push-up` / `push-down`), the clip-path reveals (`wipe` / `iris`),
// the scale dollies (`zoom-in` / `zoom-out`), and the `shine` sweep. Each is pure
// `transform` / `clip-path` / `opacity` / gradient (no animated CSS `filter`), so it
// needs NO new storyboard-side machinery — the enum just widens to pass it through.
// `magic-move` stays out — it needs a per-frame element-tree bridge built from two
// captured DOMs, which distinct opaque scenes don't share.
const transitionSchema = z.object({
  type: z.enum([
    "crossfade", "cut", "push-left", "scroll",
    "push-right", "push-up", "push-down",
    "wipe", "iris", "zoom-in", "zoom-out", "shine",
  ]),
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
    // DM-1554: per-scene overlays (typing / tap / svg / blink / shine), reusing the
    // `animate` authoring schema + render path verbatim — so a `capture` scene can
    // show a typing / tap demo layered on top. Coordinates are in the CANVAS space
    // (top-level, like `animate`'s embedded-frame overlays); a selector `anchor`
    // can't resolve here (a scene retains no live DOM) and falls back to `x`/`y`.
    overlays: z.array(authoringOverlaySchema).optional(),
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

// DM-1554: a storyboard-level cursor track — one macOS-style pointer that spans
// the WHOLE loop (across scene boundaries), so a capture scene's typing / tap demo
// can be driven by a visible cursor. It reuses `animate`'s cursor event / style
// authoring shapes verbatim, restricted to the EXPLICIT form: events carry
// absolute `to` coordinates (`frame` = scene index, `at` = ms into that scene). A
// `selector` can't resolve (a scene retains no live DOM), so it's rejected here;
// there is no `"auto"` mode (a storyboard has no interaction actions to derive from).
const storyboardCursorSchema = z
  .object({
    style: cursorStyleSchema.optional(),
    events: z.array(cursorEventSchema).min(1, "must be a non-empty array"),
  })
  .superRefine((c, ctx) => {
    c.events.forEach((e, i) => {
      if (e.selector != null) {
        ctx.addIssue({
          code: "custom",
          path: ["events", i, "selector"],
          message: "a storyboard cursor event uses absolute `to` coordinates — a `selector` can't resolve (a scene retains no live DOM)",
        });
      }
    });
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
  /** DM-1554: an optional scene-spanning cursor track (explicit `to` events). */
  cursor: storyboardCursorSchema.optional(),
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
  /**
   * DM-1553: this scene was rendered through the storyboard's SHARED embedded-font
   * builder (a `cast` scene, `manageFonts:false`), so its `@font-face` is deferred
   * to the single top-level block emitted once by `generateAnimatedSvg`. Its `dmfN`
   * font families are kept UN-prefixed during namespacing so they resolve against
   * that shared block (mirrors `composite`'s `deferFonts`, DM-1331).
   */
  deferFonts?: boolean;
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

/** The scene's source kind — used to word an overlay's no-DOM anchor warning. */
function sceneKind(scene: SceneCfg): string {
  if (scene.template != null) return "template";
  if (scene.cast != null) return "cast";
  if (scene.capture != null) return "capture";
  return "svg";
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
  const rendered: (RenderedScene | undefined)[] = new Array(n);

  // DM-1553: cross-scene font dedup, ported from `composite` (docs/77). Two
  // mechanisms shrink a storyboard whose scenes share a font:
  //
  //  1. The SHARED-BUILDER cast merge (DM-1331): render every `cast` scene through
  //     ONE embedded-font builder (`manageFonts:false`) so several terminals that
  //     use the same monospace embed its UNION glyph subset ONCE — not one subset
  //     per scene. The single finished `@font-face` block is collected with
  //     `getEmbeddedFontFaceCss()` and emitted once by `generateAnimatedSvg`
  //     (`config.fontFaceCss`); those scenes keep their `dmfN` families un-prefixed
  //     (`deferFonts`) so they resolve against it. Must run BEFORE template/capture
  //     scenes render — those clear the same module-global builder.
  //  2. The byte-identical-payload collapse (`dedupeCompositeFonts`, DM-1329),
  //     applied to the assembled SVG below — folds any two scenes that embed the
  //     exact same base64 payload (a reused face across template/svg scenes, or the
  //     same scene twice) down to one copy.
  const castIdxs = cfg.scenes.flatMap((s, i) => (s.cast != null ? [i] : []));
  let sharedFontCss = "";
  if (castIdxs.length > 0) {
    clearEmbeddedFonts();
    clearGlyphDefs(); // DM-1338: the glyph registry shares the shared-builder lifecycle
    for (const i of castIdxs) {
      const scene = cfg.scenes[i];
      log(`Scene ${i + 1}/${n}: ${sceneLabel(scene)} (shared font)…`);
      const castText = readFileSync(resolve(configDir, scene.cast!), "utf8");
      const { svg, width, height, totalDurationMs } = await castToAnimatedSvg(castText, browser, {
        ...(scene.term ?? {}),
        manageFonts: false,
        log: (m) => log(`  ${m}`),
      });
      rendered[i] = { svg, w: width, h: height, periodMs: totalDurationMs, deferFonts: true };
    }
    sharedFontCss = getEmbeddedFontFaceCss();
  }

  // Render the remaining (template / capture / svg) scenes — each self-contained.
  for (let i = 0; i < n; i++) {
    if (rendered[i] != null) continue;
    const scene = cfg.scenes[i];
    log(`Scene ${i + 1}/${n}: ${sceneLabel(scene)}…`);
    rendered[i] = await renderScene(scene, browser, configDir, cfg.width, cfg.height, log);
  }

  const frames: AnimationFrame[] = [];
  for (let i = 0; i < n; i++) {
    const scene = cfg.scenes[i];
    const r = rendered[i]!;

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
    // DM-1553: a `deferFonts` (cast, shared-builder) scene keeps its `dmfN` font
    // families un-prefixed so they resolve against the single top-level block.
    let content = namespaceEmbeddedAnimatedSvg(r.svg, `sb${i}_`, { namespaceFonts: r.deferFonts !== true });
    content = content.replace(/^<\?xml[^>]*\?>\s*/, "");
    content = placeEmbeddedFrame(content, r.w, r.h, cfg.width, cfg.height, scene.fit ?? "center");

    // DM-1554: per-scene overlays render on top of the scene (canvas coords). A
    // scene retains no live DOM, so a selector `anchor` can't resolve here — it
    // warns and falls back to `x`/`y`, exactly like `animate`'s cast/template
    // frames (`resolveEmbeddedFrameOverlays`).
    const overlays = resolveEmbeddedFrameOverlays(
      scene.overlays,
      configDir,
      i,
      `storyboard ${sceneKind(scene)}`,
      log,
    );

    frames.push({
      svgContent: content,
      duration,
      transition: scene.transition,
      ...(overlays != null ? { overlays } : {}),
      // An animated scene is a self-contained animated SVG with its own internal
      // period — tell the animator so it re-anchors the scene's timeline to start
      // when THIS scene is shown (and hold before/after), rather than running on
      // the shared document origin. Static scenes carry no internal animation.
      ...(r.periodMs != null ? { embeddedAnimationPeriodMs: r.periodMs } : {}),
    });
  }

  // DM-1554: assemble the scene-spanning cursor track (explicit `to` events, one
  // pointer across the whole loop) from `cfg.cursor`, reusing `animate`'s cursor
  // builder. `frame` on each event is the SCENE index; `at` is ms into that scene.
  let cursorOverlay: CursorOverlay | undefined;
  if (cfg.cursor != null) {
    for (const ev of cfg.cursor.events) {
      if (ev.frame >= n) {
        throw new Error(`storyboard: cursor.events references scene ${ev.frame}, but there are only ${n} scenes`);
      }
    }
    const frameStartsMs: number[] = [];
    {
      let acc = 0;
      for (const f of frames) {
        frameStartsMs.push(acc);
        acc += frameAdvanceMs(f);
      }
    }
    // Explicit form only (no `"auto"` — a storyboard has no interaction actions),
    // and `to`-coordinate events only (no live DOM), so the `frames` /
    // `explicitBoxes` args the auto/selector paths would read stay empty.
    cursorOverlay = buildCursorOverlay(false, cfg.cursor.events, cfg.cursor.style, [], new Map(), frameStartsMs, []);
  }

  const config: AnimationConfig = {
    width: cfg.width,
    height: cfg.height,
    frames,
    background: cfg.background,
    title: cfg.title,
    desc: cfg.desc,
    ...(sharedFontCss !== "" ? { fontFaceCss: sharedFontCss } : {}),
    ...(cursorOverlay != null ? { cursorOverlay } : {}),
  };
  // DM-1553: collapse any byte-identical embedded-font payloads across scenes.
  const svg = dedupeCompositeFonts(generateAnimatedSvg(config));
  const totalMs = frames.reduce((sum, f) => sum + frameAdvanceMs(f), 0);
  log(`Storyboard: ${n} scenes → ${cfg.width}×${cfg.height}px, ${(totalMs / 1000).toFixed(1)}s loop`);
  return svg;
}

const HELP = `domotion storyboard — sequence distinct scenes into one animated SVG

Usage:
  domotion storyboard <config.json> [-o out.svg]

Each scene is a template, a live capture (url/file), a terminal cast, or a
pre-rendered SVG (any may be animated), played one after another with an
inter-scene transition (crossfade | cut | push-left | push-right | push-up |
push-down | scroll | wipe | iris | zoom-in | zoom-out | shine). Each scene runs
its own animation while on screen and holds otherwise, and may carry per-scene
overlays (typing / tap / svg / blink / shine); a storyboard-level cursor track
can span scenes. The output is a normal animated SVG — export it to MP4 with
svg-to-video. See docs/89-storyboard-sequencing.md.

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

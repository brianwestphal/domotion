/**
 * Built-in template: kinetic-text (DM-1277, doc 72).
 *
 * Kinetic typography — a headline string is expanded at author time into per-word
 * (or per-character) units, each revealed with its own staggered one-shot
 * animation, then held assembled. This is the clearest showcase of the template
 * thesis from doc 70: the "split text → synthesize N staggered keyframes" work is
 * pure pre-processing that runs once; the emitted SVG just replays.
 *
 * Same two animation constraints as `background-loop` (doc 71): only one
 * intra-frame animation applies per captured element, and SVG transforms are
 * origin-(0,0). So each animated unit is a `.kt-w-N` transform-wrapper (rise /
 * slide via origin-safe translateX/translateY) around a `.kt-wi-N` inner span.
 * DM-1512/1513: the move and the fade are FUSED into that one wrapper animation
 * (via the animation entry's `fuse` list) rather than a separate opacity
 * animation on the inner span — one CSS timeline can't desync under Firefox's
 * off-main-thread compositing (see docs/84). The `.kt-wi-N` inner span is now
 * inert (it just carries the glyph). The reveal is one-shot (no repeat): units
 * hold `from` until their staggered turn, animate in, then hold `to` so the
 * headline stays assembled.
 */

import { runSingleFrameGenerator } from "../run-single-frame.js";
import { z } from "zod";
import type { AnimateConfig } from "../../cli/animate.js";
import type { Template, TemplateOutput, TemplateRenderContext } from "../types.js";
import { brandParams, brandBackground, type Brand } from "../brand.js";
import { escapeHtml } from "../../utils/escapeHtml.js";

const VARIANTS = ["rise", "slide", "fade", "clip", "pop"] as const;
export type KineticVariant = (typeof VARIANTS)[number];

const LOOP_MODES = ["loop", "boomerang"] as const;
export type KineticLoop = (typeof LOOP_MODES)[number];

export const kineticTextParamsSchema = z.object({
  text: z.string().min(1).max(400).describe("The headline to animate (required). Use \\n for line breaks; a light set of inline tags — <b>/<strong>, <i>/<em>, <u>, <s>/<del>, <font color=\"…\"> — styles words (others are ignored)."),
  variant: z.enum(VARIANTS).default("rise").describe('Reveal style: "rise" | "slide" | "fade" | "clip" (left-to-right wipe) | "pop" (scale up from the center with overshoot).'),
  // DM-1286: the SVG scene always loops; this picks how. "loop" replays the
  // staggered reveal each cycle (a hard cut at the loop seam — the existing
  // behavior); "boomerang" makes each unit assemble + disassemble continuously.
  loop: z.enum(LOOP_MODES).default("loop").describe('Loop style: "loop" (replay the reveal) | "boomerang" (continuous assemble/disassemble).'),
  by: z.enum(["word", "char"]).default("word").describe("Animate per word or per character."),
  width: z.coerce.number().int().positive().default(1280).describe("Output width in px."),
  height: z.coerce.number().int().positive().default(720).describe("Output height in px."),
  fontSize: z.coerce.number().int().positive().default(88).describe("Font size in px."),
  fontWeight: z.coerce.number().int().default(800).describe("Font weight."),
  color: z.string().default("#f5f7fa").describe("Text color (CSS color)."),
  background: z.string().default("#0b1020").describe('Frame background (CSS color or "transparent").'),
  align: z.enum(["center", "left"]).default("center").describe("Text alignment."),
  fontFamily: z
    .string()
    .default("-apple-system, system-ui, 'Segoe UI', Roboto, sans-serif")
    .describe("CSS font-family stack."),
  staggerMs: z.coerce.number().int().positive().default(90).describe("Delay between units in ms."),
  revealMs: z.coerce.number().int().positive().default(600).describe("Per-unit reveal duration in ms."),
  holdMs: z.coerce.number().int().positive().default(1600).describe("Hold time after full reveal in ms."),
});

export type KineticTextParams = z.infer<typeof kineticTextParamsSchema>;


/** A run of text sharing one inline style (empty `style` = unstyled). */
export interface FmtSegment {
  text: string;
  /** Inline CSS for an emphasis run (e.g. `font-style:italic;color:#f00`), or "". */
  style: string;
}

/** One animated unit: a word, or a single character — its visible text split into
 *  styled segments. `index` is its global stagger position. */
export interface KineticUnit {
  index: number;
  segments: FmtSegment[];
}

/** Convenience: a unit's plain text (segments concatenated). */
export function unitText(u: KineticUnit): string {
  return u.segments.map((s) => s.text).join("");
}

/** A styled character produced by the inline-markup parser. */
interface StyledChar { ch: string; style: string; }

/**
 * DM-1286: the safelist of inline "light HTML" emphasis tags → the inline CSS
 * each contributes. Anything outside this list (and any attribute other than
 * `<font color>`) is ignored, so the markup can never inject arbitrary CSS/markup
 * — only these styles reach the output.
 */
function styleForStack(stack: Array<{ tag: string; color?: string }>): string {
  let bold = false, italic = false, underline = false, strike = false;
  let color: string | undefined;
  for (const e of stack) {
    if (e.tag === "b" || e.tag === "strong") bold = true;
    else if (e.tag === "i" || e.tag === "em") italic = true;
    else if (e.tag === "u" || e.tag === "ins") underline = true;
    else if (e.tag === "s" || e.tag === "del" || e.tag === "strike") strike = true;
    else if (e.tag === "font" && e.color != null) color = e.color;
  }
  const parts: string[] = [];
  if (bold) parts.push("font-weight:900");
  if (italic) parts.push("font-style:italic");
  const deco: string[] = [];
  if (underline) deco.push("underline");
  if (strike) deco.push("line-through");
  if (deco.length > 0) parts.push(`text-decoration:${deco.join(" ")}`);
  if (color != null) parts.push(`color:${color}`);
  return parts.join(";");
}

const EMPHASIS_TAGS = new Set(["b", "strong", "i", "em", "u", "ins", "s", "del", "strike", "font"]);
/** Keep only CSS-color-safe characters so a `<font color>` value can't break out
 *  of the style attribute it lands in. */
function sanitizeColor(raw: string): string {
  return raw.trim().replace(/[^#a-zA-Z0-9(),.%\s-]/g, "");
}

/**
 * Parse the headline into lines of styled characters. Recognizes `\n` (literal
 * backslash-n OR an actual newline) as a line break and the emphasis safelist as
 * inline styling; every other `<…>` that looks like a tag is dropped, and a stray
 * `<` is treated as literal text. Pure + exported for testing.
 */
export function parseStyledText(text: string): StyledChar[][] {
  const normalized = text.replace(/\\n/g, "\n"); // CLI ergonomics: \n → newline
  const lines: StyledChar[][] = [[]];
  const stack: Array<{ tag: string; color?: string }> = [];
  const tagRe = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^>]*)?)>/;
  let i = 0;
  while (i < normalized.length) {
    const c = normalized[i];
    if (c === "\n") {
      lines.push([]);
      i++;
      continue;
    }
    if (c === "<") {
      const m = tagRe.exec(normalized.slice(i));
      if (m != null) {
        const closing = m[1] === "/";
        const tag = m[2].toLowerCase();
        if (EMPHASIS_TAGS.has(tag)) {
          if (closing) {
            // Pop the nearest matching open tag.
            for (let k = stack.length - 1; k >= 0; k--) {
              if (stack[k].tag === tag) { stack.splice(k, 1); break; }
            }
          } else {
            let color: string | undefined;
            if (tag === "font") {
              const cm = /color\s*=\s*"([^"]*)"|color\s*=\s*'([^']*)'/i.exec(m[3]);
              if (cm != null) color = sanitizeColor(cm[1] ?? cm[2] ?? "");
            }
            stack.push({ tag, color });
          }
          i += m[0].length;
          continue;
        }
        // Unknown tag → drop it (don't render the markup as literal text).
        i += m[0].length;
        continue;
      }
      // A stray `<` that isn't a tag → literal character.
    }
    lines[lines.length - 1].push({ ch: c, style: styleForStack(stack) });
    i++;
  }
  return lines;
}

/** Group consecutive same-style chars of a word into segments. */
function groupSegments(chars: StyledChar[]): FmtSegment[] {
  const segs: FmtSegment[] = [];
  for (const sc of chars) {
    const last = segs[segs.length - 1];
    if (last != null && last.style === sc.style) last.text += sc.ch;
    else segs.push({ text: sc.ch, style: sc.style });
  }
  return segs;
}

/**
 * Lines → words → animated units, with global stagger indices. Pure — parses the
 * inline markup + line breaks, splits each line on whitespace, drops empty tokens.
 * In `word` mode each word is one unit (its mixed styles become segments); in
 * `char` mode each character is a unit.
 */
export function planUnits(p: KineticTextParams): { lines: KineticUnit[][][]; count: number } {
  const parsedLines = parseStyledText(p.text);
  const lines: KineticUnit[][][] = [];
  let index = 0;
  for (const lineChars of parsedLines) {
    // Split the line into words on whitespace (spaces are separators, not units).
    const words: StyledChar[][] = [];
    let cur: StyledChar[] = [];
    for (const sc of lineChars) {
      if (/\s/.test(sc.ch)) {
        if (cur.length > 0) { words.push(cur); cur = []; }
      } else {
        cur.push(sc);
      }
    }
    if (cur.length > 0) words.push(cur);

    const lineUnits: KineticUnit[][] = [];
    for (const wordChars of words) {
      if (p.by === "char") {
        lineUnits.push(wordChars.map((sc) => ({ index: index++, segments: [{ text: sc.ch, style: sc.style }] })));
      } else {
        lineUnits.push([{ index: index++, segments: groupSegments(wordChars) }]);
      }
    }
    lines.push(lineUnits);
  }
  return { lines, count: index };
}

/** A unit's inner markup: its styled segments (escaped text, optional style span). */
function unitInner(u: KineticUnit): string {
  return u.segments
    .map((s) => (s.style !== "" ? `<span style="${s.style}">${escapeHtml(s.text)}</span>` : escapeHtml(s.text)))
    .join("");
}

/** Standalone HTML for the headline (pure — unit-testable without a browser). */
export function buildKineticHtml(p: KineticTextParams, plan: { lines: KineticUnit[][][] }): string {
  const unitSpan = (u: KineticUnit): string =>
    `<span class="kt-w kt-w-${u.index}"><span class="kt-wi kt-wi-${u.index}">${unitInner(u)}</span></span>`;
  // Each line is a block; words within a line are separated by spaces. Char mode:
  // wrap each word's char-units in a nowrap group so words never break mid-word.
  const linesMarkup = plan.lines
    .map((line) => {
      const wordsMarkup = line
        .map((units) =>
          p.by === "char"
            ? `<span class="kt-word">${units.map(unitSpan).join("")}</span>`
            : unitSpan(units[0]),
        )
        .join(" ");
      // An empty line (blank between `\n\n`) still occupies a row.
      return `<div class="kt-line">${wordsMarkup === "" ? "&nbsp;" : wordsMarkup}</div>`;
    })
    .join("");
  const justify = p.align === "center" ? "center" : "flex-start";
  const textAlign = p.align;
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: ${p.width}px; height: ${p.height}px; }
  body {
    background: ${p.background};
    font-family: ${p.fontFamily};
    display: flex; align-items: center; justify-content: ${justify};
    padding: 8% 7%;
  }
  .kt-headline {
    font-size: ${p.fontSize}px; font-weight: ${p.fontWeight}; line-height: 1.1;
    color: ${p.color}; letter-spacing: -0.02em; text-align: ${textAlign};
    max-width: 100%;
  }
  .kt-line { display: block; }
  /* inline-block so per-unit transforms apply; the wrapper carries the move, the
     inner carries the fade (two selectors → two non-colliding animations). */
  .kt-w, .kt-wi { display: inline-block; }
  .kt-word { display: inline-block; white-space: nowrap; }
</style></head>
<body>
  <h1 class="kt-headline">${linesMarkup}</h1>
</body></html>`;
}

/** Per-unit staggered reveal animations. `rise`/`slide`/`clip` animate the
 *  wrapper; every variant fades the inner. In `boomerang` loop mode the reveals
 *  repeat with `alternate` (assemble → disassemble → …); in `loop` mode they're
 *  one-shot and the SVG scene replays them each cycle. Pure. */
export function buildKineticAnimations(
  p: KineticTextParams,
  plan: { lines: KineticUnit[][][] },
): NonNullable<AnimateConfig["frames"][number]["animations"]> {
  const anims: NonNullable<AnimateConfig["frames"][number]["animations"]> = [];
  // `boomerang`: each unit assembles then disassembles forever, phase-offset by
  // its stagger. `loop`: one-shot; the infinitely-looping scene replays it.
  const loopFields = p.loop === "boomerang" ? { repeat: "infinite" as const, alternate: true } : {};
  // DM-1512/1513: each unit's move + fade is emitted as ONE animation on the
  // wrapper (`.kt-w-*`), with the fade FUSED into the move via `fuse` rather than
  // a separate opacity animation on the inner span. One CSS animation is one
  // timeline, so the fade and the move stay in perfect sync — immune to
  // Firefox's off-main-thread compositing, which under load demotes one of two
  // SEPARATE animations to the main thread and drifts them apart (a fade running
  // ahead of its slide/scale). The fused fade rides the move's window + easing.
  // See docs/84-viewer-browser-support.md.
  const fade = [{ property: "opacity" as const, from: "0", to: "1" }];
  for (const line of plan.lines) {
    for (const units of line) {
      for (const u of units) {
        const delay = u.index * p.staggerMs;
        const sel = `.kt-w-${u.index}`;
        if (p.variant === "rise") {
          anims.push({ selector: sel, property: "translateY", from: "0.55em", to: "0em", duration: p.revealMs, delay, easing: "cubic-bezier(0.22,1,0.36,1)", fuse: fade, ...loopFields });
        } else if (p.variant === "slide") {
          anims.push({ selector: sel, property: "translateX", from: "-0.6em", to: "0em", duration: p.revealMs, delay, easing: "cubic-bezier(0.22,1,0.36,1)", fuse: fade, ...loopFields });
        } else if (p.variant === "clip") {
          // Left-to-right wipe via the `clipPath` intra-frame property (doc 08):
          // `inset(0 100% 0 0)` clips everything but the left edge; animating the
          // right inset to 0 reveals the unit left→right.
          anims.push({ selector: sel, property: "clipPath", from: "inset(-10% 100% -10% 0)", to: "inset(-10% 0% -10% 0)", duration: p.revealMs, delay, easing: "cubic-bezier(0.22,1,0.36,1)", fuse: fade, ...loopFields });
        } else if (p.variant === "pop") {
          // Scale-pop: grow from small to full about the unit's OWN CENTER
          // (`transformOrigin`, DM-1297), with a back-eased overshoot. Without the
          // center origin an SVG scale would shrink toward the canvas corner.
          anims.push({ selector: sel, property: "scale", from: "0.3", to: "1", duration: p.revealMs, delay, easing: "cubic-bezier(0.34,1.56,0.64,1)", transformOrigin: "center", fuse: fade, ...loopFields });
        } else {
          // `fade` variant: no move — just the fade, on the wrapper.
          anims.push({ selector: sel, property: "opacity", from: "0", to: "1", duration: p.revealMs, delay, easing: "ease-out", ...loopFields });
        }
      }
    }
  }
  return anims;
}

/** The scene/play time. `loop`: the last unit's reveal end + the hold (the scene
 *  then replays). `boomerang`: one assemble + disassemble cycle of the last unit
 *  (the per-unit animations repeat infinitely, so this just frames a cycle). */
export function kineticDurationMs(p: KineticTextParams, count: number): number {
  const lastStart = Math.max(0, count - 1) * p.staggerMs;
  if (p.loop === "boomerang") return lastStart + p.revealMs * 2;
  return lastStart + p.revealMs + p.holdMs;
}

export const kineticTextTemplate: Template<KineticTextParams> = {
  name: "kinetic-text",
  description: "Kinetic typography — reveal a headline (rise / slide / fade / clip / pop) word- or char-by-char, with multi-line (\\n), inline emphasis tags, and a loop / boomerang mode.",
  paramsSchema: kineticTextParamsSchema,
  brandDefaults(brand: Brand): Partial<KineticTextParams> {
    return brandParams<KineticTextParams>({
      color: brand.palette?.text,
      background: brandBackground(brand),
      fontFamily: brand.font?.family,
    });
  },
  async render(params: KineticTextParams, ctx: TemplateRenderContext): Promise<TemplateOutput> {
    const plan = planUnits(params);
    ctx.log(`template kinetic-text: ${params.variant}/${params.by}, ${plan.count} units, "${params.text}"`);
    // Play time = the staggered reveal end plus the hold (the same value used as
    // the underlying frame's `duration`).
    return runSingleFrameGenerator(ctx, {
      name: "kinetic-text",
      html: buildKineticHtml(params, plan),
      width: params.width,
      height: params.height,
      durationMs: kineticDurationMs(params, plan.count),
      animations: buildKineticAnimations(params, plan),
    });
  },
};

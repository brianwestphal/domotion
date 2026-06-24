/**
 * DM-1319: re-anchor a nested animated SVG's timeline so it starts when its
 * frame becomes visible — not at the master-loop origin.
 *
 * A `cast` / `template` frame embeds a complete `generateAnimatedSvg` document
 * as one frame's content (a self-contained animated terminal / template SVG).
 * Its internal CSS animations are `infinite` with a period equal to the embedded
 * content's own play length (e.g. `13.600s` for a 13.6 s cast), and — like every
 * CSS animation in the document — they start at the SHARED document origin
 * (t = 0). But the frame that hosts them only becomes visible at its master-loop
 * offset (after the preceding frames' durations + transitions). So by the time
 * the frame shows, the embedded animation's clock is already partway through its
 * period: you see the back half of the recording, and it loops back to the start
 * mid-visible when its (shorter) period wraps before the master loop does.
 *
 * The fix: rewrite the embedded document so its motion is REMAPPED into the
 * sub-window `[startMs, startMs + periodMs]` of the master loop and HELD at its
 * first / last keyframe outside that window. Concretely, for every internal
 * animation whose duration equals the embedded period:
 *
 *  1. change its `animation-duration` to the MASTER period, so it now shares the
 *     master loop's clock (and stays in sync across loops — different periods
 *     would drift), and
 *  2. remap the percentages of every `@keyframes` it drives: an original stop at
 *     `p%` of the embedded period moves to `offset% + p% * (period / master)`,
 *     with an added `0%` hold at the first stop's value and a `100%` hold at the
 *     last stop's value so the content sits still before it enters and freezes on
 *     its final frame after it finishes (while the host frame is still up).
 *
 * Animations whose duration does NOT match the embedded period (e.g. a terminal
 * cursor's fixed ~1.06 s blink) are left free-running — they're independent of
 * the recording's timeline. Durations are matched by numeric value, not string,
 * because the animator formats them at different precisions (`13.60s` in full
 * mode, `13.600s` in incremental mode).
 *
 * The vocabulary is fully controlled (domotion's own animator emits it), so the
 * CSS rewrite is precise. This runs AFTER {@link namespaceEmbeddedAnimatedSvg}
 * (so names are already per-frame unique) and only touches `<style>` contents.
 */

/**
 * How an embedded layer's own timeline maps onto its container's master loop
 * (DM-1323). `hold` plays the content once at its natural rendered rate starting
 * at `startMs`, then freezes on its last frame (the DM-1319 default). `stretch`
 * time-scales the content to fill `windowMs` exactly (speed it up / slow it
 * down). `loop` repeats the content at its own period for the rest of the loop
 * (a seam can occur at the master-loop boundary when the periods aren't
 * commensurate — fine for seamless-by-design loops like a background).
 */
export type EmbeddedTimelineMode = "hold" | "stretch" | "loop";

/** Options for {@link offsetEmbeddedAnimatedSvgTimeline}. */
export interface OffsetTimelineOptions {
  /** The embedded content's own animation period (ms) — its rendered play length. */
  periodMs: number;
  /** When in the master loop this layer's animation begins (ms from the loop origin). */
  startMs: number;
  /** The master loop's total period (ms). */
  masterMs: number;
  /**
   * Timeline mode (default `"hold"`). See {@link EmbeddedTimelineMode}.
   */
  mode?: EmbeddedTimelineMode;
  /**
   * For `"stretch"`, the on-master window (ms) the content is scaled to fill.
   * Ignored by `"hold"` (plays at its natural `periodMs`) and `"loop"` (repeats
   * at `periodMs`). Defaults to `periodMs`.
   */
  windowMs?: number;
}

/** Format a number for CSS, dropping trailing zeros (`13.6`, not `13.600`). */
const fmt = (n: number): string => String(Number(n.toFixed(4)));

/** Clamp to the valid keyframe-percentage range. */
const clampPct = (p: number): number => (p < 0 ? 0 : p > 100 ? 100 : p);

/** Parse a CSS `<time>` token (`13.6s` / `1060ms`) to seconds, or `null`. */
function parseTimeSec(token: string): number | null {
  const m = /^(-?\d*\.?\d+)(ms|s)$/.exec(token.trim());
  if (m == null) return null;
  const v = parseFloat(m[1]);
  return m[2] === "ms" ? v / 1000 : v;
}

/** Split a CSS list on top-level commas (not inside parentheses). */
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

/** Tokenize one `animation:` shorthand entry on whitespace (respecting parens). */
function tokenizeEntry(entry: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of entry) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur !== "") tokens.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur !== "") tokens.push(cur);
  return tokens;
}

/**
 * Remap a single `@keyframes` block's stop percentages into the sub-window and
 * add the leading / trailing hold stops. `inner` is the block body (the stops);
 * returns the rewritten body.
 */
function remapKeyframeBody(inner: string, offsetPct: number, scale: number): string {
  const stopRe = /(from|to|[\d.]+%(?:\s*,\s*[\d.]+%)*)\s*\{([^{}]*)\}/g;
  const remapped: string[] = [];
  let firstDecls: string | null = null;
  let lastDecls: string | null = null;
  let minOrig = Infinity;
  let maxOrig = -Infinity;
  let m: RegExpExecArray | null;
  while ((m = stopRe.exec(inner)) != null) {
    const selector = m[1];
    const decls = m[2].trim();
    const newSelectors: string[] = [];
    for (const sel of selector.split(",")) {
      const s = sel.trim();
      const orig = s === "from" ? 0 : s === "to" ? 100 : parseFloat(s);
      if (orig < minOrig) {
        minOrig = orig;
        firstDecls = decls;
      }
      if (orig > maxOrig) {
        maxOrig = orig;
        lastDecls = decls;
      }
      newSelectors.push(`${fmt(clampPct(offsetPct + orig * scale))}%`);
    }
    remapped.push(`${newSelectors.join(", ")} { ${decls} }`);
  }
  if (firstDecls == null || lastDecls == null) return inner; // nothing parsed — leave as-is
  const head = `0% { ${firstDecls} }`;
  const tail = `100% { ${lastDecls} }`;
  return `${head} ${remapped.join(" ")} ${tail}`;
}

/**
 * Re-anchor a nested animated SVG so its internal timeline plays across the
 * `[startMs, startMs + periodMs]` window of the master loop and holds outside
 * it. See the module header for the full rationale. Returns the rewritten SVG;
 * a no-op (returns the input) when there is nothing to shift (the embedded
 * content already starts at the origin and fills the whole loop).
 */
export function offsetEmbeddedAnimatedSvgTimeline(svg: string, opts: OffsetTimelineOptions): string {
  const { periodMs, startMs, masterMs } = opts;
  if (masterMs <= 0 || periodMs <= 0) return svg;
  const mode: EmbeddedTimelineMode = opts.mode ?? "hold";
  const periodSec = periodMs / 1000;
  const masterSec = masterMs / 1000;
  const startSec = startMs / 1000;
  // `hold` plays at the natural rate (window = period); `stretch` time-scales the
  // content to fill `windowMs`. Both share the keyframe-remap path; only the
  // scale differs.
  const windowMs = mode === "stretch" ? (opts.windowMs ?? periodMs) : periodMs;
  const scale = windowMs / masterMs;
  const offsetPct = (startMs / masterMs) * 100;
  // Duration match tolerance — generous enough to absorb the animator's 2- vs
  // 3-decimal formatting, tight enough not to catch a distinct fixed period.
  const tol = Math.max(0.02, periodSec * 0.01);

  // `loop`: keep the content's own period; just delay its start to `startMs` and
  // hold frame 0 until then (`animation-fill-mode: backwards`). It then repeats
  // for the rest of the master loop. No keyframe remap.
  if (mode === "loop") {
    if (startMs <= 0) return svg; // already starts at the origin and loops
    return svg.replace(/<style>([\s\S]*?)<\/style>/g, (_full, css: string) => {
      const out = css.replace(/animation:\s*([^;}]+)/g, (full: string, value: string) => {
        const isPeriodMatch = splitTopLevel(value).some((entry) =>
          tokenizeEntry(entry).some((t) => {
            const sec = parseTimeSec(t);
            return sec != null && Math.abs(sec - periodSec) <= tol;
          }),
        );
        return isPeriodMatch ? `${full};animation-delay:${fmt(startSec)}s;animation-fill-mode:backwards` : full;
      });
      return `<style>${out}</style>`;
    });
  }

  // Nothing to do: content already starts at the origin and fills the loop.
  if (offsetPct <= 1e-6 && Math.abs(scale - 1) <= 1e-6) return svg;

  return svg.replace(/<style>([\s\S]*?)<\/style>/g, (_full, css: string) => {
    const retimed = new Set<string>();
    // Pass 1: retime matching animations + collect the keyframe names they drive.
    // Untouched declarations (e.g. a fixed-period cursor blink) are returned
    // byte-for-byte so only the retimed lines change.
    let out = css.replace(/animation:\s*([^;}]+)/g, (full: string, value: string) => {
      let changed = false;
      const entries = splitTopLevel(value).map((entry) => {
        const tokens = tokenizeEntry(entry);
        for (let i = 0; i < tokens.length; i++) {
          const sec = parseTimeSec(tokens[i]);
          if (sec == null) continue;
          if (Math.abs(sec - periodSec) <= tol) {
            const name = tokens.find((t) => parseTimeSec(t) == null && /^[A-Za-z_-][\w-]*$/.test(t) && !ANIM_KEYWORDS.has(t));
            if (name != null) {
              retimed.add(name);
              tokens[i] = `${fmt(masterSec)}s`;
              changed = true;
            }
          }
          break; // the first <time> in a shorthand entry is its duration
        }
        return tokens.join(" ");
      });
      return changed ? `animation:${entries.join(",")}` : full;
    });
    // Pass 2: remap the keyframes those animations drive.
    out = out.replace(
      /@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g,
      (full: string, name: string, inner: string) =>
        retimed.has(name) ? `@keyframes ${name} { ${remapKeyframeBody(inner, offsetPct, scale)} }` : full,
    );
    return `<style>${out}</style>`;
  });
}

/** Animation-shorthand keywords that are never the `animation-name`. */
const ANIM_KEYWORDS = new Set<string>([
  "linear", "ease", "ease-in", "ease-out", "ease-in-out", "step-start", "step-end",
  "infinite", "normal", "reverse", "alternate", "alternate-reverse",
  "none", "forwards", "backwards", "both", "running", "paused",
]);

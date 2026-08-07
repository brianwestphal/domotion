// Prototype: font fallback at SHAPED-CLUSTER granularity (flag-gated, default
// OFF — see docs/113-cluster-granularity-fallback.md).
//
// Blink does not decide fallback per codepoint. It shapes the whole segment
// with the current font and re-queues only the clusters whose glyphs came back
// `.notdef` (`ExtractShapeResults`, `platform/fonts/shaping/harfbuzz_shaper.cc:627-787`,
// rev 7d859f27). The next font for a re-queued cluster is chosen from ONE hint
// character of that cluster (`ChooseHintIndex`,
// `platform/fonts/font_fallback_iterator.cc:242-262`: the first hint character
// with a real script value, else the first; each hint character is asked of the
// system at most once, `:275-277`). Domotion's shipping path decides per
// codepoint from cmap coverage BEFORE any shaping (`splitTextIntoFontRuns`,
// `text-to-path.ts`), which diverges from Chrome in both directions —
// measured with CDP `CSS.getPlatformFontsForNode` against Chromium 139:
//
//   - "x" + U+0951 in Helvetica: Chrome paints BOTH glyphs from Helvetica (the
//     mark is Helvetica's .notdef tofu — the cluster's hint char is `x`,
//     CoreText answers Helvetica, the iterator refuses the duplicate, and the
//     terminal commits `.notdef`). We paint a real mark from a Devanagari
//     fallback Chrome never consults.
//   - "ก" + U+0301 in Helvetica: Chrome paints BOTH glyphs from Thonburi (the
//     covered mark travels with its uncovered base and keeps its GPOS anchor).
//     We split mid-cluster: base from Thonburi, mark from Helvetica, anchor lost.
//
// This module is the measurement prototype for that mechanism: enable with
// `DOMOTION_CLUSTER_FALLBACK=1`. It returns null whenever it declines (no
// HarfBuzz-openable primary face, shaping error), and the caller falls back to
// the shipping per-codepoint path — so with the flag OFF nothing here runs at
// all, and with it ON a decline is never a crash.
//
// Known prototype deviations from Blink, documented in docs/113 §prototype:
//   - re-queued ranges are shaped WITHOUT surrounding text context (Blink fills
//     the full text into the hb buffer with an item offset/length, so joining
//     context survives across the commit/requeue boundary);
//   - the declared-family walk is collapsed into `resolveFontForCodepoint`
//     asked for the cluster's hint character (Blink tries each declared family
//     against the cluster even when it lacks the hint character's glyph);
//   - `kUnmatchedVSGlyphId` (variation-selector re-cycling) and the U+3000
//     synthesized-space special case are not modeled;
//   - webfont primaries decline (no exported bytes->face seam here yet).

import {
  FontInstance, FontRun,
  getFontInstance, getFontSourceInfo, shapingFaceFor,
  resolveFontForCodepoint, FontVariantEmojiOverride,
} from "./font-resolution.js";
import { harfbuzzShapeRun } from "./harfbuzz-shaper.js";

/** Flag gate. Read per call so tests can toggle via env. */
export function clusterFallbackEnabled(): boolean {
  return process.env.DOMOTION_CLUSTER_FALLBACK === "1";
}

// Armed-mechanism proof for A/B runs: a flag being on is not evidence the
// mechanism executed (the Windows live resolver shipped "default-on" and inert
// for months). `DOMOTION_CLUSTER_FALLBACK_DEBUG=1` prints the counters at exit
// so a zero-delta A/B can be distinguished from an A/B that never took the path.
let _invoked = 0;
let _accepted = 0;
export function _clusterFallbackCounters(): { invoked: number; accepted: number } {
  return { invoked: _invoked, accepted: _accepted };
}
if (process.env.DOMOTION_CLUSTER_FALLBACK_DEBUG === "1") {
  process.on("exit", () => {
    console.error(`[cluster-fallback] invoked=${_invoked} accepted=${_accepted}`);
  });
}

interface QueueRange { start: number; end: number }
interface Assignment { start: number; end: number; key: string; font: FontInstance; isPrimary: boolean }

/** Common/Inherited have no "likely script" — `Character::HasLikelyScript` is
 *  `uscript_hasScript` beyond USCRIPT_COMMON/INHERITED; the practical test
 *  Blink's hint selection needs is exactly "not Common, not Inherited". */
const RE_COMMON_OR_INHERITED = /^[\p{Script=Common}\p{Script=Inherited}]$/u;
function hasLikelyScript(cp: number): boolean {
  return !RE_COMMON_OR_INHERITED.test(String.fromCodePoint(cp));
}

/** `ChooseHintIndex` (`font_fallback_iterator.cc:242-262`, rev 7d859f27):
 *  first index >= 1 with a likely script, else 0. */
export function chooseHintIndex(hintList: number[]): number {
  if (hintList.length <= 1) return 0;
  for (let i = 1; i < hintList.length; i++) {
    if (hasLikelyScript(hintList[i])) return i;
  }
  return 0;
}

/** `CollectFallbackHintChars` with `needs_hint_list == false`
 *  (`harfbuzz_shaper.cc:789-845`): walk the queued ranges in order, pushing
 *  codepoints, and stop as soon as one has a definite (non-Common/Inherited)
 *  script. */
export function collectHintChars(text: string, queue: QueueRange[]): number[] {
  const hints: number[] = [];
  for (const r of queue) {
    let i = r.start;
    while (i < r.end) {
      const cp = text.codePointAt(i)!;
      hints.push(cp);
      if (hasLikelyScript(cp)) return hints;
      i += String.fromCodePoint(cp).length;
    }
  }
  return hints;
}

/** Resolve the on-disk face HarfBuzz can open for a font key/instance — the
 *  same derivation the NFD reroute uses (`harfbuzzShapedScriptOverride`). */
function hbFaceFor(
  inst: FontInstance | null, key: string, weight: number, fontSize: number, slant: number,
  variationSettings: Record<string, number> | undefined,
): { path: string; faceIndex: number | null; axes: Record<string, number> | null } | null {
  const src = getFontSourceInfo(inst);
  if (src != null && src.nameMatched && src.faceIndex != null) {
    return { path: src.path, faceIndex: src.faceIndex, axes: src.variationAxes ?? null };
  }
  return shapingFaceFor(key, weight, fontSize, slant, variationSettings) ?? null;
}

/**
 * Shape-then-requeue split: the Blink `ShapeSegment` loop
 * (`harfbuzz_shaper.cc:965-1144`) ported to run-splitting granularity. Returns
 * the per-font run assignment Blink's mechanism produces, or null to decline
 * (caller uses the shipping per-codepoint path).
 *
 * The output contract matches `splitTextIntoFontRuns`: contiguous runs in
 * source order covering all of `text`.
 */
export function splitTextIntoFontRunsShaped(
  text: string,
  primaryFont: FontInstance,
  primaryFontKey: string,
  weight: number,
  fontSize: number,
  slant: number,
  variationSettings: Record<string, number> | undefined,
  lang: string | undefined,
  fontKeyChain: string[],
  systemUiPrimary: boolean = false,
  stretch: number = 100,
  fontVariantEmoji?: FontVariantEmojiOverride,
): FontRun[] | null {
  if (text.length === 0) return null;
  _invoked++;
  try {
    const runs = splitShapedInner(text, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain, systemUiPrimary, stretch, fontVariantEmoji);
    if (runs != null) _accepted++;
    return runs;
  } catch {
    // A prototype decline, never a crash: the shipping path takes over.
    return null;
  }
}

function splitShapedInner(
  text: string,
  primaryFont: FontInstance,
  primaryFontKey: string,
  weight: number,
  fontSize: number,
  slant: number,
  variationSettings: Record<string, number> | undefined,
  lang: string | undefined,
  fontKeyChain: string[],
  systemUiPrimary: boolean,
  stretch: number,
  fontVariantEmoji?: FontVariantEmojiOverride,
): FontRun[] | null {
  const primaryFace = hbFaceFor(primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings);
  if (primaryFace == null || primaryFace.faceIndex == null) return null;

  const assignments: Assignment[] = [];
  let queue: QueueRange[] = [{ start: 0, end: text.length }];

  // kFontGroupFonts: primary first, then the remaining declared families.
  const familyCycle: Array<{ key: string; font: FontInstance; isPrimary: boolean }> = [
    { key: primaryFontKey, font: primaryFont, isPrimary: true },
  ];
  for (const key of fontKeyChain) {
    if (key === primaryFontKey) continue;
    const inst = getFontInstance(key, weight, fontSize, slant);
    if (inst != null) familyCycle.push({ key, font: inst, isPrimary: false });
  }

  const triedKeys = new Set<string>();
  const previouslyAskedHints = new Set<number>();
  let familyIndex = 0;
  // Blink cycles fonts until the queue drains or the iterator gives up; the
  // bound is defensive (each cycle either shrinks the queue or exhausts a
  // stage, but a prototype should not be able to spin).
  const maxCycles = familyCycle.length + 32;

  for (let cycle = 0; cycle < maxCycles && queue.length > 0; cycle++) {
    // --- pick the cycle's font (FontFallbackIterator::Next port) ---
    let current: { key: string; font: FontInstance; isPrimary: boolean } | null = null;
    if (familyIndex < familyCycle.length) {
      current = familyCycle[familyIndex++];
    } else {
      // kSystemFonts: one hint character per cycle, asked at most once.
      const hints = collectHintChars(text, queue);
      if (hints.length === 0) break;
      const hint = hints[chooseHintIndex(hints)];
      if (previouslyAskedHints.has(hint)) break;
      previouslyAskedHints.add(hint);
      const res = resolveFontForCodepoint(hint, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain, systemUiPrimary, stretch, fontVariantEmoji);
      if (!res.covered) break;
      const font = res.fontOverride ?? (res.key === primaryFontKey ? primaryFont : getFontInstance(res.key, weight, fontSize, slant));
      if (font == null || triedKeys.has(res.key)) break; // duplicate → the iterator would refuse it; terminal
      current = { key: res.key, font, isPrimary: false };
    }
    if (current == null) break;
    if (triedKeys.has(current.key)) continue;
    triedKeys.add(current.key);

    const face = current.isPrimary
      ? primaryFace
      : hbFaceFor(current.font, current.key, weight, fontSize, slant, undefined);

    // --- shape every queued range with it; commit shaped clusters, requeue notdef ---
    const nextQueue: QueueRange[] = [];
    for (const range of queue) {
      const segText = text.slice(range.start, range.end);
      const shaped = face != null && face.faceIndex != null
        ? harfbuzzShapeRun(face.path, face.faceIndex, segText, undefined, fontSize, face.axes)
        : null;
      if (shaped == null || shaped.glyphs.length === 0) {
        // Unshapeable with this font — the whole range stays queued.
        nextQueue.push(range);
        continue;
      }
      // Per-cluster shaped/notdef verdict (`ExtractShapeResults` merge rule:
      // a cluster is shaped only if EVERY glyph mapped to it is non-zero).
      const clusterOk = new Map<number, boolean>();
      for (let g = 0; g < shaped.glyphs.length; g++) {
        const cl = shaped.clusters[g];
        const ok = shaped.glyphs[g].id !== 0;
        clusterOk.set(cl, (clusterOk.get(cl) ?? true) && ok);
      }
      // Cluster values → text sub-ranges (sorted; buffer order may be RTL).
      const clusterStarts = [...clusterOk.keys()].sort((a, b) => a - b);
      for (let ci = 0; ci < clusterStarts.length; ci++) {
        const clStart = clusterStarts[ci];
        const clEnd = ci + 1 < clusterStarts.length ? clusterStarts[ci + 1] : segText.length;
        const abs = { start: range.start + clStart, end: range.start + clEnd };
        if (clusterOk.get(clStart)) {
          assignments.push({ ...abs, key: current.key, font: current.font, isPrimary: current.isPrimary });
        } else {
          nextQueue.push(abs);
        }
      }
    }
    // Coalesce adjacent requeued ranges so the next cycle shapes maximal
    // stretches (Blink requeues maximal same-state slices by construction).
    nextQueue.sort((a, b) => a.start - b.start);
    queue = [];
    for (const r of nextQueue) {
      const last = queue[queue.length - 1];
      if (last != null && last.end === r.start) last.end = r.end;
      else queue.push({ ...r });
    }
  }

  // Terminal: whatever is still queued paints the FIRST candidate's `.notdef`
  // (`kFirstCandidateForNotdefGlyph` — Blink re-returns the first font so ITS
  // .notdef paints, `font_fallback_iterator.cc:160-171`).
  for (const r of queue) {
    assignments.push({ start: r.start, end: r.end, key: primaryFontKey, font: primaryFont, isPrimary: true });
  }

  // Assemble contiguous, source-ordered runs; merge adjacent same-font spans.
  assignments.sort((a, b) => a.start - b.start);
  // Contract check: the assignment must tile [0, text.length) exactly.
  let cursor = 0;
  for (const a of assignments) {
    if (a.start !== cursor) return null;
    cursor = a.end;
  }
  if (cursor !== text.length) return null;

  const runs: FontRun[] = [];
  for (const a of assignments) {
    const last = runs[runs.length - 1];
    if (last != null && last.fontKey === a.key && last.font === a.font && last.endIdx === a.start) {
      last.endIdx = a.end;
      last.text = text.slice(last.startIdx, a.end);
    } else {
      runs.push({ fontKey: a.key, font: a.font, text: text.slice(a.start, a.end), startIdx: a.start, endIdx: a.end, isPrimary: a.isPrimary });
    }
  }
  return runs;
}

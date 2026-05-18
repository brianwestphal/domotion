/**
 * Frame merge: deduplicate elements across animation frames.
 *
 * The scene runner captures one full SVG per frame. Adjacent frames share
 * most of their content (e.g. a terminal prompt that's visible the whole
 * scene, or characters of typed text that stay on-screen once typed). Naively
 * emitting every frame atomically means:
 *   - visible flicker: shared elements fade out + back in at every crossfade
 *     because CSS blends the two frame groups instead of holding the shared
 *     pixels still
 *   - huge file sizes: the same `<g>`, `<use>`, `<rect>` markup is repeated
 *     N times across N frames
 *
 * This module diffs frames at the element tree level and produces a compact
 * structure where each element appears exactly once, with a CSS-driven
 * visibility timeline. Elements that stay visible the whole scene have
 * opacity: 1 always (no animation). Elements that appear partway and persist
 * get a simple "visible from frame K" timeline. Elements that show up in only
 * a subset of frames get a precise timeline.
 *
 * The parser is deliberately minimal — the generator in dom-to-svg.ts
 * produces a predictable dialect of SVG so we can get away without a full
 * XML parser. We handle tags with balanced open/close, self-closing tags,
 * attributes with double-quoted values, and PCDATA. That's it.
 */

// ── Parser ──────────────────────────────────────────────────────────────────

export interface ParsedNode {
  kind: "element" | "text";
  /** For element nodes. */
  tag?: string;
  /** Raw attribute string as it appeared on the source element (e.g. ` id="x" fill="red"`). */
  rawAttrs?: string;
  /** Parsed attrs (lowercase keys). */
  attrs?: Record<string, string>;
  children?: ParsedNode[];
  selfClosing?: boolean;
  /** For text nodes. */
  text?: string;
  /** Full serialized form — stable for identity hashing. */
  raw: string;
}

/** Parse a (well-formed) SVG fragment into a list of top-level siblings. */
export function parseSiblings(src: string): ParsedNode[] {
  const nodes: ParsedNode[] = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] === "<") {
      if (src.startsWith("<!--", i)) {
        const end = src.indexOf("-->", i);
        if (end === -1) throw new Error("frame-merge parse: unterminated comment");
        i = end + 3;
        continue;
      }
      const [node, next] = parseElement(src, i);
      nodes.push(node);
      i = next;
    } else if (/\s/.test(src[i])) {
      i++;
    } else {
      // Loose text between tags — rare at top level in our generator output.
      const start = i;
      while (i < src.length && src[i] !== "<") i++;
      const text = src.slice(start, i);
      if (text.trim().length > 0) {
        nodes.push({ kind: "text", text, raw: text });
      }
    }
  }
  return nodes;
}

function parseElement(src: string, start: number): [ParsedNode, number] {
  // Assume src[start] === "<".
  const tagStart = start + 1;
  const gtEnd = src.indexOf(">", tagStart);
  if (gtEnd === -1) throw new Error("frame-merge parse: unterminated tag");
  const tagAndAttrs = src.slice(tagStart, gtEnd);
  const selfClosing = tagAndAttrs.endsWith("/");
  const tagBody = selfClosing ? tagAndAttrs.slice(0, -1).trimEnd() : tagAndAttrs;
  const firstSpace = tagBody.search(/\s/);
  const tag = firstSpace === -1 ? tagBody : tagBody.slice(0, firstSpace);
  const rawAttrs = firstSpace === -1 ? "" : tagBody.slice(firstSpace);
  const attrs = parseAttrs(rawAttrs);

  if (selfClosing) {
    const raw = src.slice(start, gtEnd + 1);
    return [{ kind: "element", tag, rawAttrs, attrs, children: [], selfClosing: true, raw }, gtEnd + 1];
  }

  // Consume children until </tag>.
  let i = gtEnd + 1;
  const children: ParsedNode[] = [];
  const closeToken = `</${tag}>`;
  while (i < src.length) {
    if (src.startsWith(closeToken, i)) {
      const end = i + closeToken.length;
      const raw = src.slice(start, end);
      return [{ kind: "element", tag, rawAttrs, attrs, children, selfClosing: false, raw }, end];
    }
    if (src[i] === "<") {
      if (src.startsWith("<!--", i)) {
        const endC = src.indexOf("-->", i);
        if (endC === -1) throw new Error("frame-merge parse: unterminated comment");
        i = endC + 3;
        continue;
      }
      const [child, next] = parseElement(src, i);
      children.push(child);
      i = next;
    } else {
      // Text content.
      const ts = i;
      while (i < src.length && src[i] !== "<") i++;
      const text = src.slice(ts, i);
      if (text.length > 0) {
        children.push({ kind: "text", text, raw: text });
      }
    }
  }
  throw new Error(`frame-merge parse: missing ${closeToken}`);
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /\s+([\w:-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out[m[1]] = m[2];
  }
  return out;
}

// ── Identity / fingerprinting ──────────────────────────────────────────────

/**
 * A "structural fingerprint" for cross-frame matching: two nodes with the
 * same fingerprint are treated as the same logical element even if their
 * inner content (or some attributes) differ.
 *
 * We match on tag + position-identifying attributes. `transform` is the
 * primary positioner in our generator output. Role/fill identify visual
 * "slots" without tying to the text content (aria-label changes per frame as
 * typing progresses — excluding it lets us merge).
 *
 * `id` is included because it's an identity attribute: two `<path id="g113"
 * d="X"/>` and `<path id="g198" d="X"/>` glyph defs are NOT the same logical
 * element even if their geometry is identical (fontkit emits matching path
 * data for visually-identical glyphs at different code points). Without
 * including `id`, those two defs would collapse into one and `<use href="#g198"/>`
 * references would break — see frame-merge.test.ts "preserves distinct ids
 * for paths with identical d".
 *
 * Resource references (`clip-path`, `mask`, `filter`) are included because
 * they point at frame-scoped defs whose IDs are unique per frame. Two
 * wrappers with different clip-path ids are NOT the same logical element
 * even if every other attribute matches — merging them would (a) drop one
 * frame's clip-path entirely, and (b) push that frame's unique content
 * into the merge bucket of a different frame, which then sorts as one
 * earlier-firstFrame group and lets later-frame siblings (e.g. solid
 * background rects) emit *after* the content they should sit underneath.
 * See frame-merge.test.ts "keeps per-frame body bg ordered before content".
 */
export function structuralFingerprint(n: ParsedNode): string {
  if (n.kind === "text") return `T:${n.text}`;
  const a = n.attrs ?? {};
  const keyAttrs = [
    "id", "transform", "href", "x", "y", "d", "width", "height",
    "fill", "role", "class", "clip-path", "mask", "filter",
  ];
  const pairs = keyAttrs.filter((k) => a[k] != null).map((k) => `${k}=${a[k]}`);
  return `${n.tag}|${pairs.join(",")}`;
}

// ── Merge ───────────────────────────────────────────────────────────────────

export interface MergeResult {
  /**
   * CSS `@keyframes` blocks to append to the animated SVG's style sheet. One
   * block per unique visibility timeline class.
   */
  css: string;
  /**
   * A single `<g>` subtree representing the merged, de-duplicated content
   * across all frames. Elements carry a `class` attribute linking them to
   * their timeline keyframe when they're not always-visible.
   */
  merged: string;
}

interface FrameTimingModel {
  /** 0..100 percent at which frame i becomes fully visible. */
  startPct: number[];
  /** 0..100 percent at which frame i begins fading out. */
  holdEndPct: number[];
  /** 0..100 percent at which frame i is fully faded out. */
  transEndPct: number[];
}

/**
 * Merge parallel frames of SVG top-level content into a single de-duplicated
 * element tree with CSS visibility timelines.
 *
 * @param framesSvg  The svgContent of each frame (the inner markup that the
 *                   animator would otherwise wrap in `<g class="f f-N">`).
 * @param timing     Per-frame timing (computed by the animator) used to build
 *                   the visibility keyframes.
 * @param classPrefix Unique prefix for timeline class names to avoid colliding
 *                   with other CSS in the same SVG.
 */
export function mergeFrames(
  framesSvg: string[],
  timing: FrameTimingModel,
  classPrefix: string = "t",
): MergeResult {
  const frameNodes = framesSvg.map((s) => parseSiblings(s));

  // Build a "virtual root" per frame whose children are the top-level siblings.
  const rootsPerFrame: ParsedNode[] = frameNodes.map((siblings) => ({
    kind: "element",
    tag: "__root__",
    rawAttrs: "",
    attrs: {},
    children: siblings,
    selfClosing: false,
    raw: "",
  }));

  // Assign each unique timeline (set of visible frames) to a class name.
  const timelineClasses = new Map<string, string>(); // key = "0,1,2,3" → class "t0"
  const timelineCss: string[] = [];
  const totalFrames = framesSvg.length;

  const getTimelineClass = (visibleFrames: number[]): string => {
    const key = visibleFrames.join(",");
    const existing = timelineClasses.get(key);
    if (existing != null) return existing;
    if (visibleFrames.length === totalFrames) {
      // Always visible — no class needed.
      timelineClasses.set(key, "");
      return "";
    }
    const name = `${classPrefix}${timelineClasses.size}`;
    timelineClasses.set(key, name);
    timelineCss.push(buildTimelineKeyframes(name, visibleFrames, timing));
    return name;
  };

  const merged = mergeNode(rootsPerFrame, getTimelineClass);
  // mergeNode returns the inner content of the virtual root.
  return { css: timelineCss.join("\n"), merged };
}

/**
 * Recursively merge the CHILDREN of a set of parallel nodes (one per frame),
 * returning the merged inner-content string. If the inputs are the top-level
 * virtual roots, the returned string is the merged scene (siblings).
 *
 * Invariant: all inputs share the same structural fingerprint (the caller
 * already matched them).
 */
function mergeNode(
  perFrame: ParsedNode[],
  getClass: (visibleFrames: number[]) => string,
  /**
   * When true, do not apply visibility classes to children. Used for
   * `<defs>` content (glyph paths, gradients, clipPaths) — these are
   * referenced by `<use>` elements in visible groups, so they must
   * always be defined regardless of which frames they originated from.
   * Applying a class would hide the def's contents during other frames
   * and break the references.
   */
  alwaysVisible: boolean = false,
): string {
  // Collect child groups. Each group = children at the same "slot" across
  // frames that share a fingerprint. For frames lacking a matching child at
  // that slot, we record an absence.
  //
  // Matching strategy: walk each frame's children in order; for each unique
  // fingerprint, collect the indices of frames it appears in and the raw
  // content per frame. This preserves scene order (new elements append at
  // the end).
  interface ChildGroup {
    /** Fingerprint shared by all occurrences. */
    fingerprint: string;
    /** Per-frame occurrence, or null if the frame lacks this child. */
    occurrences: Array<ParsedNode | null>;
    /** First frame index that contains this child (for ordering). */
    firstFrame: number;
    /** Child order within its first-containing frame (for ordering). */
    firstPosition: number;
  }

  const groupsByFp = new Map<string, ChildGroup>();
  perFrame.forEach((parent, frameIdx) => {
    const children = parent.children ?? [];
    children.forEach((child, pos) => {
      const fp = structuralFingerprint(child);
      let group = groupsByFp.get(fp);
      if (group == null) {
        group = {
          fingerprint: fp,
          occurrences: new Array(perFrame.length).fill(null),
          firstFrame: frameIdx,
          firstPosition: pos,
        };
        groupsByFp.set(fp, group);
      }
      // If multiple matches in same frame, prefer the first.
      if (group.occurrences[frameIdx] == null) {
        group.occurrences[frameIdx] = child;
      }
    });
  });

  // Sort groups by (firstFrame, firstPosition) so new additions appear in the
  // order they first showed up.
  const groups = [...groupsByFp.values()].sort((a, b) => {
    if (a.firstFrame !== b.firstFrame) return a.firstFrame - b.firstFrame;
    return a.firstPosition - b.firstPosition;
  });

  const parts: string[] = [];
  for (const g of groups) {
    const visibleFrames = g.occurrences.map((o, i) => (o != null ? i : -1)).filter((i) => i >= 0);
    const contents = g.occurrences.filter((o) => o != null) as ParsedNode[];

    // Fast path: this element is byte-identical across all its occurrences.
    const raws = new Set(contents.map((c) => c.raw));
    if (raws.size === 1) {
      const cls = alwaysVisible ? "" : getClass(visibleFrames);
      parts.push(renderWithClass(contents[0], cls));
      continue;
    }

    // Slow path: same fingerprint but differing inner content — try recursing.
    const firstKind = contents[0].kind;
    if (firstKind !== "element" || contents.some((c) => c.kind !== "element")) {
      // Text nodes with differing text, or mixed kinds — just keep them
      // per-frame (each with its own timeline).
      for (const [frameIdx, occ] of g.occurrences.entries()) {
        if (occ == null) continue;
        const cls = getClass([frameIdx]);
        parts.push(renderWithClass(occ, cls));
      }
      continue;
    }

    // For element nodes: recurse into children. Use the FIRST occurrence's
    // wrapper attributes (aria-label, title text, etc. diverge across frames,
    // but the wrapper is logically "the same slot").
    const wrapper = contents[0];
    const perFrameChildrenParents: ParsedNode[] = g.occurrences.map((occ) => {
      if (occ != null && occ.kind === "element") return occ;
      // For frames where this slot is absent, use an empty placeholder so the
      // recursion sees no children for that frame.
      return { kind: "element", tag: wrapper.tag ?? "g", rawAttrs: "", attrs: {}, children: [], selfClosing: false, raw: "" };
    });

    // Children of `<defs>` are reusable resources (glyph paths, gradients,
    // clipPaths) referenced by `<use>` from visible groups. They must always
    // be defined regardless of which frames they originated from, otherwise
    // a `<use>` from one frame referencing a def introduced in another frame
    // would render nothing.
    const childAlwaysVisible = alwaysVisible || wrapper.tag === "defs";
    const innerMerged = mergeNode(perFrameChildrenParents, getClass, childAlwaysVisible);
    const visibilityClass = alwaysVisible ? "" : getClass(visibleFrames);
    const merged: string = renderWrapperWithInner(wrapper, innerMerged, visibilityClass);
    parts.push(merged);
  }

  return parts.join("\n");
}

function renderWithClass(n: ParsedNode, cls: string): string {
  if (n.kind === "text") return n.text ?? "";
  if (cls === "") return n.raw;
  return injectClass(n, cls);
}

function renderWrapperWithInner(wrapper: ParsedNode, inner: string, cls: string): string {
  if (wrapper.kind !== "element") return wrapper.raw;
  const attrs = cls === "" ? (wrapper.rawAttrs ?? "") : mergeClassInAttrs(wrapper.rawAttrs ?? "", cls);
  const open = `<${wrapper.tag}${attrs}>`;
  const close = `</${wrapper.tag}>`;
  return `${open}${inner}${close}`;
}

function injectClass(n: ParsedNode, cls: string): string {
  if (n.kind !== "element") return n.raw;
  const attrs = mergeClassInAttrs(n.rawAttrs ?? "", cls);
  if (n.selfClosing === true) return `<${n.tag}${attrs}/>`;
  // Preserve children verbatim.
  const inner = (n.children ?? []).map((c) => c.raw).join("");
  return `<${n.tag}${attrs}>${inner}</${n.tag}>`;
}

function mergeClassInAttrs(rawAttrs: string, cls: string): string {
  if (cls === "") return rawAttrs;
  // If there's already a class attribute, append to it.
  const classMatch = /\sclass="([^"]*)"/.exec(rawAttrs);
  if (classMatch != null) {
    const merged = `${classMatch[1]} ${cls}`;
    return rawAttrs.replace(classMatch[0], ` class="${merged}"`);
  }
  return `${rawAttrs} class="${cls}"`;
}

// ── Timeline CSS ────────────────────────────────────────────────────────────

/**
 * Build an @keyframes block that makes the given class visible (opacity 1)
 * during exactly the given set of frames, and invisible otherwise.
 *
 * Visibility windows are contiguous ranges of frames (e.g. [3,4,5] → visible
 * from frame 3's startPct to frame 5's transEndPct). The produced rule uses
 * `animation-timing-function: step-end` so there's no interpolation — the
 * class flips on and off instantly at frame boundaries. This is what we want
 * for "character appears at this frame and stays" semantics, and it avoids
 * the cross-fade artifact that caused the original flicker bug.
 */
function buildTimelineKeyframes(name: string, visibleFrames: number[], timing: FrameTimingModel): string {
  // Collapse visible frames into contiguous ranges.
  const ranges: Array<[number, number]> = [];
  let rangeStart: number | null = null;
  let prev: number | null = null;
  for (const f of visibleFrames) {
    if (rangeStart == null) {
      rangeStart = f;
      prev = f;
    } else if (prev != null && f === prev + 1) {
      prev = f;
    } else {
      if (prev != null) ranges.push([rangeStart, prev]);
      rangeStart = f;
      prev = f;
    }
  }
  if (rangeStart != null && prev != null) ranges.push([rangeStart, prev]);

  // Build keyframe stops. Use step-end so opacity switches instantly.
  // DM-599: emit a paint-skip toggle alongside opacity so the browser can
  // skip painting elements that aren't currently in their visible-frames
  // window. DM-641: this was `display: none/inline`, which broke for any
  // element whose 0% keyframe is `display: none` — Chromium parks the
  // animation when the element drops out of the render tree and never
  // ticks the keyframe that would bring it back. Switching to
  // `visibility` keeps the element rendered (still no paint) so the
  // animation continues across cycles.
  const stops: Array<[number, number]> = []; // (pct, opacity)
  stops.push([0, 0]);
  for (const [lo, hi] of ranges) {
    const onPct = timing.startPct[lo];
    const offPct = timing.transEndPct[hi];
    // Ensure monotonic increase (shouldn't happen out of order given visible
    // frames are sorted, but guard anyway).
    if (stops[stops.length - 1][0] < onPct) stops.push([Math.max(0, onPct - 0.001), 0]);
    stops.push([onPct, 1]);
    stops.push([Math.min(100, offPct), 1]);
    stops.push([Math.min(100, offPct + 0.001), 0]);
  }
  stops.push([100, 0]);

  const lines = stops.map(([p, o]) =>
    `      ${p.toFixed(3)}% { opacity: ${o}; visibility: ${o === 1 ? "visible" : "hidden"}; }`,
  );
  return `    @keyframes ${name} {\n${lines.join("\n")}\n    }\n    .${name} { animation: ${name} var(--scene-dur) infinite; animation-timing-function: step-end; }`;
}

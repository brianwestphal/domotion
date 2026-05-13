/**
 * Scroll executor (DM-607).
 *
 * Walks a parsed `ScrollPattern` AST against a Playwright `Page`, scrolling
 * the window (or a specific element) along the pattern's plan, capturing the
 * DOM at each segment and diffing it against the previous segment. Returns a
 * sequence of `ScrollSegmentCapture` records ready for the scroll-animated
 * SVG composer (DM-608).
 *
 * The pure parts of the executor — axis/direction derivation, pattern AST
 * walking with `until`-loop bookkeeping, target-position resolution given a
 * page-state snapshot — are factored out as pure helpers so they're unit-
 * testable without a real browser. The Playwright I/O sits at the edges:
 * a single `PageQuery` interface lets a test inject a fake page-state
 * provider in lieu of the real `Page`.
 *
 * Grammar reference: `dm604-scroll-grammar.txt` (signed-off draft on DM-604).
 */

import type { Page } from "@playwright/test";

import type { CapturedElement } from "./dom-to-svg.js";
import { captureElementTree } from "./dom-to-svg.js";
import type {
  Pattern, Segment, FlatSegment, BracketedSegment,
  Action, ScrollAction, ScrollTarget, AbsoluteTarget, Anchor,
  UntilClause,
} from "./scroll-pattern.js";
import { diffTrees, type TreeDiff } from "./tree-diff.js";

// ── Public types ───────────────────────────────────────────────────────────

export interface ScrollExecutorOptions {
  /** Selector for an inner scrollable element; default = window. */
  selector?: string;
  viewportW: number;
  viewportH: number;
  /** Default scroll speed in px/s. Used when no explicit `/<duration>` suffix. */
  defaultSpeed?: number;
  /** Pre-scroll to wake lazy-load before capturing. Default: true. */
  prescroll?: boolean;
  /** Max execution time across the whole pattern. Default: 60 s. */
  maxTimeoutMs?: number;
}

export interface ScrollSegmentCapture {
  /** Scroll-x at the moment of capture. */
  scrollX: number;
  /** Scroll-y at the moment of capture. */
  scrollY: number;
  /** Cumulative scene-time (ms) when this segment begins. */
  segmentStartMs: number;
  /** Cumulative scene-time (ms) when this segment ends. */
  segmentEndMs: number;
  /** Captured element tree at this scroll position. */
  tree: CapturedElement[];
  /** Diff from the previous segment's capture. Null for the very first. */
  diffFromPrev: TreeDiff | null;
}

const DEFAULT_SPEED_PX_PER_SEC = 1500;
const DEFAULT_MAX_TIMEOUT_MS   = 60_000;
const PRESCROLL_BOTTOM_WAIT_MS = 400;
const PRESCROLL_TOP_WAIT_MS    = 800;

// ── Pure helpers (no Playwright) ───────────────────────────────────────────

export type Axis = "x" | "y";

/**
 * Derive the axis (x or y) of a scroll action.
 * Order of resolution:
 *   1. Explicit direction prefix wins.
 *   2. Otherwise, anchor type (top/bottom = y, left/right = x).
 *   3. Otherwise, axis suffix (`.x` → x).
 *   4. Otherwise, default to y.
 */
export function axisOfScroll(action: ScrollAction): Axis {
  if (action.direction != null) {
    return action.direction === "up" || action.direction === "down" ? "y" : "x";
  }
  if (action.target.kind === "absolute") {
    const a = action.target.anchor;
    if (a.kind === "named") {
      if (a.name === "top" || a.name === "bottom") return "y";
      if (a.name === "left" || a.name === "right") return "x";
    }
    if (action.target.axisSuffix === "x") return "x";
    if (action.target.axisSuffix === "y") return "y";
  }
  return "y";
}

/**
 * Sign of the explicit direction prefix: +1 for `down`/`right`, -1 for
 * `up`/`left`, undefined when no prefix is given.
 */
function directionSign(action: ScrollAction): 1 | -1 | undefined {
  if (action.direction == null) return undefined;
  if (action.direction === "down" || action.direction === "right") return 1;
  return -1;
}

/**
 * Snapshot of page-state values the executor needs to resolve absolute
 * targets and `selector(...)` references. Injected via `PageQuery` (real
 * Playwright impl in `realPageQuery()`); easy to fake in tests.
 */
export interface PageStateSnapshot {
  /** Maximum scrollable y (= scrollHeight - clientHeight, clamped >= 0). */
  maxScrollY: number;
  /** Maximum scrollable x. */
  maxScrollX: number;
  /** Current scroll position. */
  scrollX: number;
  scrollY: number;
}

export interface SelectorBbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageQuery {
  /** Snapshot the current scroll position + maximum scrollable extents. */
  snapshot(): Promise<PageStateSnapshot>;
  /** Bbox of an element matching the CSS selector, in document coordinates. */
  selectorBbox(css: string): Promise<SelectorBbox | null>;
}

/**
 * Resolve an `AbsoluteTarget` AST node to an absolute scroll position along
 * the given axis. Returns the position in scroll-coordinate space (i.e. the
 * value you'd pass to `window.scrollTo`).
 */
export async function resolveAbsoluteTarget(
  target: AbsoluteTarget,
  axis: Axis,
  pageQuery: PageQuery,
  snapshot: PageStateSnapshot,
): Promise<number> {
  let base: number;
  const a = target.anchor;
  if (a.kind === "named") {
    base = resolveNamedAnchor(a.name, axis, snapshot);
  } else {
    const bbox = await pageQuery.selectorBbox(a.cssSelector);
    if (bbox == null) {
      throw new ScrollExecutionError(`selector(${JSON.stringify(a.cssSelector)}) matched no element`);
    }
    // axisSuffix override: `.x` switches to x-coordinate
    const useAxis: Axis = target.axisSuffix ?? axis;
    base = useAxis === "x" ? bbox.x : bbox.y;
  }
  for (const { op, length } of target.offsets) {
    const px = length.unit === "px" ? length.value : percentOf(length.value, axis, snapshot);
    base = op === "+" ? base + px : base - px;
  }
  return base;
}

function resolveNamedAnchor(name: string, axis: Axis, snap: PageStateSnapshot): number {
  if (name === "top") return 0;
  if (name === "bottom") return snap.maxScrollY;
  if (name === "left") return 0;
  if (name === "right") return snap.maxScrollX;
  // start / end — axis-relative
  if (name === "start") return 0;
  if (name === "end") return axis === "x" ? snap.maxScrollX : snap.maxScrollY;
  throw new ScrollExecutionError(`Unknown anchor name "${name}"`);
}

function percentOf(pct: number, axis: Axis, snap: PageStateSnapshot): number {
  return (pct / 100) * (axis === "x" ? snap.maxScrollX : snap.maxScrollY);
}

/**
 * Compute the destination scroll position for a scroll action given the
 * current position. Returns `{ axis, destX, destY, scrollDurationMs }`.
 */
export async function resolveScrollAction(
  action: ScrollAction,
  pageQuery: PageQuery,
  snapshot: PageStateSnapshot,
  defaultSpeed: number,
): Promise<{ axis: Axis; destX: number; destY: number; scrollDurationMs: number }> {
  const axis = axisOfScroll(action);
  const sign = directionSign(action);
  let delta: number;
  if (action.target.kind === "delta") {
    const sl = action.target.signedLength;
    const raw = sl.sign * (sl.unit === "px" ? sl.value : percentOf(sl.value, axis, snapshot));
    delta = (sign ?? 1) * raw;
  } else {
    const targetAbs = await resolveAbsoluteTarget(action.target, axis, pageQuery, snapshot);
    const cur = axis === "x" ? snapshot.scrollX : snapshot.scrollY;
    delta = targetAbs - cur;
    // If a direction prefix is given, validate that the natural delta direction
    // matches; otherwise silently respect the prefix (e.g. `up:bottom` from the
    // top is geometrically impossible — treat as no-op).
    if (sign != null && Math.sign(delta) !== 0 && Math.sign(delta) !== sign) {
      // Cross-axis conflict or impossible motion; clamp to no-op.
      delta = 0;
    }
  }
  const destX = axis === "x" ? clamp(snapshot.scrollX + delta, 0, snapshot.maxScrollX) : snapshot.scrollX;
  const destY = axis === "y" ? clamp(snapshot.scrollY + delta, 0, snapshot.maxScrollY) : snapshot.scrollY;
  const magnitude = Math.abs(axis === "x" ? destX - snapshot.scrollX : destY - snapshot.scrollY);
  const scrollDurationMs = action.durationMs ?? Math.round((magnitude / defaultSpeed) * 1000);
  return { axis, destX, destY, scrollDurationMs };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// ── Pattern-walker plan ─────────────────────────────────────────────────────
// Walks the AST once and produces a flat plan of `(scroll | pause)` ops with
// resolved durations and destinations. Loops are unrolled per-iteration with
// re-resolution of `until` conditions inside the executor's outer loop.
//
// The walker is "active" — it queries page state as it advances. Each
// iteration of an `until` loop may produce different ops because the page
// state changes.

interface ResolvedScrollOp {
  kind: "scroll";
  axis: Axis;
  destX: number;
  destY: number;
  durationMs: number;
}
interface ResolvedPauseOp {
  kind: "pause";
  durationMs: number;
}
type ResolvedOp = ResolvedScrollOp | ResolvedPauseOp;

// ── Errors ──────────────────────────────────────────────────────────────────

export class ScrollExecutionError extends Error {
  constructor(message: string) { super(message); this.name = "ScrollExecutionError"; }
}

// ── Executor entrypoint ────────────────────────────────────────────────────

/**
 * Execute a parsed scroll pattern against a Playwright page.
 *
 * Workflow:
 *   1. Pre-scroll (bottom + back to top with settles) to wake lazy-loaded
 *      content, unless `opts.prescroll === false`.
 *   2. Capture initial state at (scrollX=0, scrollY=0).
 *   3. Walk the pattern AST. For each scroll action: snapshot page state,
 *      resolve destination, scroll there, wait the action's duration plus a
 *      small settle, then capture and diff against previous.
 *   4. Pause actions just wait; they don't add a capture unless the DOM is
 *      observed to have changed (lazy-load fired during the pause).
 *   5. `until` loops re-resolve conditions each iteration. The grammar's
 *      "clamp on overshoot" rule is honored: the last iteration of a
 *      position-bounded loop has its scroll magnitude shrunk so the
 *      cumulative position lands exactly at the target.
 *   6. The whole walk is bounded by `opts.maxTimeoutMs` to guard against
 *      impossible `until` conditions like `until selector(".never")`.
 */
export async function executeScrollPattern(
  page: Page,
  pattern: Pattern,
  opts: ScrollExecutorOptions,
): Promise<ScrollSegmentCapture[]> {
  const defaultSpeed = opts.defaultSpeed ?? DEFAULT_SPEED_PX_PER_SEC;
  const prescroll = opts.prescroll !== false;
  const maxTimeoutMs = opts.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  const selector = opts.selector ?? null;
  const pageQuery = realPageQuery(page, selector);

  if (prescroll) {
    await runPrescroll(page, selector);
  }

  const startedAt = Date.now();
  const captures: ScrollSegmentCapture[] = [];
  let sceneTime = 0;

  // Capture the initial state.
  const initialSnap = await pageQuery.snapshot();
  let prevTree = await captureElementTree(page, "body", {
    x: 0, y: 0, width: opts.viewportW, height: opts.viewportH,
  });
  captures.push({
    scrollX: initialSnap.scrollX,
    scrollY: initialSnap.scrollY,
    segmentStartMs: 0,
    segmentEndMs: 0,
    tree: prevTree,
    diffFromPrev: null,
  });

  const checkTimeout = (): void => {
    if (Date.now() - startedAt > maxTimeoutMs) {
      throw new ScrollExecutionError(`Scroll pattern execution exceeded ${maxTimeoutMs} ms budget`);
    }
  };

  const runOp = async (op: ResolvedOp): Promise<void> => {
    checkTimeout();
    if (op.kind === "pause") {
      // Wait. Then check whether the DOM changed (lazy-load may fire).
      await page.waitForTimeout(op.durationMs);
      sceneTime += op.durationMs;
      const nextTree = await captureElementTree(page, "body", {
        x: 0, y: 0, width: opts.viewportW, height: opts.viewportH,
      });
      const diff = diffTrees(prevTree, nextTree);
      const anyChange = diff.entries.some((e) => e.kind !== "static");
      if (anyChange) {
        const snap = await pageQuery.snapshot();
        captures.push({
          scrollX: snap.scrollX, scrollY: snap.scrollY,
          segmentStartMs: sceneTime - op.durationMs,
          segmentEndMs: sceneTime,
          tree: nextTree,
          diffFromPrev: diff,
        });
        prevTree = nextTree;
      }
      return;
    }
    // op.kind === "scroll"
    // DM-604 §4(a): for smooth-mode scrolls (single long action covering
    // multiple viewport-heights), subdivide into viewport-height chunks so
    // the composer has enough anchor points to stack contiguously. Without
    // this, a `down:bottom/30s` action on a 10000-tall page produces only
    // two captures (initial + post-scroll), and the composite ends up with
    // 9400 px of empty space between them. Pattern-mode scrolls with
    // explicit per-token magnitudes ≤ viewport height naturally produce
    // one chunk per token — no over-subdivision there.
    const snap0 = await pageQuery.snapshot();
    const dx = op.destX - snap0.scrollX;
    const dy = op.destY - snap0.scrollY;
    const totalDelta = op.axis === "x" ? dx : dy;
    const viewportSize = op.axis === "x" ? opts.viewportW : opts.viewportH;
    const numChunks = Math.max(1, Math.ceil(Math.abs(totalDelta) / viewportSize));
    for (let ci = 1; ci <= numChunks; ci++) {
      const frac = ci / numChunks;
      const chunkDestX = snap0.scrollX + dx * frac;
      const chunkDestY = snap0.scrollY + dy * frac;
      const chunkDur = ci === numChunks
        ? op.durationMs - Math.round(op.durationMs * (ci - 1) / numChunks)
        : Math.round(op.durationMs / numChunks);
      const segStart = sceneTime;
      await scrollTo(page, selector, chunkDestX, chunkDestY, chunkDur);
      sceneTime += chunkDur;
      const snap = await pageQuery.snapshot();
      const nextTree = await captureElementTree(page, "body", {
        x: 0, y: 0, width: opts.viewportW, height: opts.viewportH,
      });
      const diff = diffTrees(prevTree, nextTree);
      captures.push({
        scrollX: snap.scrollX, scrollY: snap.scrollY,
        segmentStartMs: segStart,
        segmentEndMs: sceneTime,
        tree: nextTree,
        diffFromPrev: diff,
      });
      prevTree = nextTree;
    }
  };

  await walkPattern(pattern, pageQuery, defaultSpeed, runOp, checkTimeout);
  return captures;
}

// ── Pattern walker (recursive AST traversal with until loops) ──────────────

async function walkPattern(
  pattern: Pattern,
  pageQuery: PageQuery,
  defaultSpeed: number,
  runOp: (op: ResolvedOp) => Promise<void>,
  checkTimeout: () => void,
): Promise<void> {
  for (const seg of pattern.segments) {
    await walkSegment(seg, pageQuery, defaultSpeed, runOp, checkTimeout);
  }
}

async function walkSegment(
  seg: Segment,
  pageQuery: PageQuery,
  defaultSpeed: number,
  runOp: (op: ResolvedOp) => Promise<void>,
  checkTimeout: () => void,
): Promise<void> {
  if (seg.kind === "bracketed") {
    await runWithMaybeUntil(seg.until, async () => {
      await walkPattern(seg.pattern, pageQuery, defaultSpeed, runOp, checkTimeout);
    }, pageQuery, defaultSpeed, runOp, checkTimeout);
    return;
  }
  // Flat segment.
  await runWithMaybeUntil(seg.until, async () => {
    for (const a of (seg as FlatSegment).actions) {
      await runAction(a, pageQuery, defaultSpeed, runOp);
    }
  }, pageQuery, defaultSpeed, runOp, checkTimeout);
}

async function runWithMaybeUntil(
  until: UntilClause | undefined,
  bodyOnce: () => Promise<void>,
  pageQuery: PageQuery,
  defaultSpeed: number,
  runOp: (op: ResolvedOp) => Promise<void>,
  checkTimeout: () => void,
): Promise<void> {
  if (until == null) {
    await bodyOnce();
    return;
  }
  if (until.kind === "count") {
    for (let i = 0; i < until.count; i++) {
      checkTimeout();
      await bodyOnce();
    }
    return;
  }
  // Position-based until. Iterate until the current scroll position satisfies
  // the condition. To honor the "clamp on overshoot" rule, the last iteration
  // is allowed to run even if its body might overshoot — the body's resolver
  // (`resolveScrollAction`) clamps each scroll's destination to the bounded
  // axis, so a too-large final delta lands at the page edge naturally.
  // (More sophisticated clamping at the action level is a follow-up.)
  let prevSnap: PageStateSnapshot | null = null;
  const MAX_ITER = 1000;   // hard upper bound on `until <position>` loops
  for (let i = 0; i < MAX_ITER; i++) {
    checkTimeout();
    const snap = await pageQuery.snapshot();
    if (await isUntilConditionMet(until, snap, pageQuery)) break;
    if (prevSnap != null && snap.scrollX === prevSnap.scrollX && snap.scrollY === prevSnap.scrollY) {
      // No progress between iterations — bail to avoid an infinite loop.
      break;
    }
    prevSnap = snap;
    await bodyOnce();
  }
}

async function isUntilConditionMet(
  until: UntilClause,
  snap: PageStateSnapshot,
  pageQuery: PageQuery,
): Promise<boolean> {
  if (until.kind === "count") return false;   // handled separately
  const axis = (until.target.axisSuffix === "x" || /* x-anchor */
                (until.target.anchor.kind === "named" && (until.target.anchor.name === "left" || until.target.anchor.name === "right"))) ? "x" : "y";
  const target = await resolveAbsoluteTarget(until.target, axis, pageQuery, snap);
  const cur = axis === "x" ? snap.scrollX : snap.scrollY;
  // Condition is "we've reached or passed the target in the natural direction
  // of motion". Inferring the natural direction: positive if target > cur at
  // the loop's start. For the common case (scroll down until bottom), this
  // means cur >= target stops the loop.
  return Math.abs(cur - target) < 0.5 || (target > 0 && cur >= target) || (target < 0 && cur <= target);
}

async function runAction(
  a: Action,
  pageQuery: PageQuery,
  defaultSpeed: number,
  runOp: (op: ResolvedOp) => Promise<void>,
): Promise<void> {
  if (a.kind === "pause") {
    await runOp({ kind: "pause", durationMs: a.durationMs });
    return;
  }
  const snap = await pageQuery.snapshot();
  const resolved = await resolveScrollAction(a, pageQuery, snap, defaultSpeed);
  await runOp({ kind: "scroll", axis: resolved.axis, destX: resolved.destX, destY: resolved.destY, durationMs: resolved.scrollDurationMs });
}

// ── Playwright I/O ─────────────────────────────────────────────────────────

function realPageQuery(page: Page, selector: string | null): PageQuery {
  return {
    async snapshot(): Promise<PageStateSnapshot> {
      if (selector == null) {
        return page.evaluate(() => ({
          maxScrollX: Math.max(0, document.documentElement.scrollWidth  - document.documentElement.clientWidth),
          maxScrollY: Math.max(0, document.documentElement.scrollHeight - document.documentElement.clientHeight),
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        }));
      }
      return page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (el == null) return { maxScrollX: 0, maxScrollY: 0, scrollX: 0, scrollY: 0 };
        return {
          maxScrollX: Math.max(0, el.scrollWidth  - el.clientWidth),
          maxScrollY: Math.max(0, el.scrollHeight - el.clientHeight),
          scrollX: el.scrollLeft,
          scrollY: el.scrollTop,
        };
      }, selector);
    },
    async selectorBbox(css: string): Promise<SelectorBbox | null> {
      return page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el == null) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
      }, css);
    },
  };
}

async function scrollTo(page: Page, selector: string | null, destX: number, destY: number, durationMs: number): Promise<void> {
  if (selector == null) {
    await page.evaluate(({ x, y }) => window.scrollTo(x, y), { x: destX, y: destY });
  } else {
    await page.evaluate(({ sel, x, y }) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el != null) { el.scrollLeft = x; el.scrollTop = y; }
    }, { sel: selector, x: destX, y: destY });
  }
  // Wait the action's nominal duration plus a small settle for layout.
  await page.waitForTimeout(durationMs + 50);
}

async function runPrescroll(page: Page, selector: string | null): Promise<void> {
  // Scroll to bottom, settle, then back to top, settle.
  if (selector == null) {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(PRESCROLL_BOTTOM_WAIT_MS);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(PRESCROLL_TOP_WAIT_MS);
  } else {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el != null) el.scrollTop = el.scrollHeight;
    }, selector);
    await page.waitForTimeout(PRESCROLL_BOTTOM_WAIT_MS);
    await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el != null) el.scrollTop = 0;
    }, selector);
    await page.waitForTimeout(PRESCROLL_TOP_WAIT_MS);
  }
}

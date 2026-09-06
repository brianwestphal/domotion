import type { Page } from "@playwright/test";
import type { CursorEvent, CursorOverlay } from "../animation/cursor-overlay.js";
import { StudioInteractionError, resolveStudioSemanticTarget, type StudioSemanticPlan } from "./interactions.js";

export interface StudioCursorPoint { x: number; y: number }
export interface StudioCursorBox extends StudioCursorPoint { width: number; height: number }

export interface StudioCursorTargetEvidence {
  eventId: string;
  kind: "click" | "hover" | "type" | "scrollTo" | "drag";
  atMs: number;
  path: string;
  box?: StudioCursorBox;
  destinationBox?: StudioCursorBox;
  destinationPoint?: StudioCursorPoint;
  cursor: string;
  button?: "left" | "middle" | "right";
  clickCount?: number;
  viewport: { width: number; height: number };
}

export interface StudioCursorEventOverride {
  point?: StudioCursorPoint;
  destinationPoint?: StudioCursorPoint;
  durationMs?: number;
  dragDurationMs?: number;
  dwellMs?: number;
  controlPoint?: StudioCursorPoint;
  samples?: number;
}

export interface PlanStudioCursorChoreographyOptions {
  seed?: string | number;
  leadInMs?: number;
  edgePadding?: number;
  start?: StudioCursorPoint;
  overrides?: Readonly<Record<string, StudioCursorEventOverride>>;
}

export interface StudioCursorInteractionTiming {
  eventId: string;
  authoredAtMs: number;
  presentedAtMs: number;
  point: StudioCursorPoint;
  destinationPoint?: StudioCursorPoint;
}

export interface StudioCursorChoreography {
  overlay: CursorOverlay;
  interactions: readonly StudioCursorInteractionTiming[];
  durationMs: number;
  timeOffsetMs: number;
}

async function inspectBox(page: Page, locator: Awaited<ReturnType<typeof resolveStudioSemanticTarget>>, path: string, eventId: string): Promise<StudioCursorBox> {
  const box = await locator.boundingBox();
  if (box == null) throw new StudioInteractionError(path, "target has no rendered border box; make it visible before cursor choreography is captured", eventId);
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

/** Read actual live DOM geometry and computed cursor CSS for every visual event. */
export async function inspectStudioCursorTargets(page: Page, plan: StudioSemanticPlan): Promise<StudioCursorTargetEvidence[]> {
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const evidence: StudioCursorTargetEvidence[] = [];
  for (const step of plan.steps) {
    const event = step.event;
    if (event.kind === "waitForState" || event.kind === "scriptHook") continue;
    if (event.kind === "scrollTo" && event.target == null) {
      evidence.push({ eventId: event.id, kind: event.kind, atMs: event.atMs, path: step.path, cursor: "default", viewport });
      continue;
    }
    const target = event.target;
    if (target == null) continue;
    const locator = await resolveStudioSemanticTarget(page, target, `${step.path}.target`, event.id);
    const [box, cursor] = await Promise.all([
      inspectBox(page, locator, `${step.path}.target`, event.id),
      locator.evaluate((element) => getComputedStyle(element).cursor || "default"),
    ]);
    let destinationBox: StudioCursorBox | undefined;
    let destinationPoint: StudioCursorPoint | undefined;
    if (event.kind === "drag") {
      if ("target" in event.to) {
        const destination = await resolveStudioSemanticTarget(page, event.to.target, `${step.path}.to.target`, event.id);
        destinationBox = await inspectBox(page, destination, `${step.path}.to.target`, event.id);
      } else destinationPoint = event.to.point;
    }
    evidence.push({
      eventId: event.id,
      kind: event.kind,
      atMs: event.atMs,
      path: step.path,
      box,
      destinationBox,
      destinationPoint,
      cursor,
      viewport,
      ...(event.kind === "click" ? { button: event.button, clickCount: event.clickCount } : {}),
    });
  }
  return evidence;
}

function hashSeed(seed: string | number): number {
  const value = String(seed);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0 || 1;
}

function randomSource(seed: string | number): () => number {
  let state = hashSeed(seed);
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

function finiteNumber(value: number | undefined, label: string, minimum = 0): void {
  if (value != null && (!Number.isFinite(value) || value < minimum)) {
    throw new Error(`Studio cursor choreography ${label} must be a finite number >= ${minimum}`);
  }
}

function finitePoint(value: StudioCursorPoint | undefined, label: string): void {
  if (value != null && (!Number.isFinite(value.x) || !Number.isFinite(value.y))) {
    throw new Error(`Studio cursor choreography ${label} must contain finite x/y coordinates`);
  }
}

function bounded(point: StudioCursorPoint, viewport: { width: number; height: number }, padding: number): StudioCursorPoint {
  return {
    x: clamp(point.x, padding, viewport.width - padding),
    y: clamp(point.y, padding, viewport.height - padding),
  };
}

function aimAtBox(box: StudioCursorBox, random: () => number): StudioCursorPoint {
  const insetX = Math.min(box.width * 0.28, 18);
  const insetY = Math.min(box.height * 0.28, 14);
  const usableWidth = Math.max(0, box.width - insetX * 2);
  const usableHeight = Math.max(0, box.height - insetY * 2);
  return {
    x: box.x + insetX + usableWidth * (0.35 + random() * 0.3),
    y: box.y + insetY + usableHeight * (0.35 + random() * 0.3),
  };
}

function distance(a: StudioCursorPoint, b: StudioCursorPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function quadratic(a: StudioCursorPoint, control: StudioCursorPoint, b: StudioCursorPoint, t: number): StudioCursorPoint {
  const inverse = 1 - t;
  return {
    x: inverse * inverse * a.x + 2 * inverse * t * control.x + t * t * b.x,
    y: inverse * inverse * a.y + 2 * inverse * t * control.y + t * t * b.y,
  };
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

function defaultDuration(from: StudioCursorPoint, to: StudioCursorPoint, targetBox: StudioCursorBox | undefined): number {
  const travel = distance(from, to);
  const targetRelief = targetBox == null ? 0 : Math.min(100, Math.sqrt(targetBox.width * targetBox.height)) * 0.65;
  return Math.round(clamp(150 + travel * 0.72 - targetRelief, 180, 900));
}

function defaultControl(from: StudioCursorPoint, to: StudioCursorPoint, random: () => number): StudioCursorPoint {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const bend = Math.min(120, length * (0.12 + random() * 0.13)) * (random() < 0.5 ? -1 : 1);
  return { x: (from.x + to.x) / 2 - dy / length * bend, y: (from.y + to.y) / 2 + dx / length * bend };
}

function addCurve(
  events: CursorEvent[],
  from: StudioCursorPoint,
  to: StudioCursorPoint,
  startAt: number,
  durationMs: number,
  control: StudioCursorPoint,
  samples: number,
  cursor?: string,
): void {
  let previousTime = startAt;
  for (let index = 1; index <= samples; index++) {
    const fraction = index / samples;
    const point = index === samples ? to : quadratic(from, control, to, easeOutCubic(fraction));
    const time = startAt + durationMs * fraction;
    events.push({ type: "move", t: previousTime, duration: time - previousTime, to: point, cursor });
    previousTime = time;
  }
}

/** Convert inspected semantic targets into the existing CursorOverlay event model. */
export function planStudioCursorChoreography(
  evidence: readonly StudioCursorTargetEvidence[],
  options: PlanStudioCursorChoreographyOptions = {},
): StudioCursorChoreography {
  finiteNumber(options.leadInMs, "leadInMs");
  finiteNumber(options.edgePadding, "edgePadding");
  finitePoint(options.start, "start");
  if (evidence.length === 0) return { overlay: { events: [] }, interactions: [], durationMs: 0, timeOffsetMs: options.leadInMs ?? 500 };
  const random = randomSource(options.seed ?? evidence.map((item) => item.eventId).join("|"));
  const leadInMs = options.leadInMs ?? 500;
  const padding = options.edgePadding ?? 12;
  const first = evidence[0];
  const firstAim = first.box == null
    ? { x: first.viewport.width * 0.78, y: first.viewport.height * 0.62 }
    : aimAtBox(first.box, random);
  let current = bounded(options.start ?? { x: firstAim.x - Math.min(180, first.viewport.width * 0.22), y: firstAim.y + Math.min(90, first.viewport.height * 0.16) }, first.viewport, padding);
  let occupiedUntil = 0;
  const events: CursorEvent[] = [{ type: "show", t: 0, x: current.x, y: current.y }];
  const interactions: StudioCursorInteractionTiming[] = [];

  for (const item of evidence) {
    const override = options.overrides?.[item.eventId];
    finitePoint(override?.point, `override ${JSON.stringify(item.eventId)} point`);
    finitePoint(override?.destinationPoint, `override ${JSON.stringify(item.eventId)} destinationPoint`);
    finitePoint(override?.controlPoint, `override ${JSON.stringify(item.eventId)} controlPoint`);
    finiteNumber(override?.durationMs, `override ${JSON.stringify(item.eventId)} durationMs`, 1);
    finiteNumber(override?.dragDurationMs, `override ${JSON.stringify(item.eventId)} dragDurationMs`, 1);
    finiteNumber(override?.dwellMs, `override ${JSON.stringify(item.eventId)} dwellMs`);
    if (override?.samples != null && (!Number.isInteger(override.samples) || override.samples < 2 || override.samples > 32)) {
      throw new Error(`Studio cursor choreography override ${JSON.stringify(item.eventId)} samples must be an integer from 2 to 32`);
    }
    const rawAim = override?.point ?? (item.box == null
      ? { x: item.viewport.width * 0.78, y: item.viewport.height * (0.55 + random() * 0.16) }
      : aimAtBox(item.box, random));
    const aim = bounded(rawAim, item.viewport, padding);
    const durationMs = override?.durationMs ?? defaultDuration(current, aim, item.box);
    const dwellMs = override?.dwellMs ?? Math.round(70 + random() * 100);
    const earliestHit = item.atMs + leadInMs;
    const presentedAtMs = Math.max(earliestHit, occupiedUntil + durationMs + dwellMs);
    const startAt = presentedAtMs - durationMs - dwellMs;
    const control = bounded(override?.controlPoint ?? defaultControl(current, aim, random), item.viewport, padding);
    const samples = override?.samples ?? 8;
    addCurve(events, current, aim, startAt, durationMs, control, samples, item.cursor);

    let destinationPoint: StudioCursorPoint | undefined;
    if (item.kind === "click") {
      const button = item.button === "right" ? "secondary" : item.button === "middle" ? "middle" : "primary";
      const count = item.clickCount ?? 1;
      for (let clickIndex = 0; clickIndex < count; clickIndex++) {
        events.push({ type: "click", t: presentedAtMs + clickIndex * 80, button });
      }
      occupiedUntil = Math.max(occupiedUntil, presentedAtMs + (count - 1) * 80);
    } else if (item.kind === "type") events.push({ type: "click", t: presentedAtMs });
    if (item.kind === "drag") {
      const rawDestination = override?.destinationPoint ?? item.destinationPoint ?? (item.destinationBox == null ? undefined : aimAtBox(item.destinationBox, random));
      if (rawDestination != null) {
        destinationPoint = bounded(rawDestination, item.viewport, padding);
        const dragDuration = Math.max(240, override?.dragDurationMs ?? defaultDuration(aim, destinationPoint, item.destinationBox));
        const dragControl = bounded(override?.controlPoint ?? defaultControl(aim, destinationPoint, random), item.viewport, padding);
        addCurve(events, aim, destinationPoint, presentedAtMs, dragDuration, dragControl, samples, "grabbing");
        occupiedUntil = presentedAtMs + dragDuration;
        current = destinationPoint;
      }
    }
    if (item.kind !== "drag" || destinationPoint == null) {
      occupiedUntil = Math.max(occupiedUntil, presentedAtMs);
      current = aim;
    }
    interactions.push({ eventId: item.eventId, authoredAtMs: item.atMs, presentedAtMs, point: aim, destinationPoint });
  }
  return { overlay: { events }, interactions, durationMs: occupiedUntil, timeOffsetMs: leadInMs };
}

/** Inspect the live page, then produce deterministic choreography in one call. */
export async function buildStudioCursorChoreography(
  page: Page,
  plan: StudioSemanticPlan,
  options: PlanStudioCursorChoreographyOptions = {},
): Promise<StudioCursorChoreography> {
  return planStudioCursorChoreography(await inspectStudioCursorTargets(page, plan), options);
}

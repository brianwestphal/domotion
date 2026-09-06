import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { runActions, type AnimateAction } from "../cli/animate-orchestrator.js";
import {
  studioSemanticTrackSchema,
  type StudioSemanticEvent,
  type StudioSemanticTarget,
  type StudioSemanticTrack,
} from "./project-schema.js";

export interface StudioSemanticStep {
  path: string;
  trackId: string;
  event: StudioSemanticEvent;
}

export interface StudioSemanticPlan {
  steps: readonly StudioSemanticStep[];
  durationMs: number;
}

export class StudioInteractionError extends Error {
  readonly path: string;
  readonly eventId?: string;

  constructor(path: string, message: string, eventId?: string, options?: ErrorOptions) {
    super(`Studio interaction ${path}${eventId == null ? "" : ` (${eventId})`}: ${message}`, options);
    this.name = "StudioInteractionError";
    this.path = path;
    this.eventId = eventId;
  }
}

export interface CompileStudioSemanticTracksOptions {
  path?: string;
}

/** Validate and merge independently-authored tracks into one stable scene timeline. */
export function compileStudioSemanticTracks(
  rawTracks: unknown,
  options: CompileStudioSemanticTracksOptions = {},
): StudioSemanticPlan {
  const basePath = options.path ?? "$.tracks";
  const parsed = z.array(studioSemanticTrackSchema).safeParse(rawTracks);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const suffix = issue.path.map((part) => typeof part === "number" ? `[${part}]` : `.${String(part)}`).join("");
    throw new StudioInteractionError(`${basePath}${suffix}`, issue.message);
  }

  const seenIds = new Set<string>();
  const seenTrackIds = new Set<string>();
  const steps: Array<StudioSemanticStep & { trackIndex: number; eventIndex: number }> = [];
  parsed.data.forEach((track, trackIndex) => {
    if (seenTrackIds.has(track.id)) {
      throw new StudioInteractionError(`${basePath}[${trackIndex}].id`, `duplicate track id "${track.id}"`);
    }
    seenTrackIds.add(track.id);
    track.events.forEach((event, eventIndex) => {
      const path = `${basePath}[${trackIndex}].events[${eventIndex}]`;
      if (seenIds.has(event.id)) throw new StudioInteractionError(`${path}.id`, `duplicate event id "${event.id}"`, event.id);
      seenIds.add(event.id);
      steps.push({ path, trackId: track.id, event, trackIndex, eventIndex });
    });
  });
  steps.sort((a, b) => a.event.atMs - b.event.atMs || a.trackIndex - b.trackIndex || a.eventIndex - b.eventIndex);
  return {
    steps: steps.map(({ path, trackId, event }) => ({ path, trackId, event })),
    durationMs: steps.reduce((end, step) => Math.max(end, step.event.atMs + (step.event.durationMs ?? 0)), 0),
  };
}

function targetDescription(target: StudioSemanticTarget): string {
  if (target.role != null) return `role=${JSON.stringify(target.role)}${target.name == null ? "" : ` name=${JSON.stringify(target.name)}`}`;
  if (target.label != null) return `label=${JSON.stringify(target.label)}`;
  if (target.text != null) return `text=${JSON.stringify(target.text)}`;
  if (target.testId != null) return `testId=${JSON.stringify(target.testId)}`;
  if (target.domId != null) return `domId=${JSON.stringify(target.domId)}`;
  if (target.selector != null) return `selector=${JSON.stringify(target.selector)}`;
  return "empty target";
}

function locatorForTarget(page: Page, target: StudioSemanticTarget, path: string, eventId: string): Locator {
  if (target.role != null) {
    return page.getByRole(target.role as Parameters<Page["getByRole"]>[0], {
      ...(target.name == null ? {} : { name: target.name, exact: true }),
    });
  }
  if (target.name != null) {
    throw new StudioInteractionError(path, "`name` requires `role`; use `label` or `text` for a standalone semantic locator", eventId);
  }
  if (target.label != null) return page.getByLabel(target.label, { exact: true });
  if (target.text != null) return page.getByText(target.text, { exact: true });
  if (target.testId != null) return page.getByTestId(target.testId);
  if (target.domId != null) return page.locator(`[id=${JSON.stringify(target.domId)}]`);
  return page.locator(target.selector!);
}

/** Resolve one authored target against the live DOM and require one exact match. */
export async function resolveStudioSemanticTarget(
  page: Page,
  target: StudioSemanticTarget,
  path: string,
  eventId: string,
): Promise<Locator> {
  const locator = locatorForTarget(page, target, path, eventId);
  let count: number;
  try {
    count = await locator.count();
  } catch (error) {
    throw new StudioInteractionError(path, `could not resolve ${targetDescription(target)}: ${error instanceof Error ? error.message : String(error)}`, eventId, { cause: error });
  }
  if (count === 0) {
    throw new StudioInteractionError(path, `${targetDescription(target)} matched no element; check the live accessible role/name or add an explicit selector fallback`, eventId);
  }
  if (count > 1) {
    throw new StudioInteractionError(path, `${targetDescription(target)} is ambiguous (${count} matches); add an exact accessible name or a unique stable identifier`, eventId);
  }
  return locator;
}

const MARKER_ATTRIBUTE = "data-domotion-studio-target";
let markerCounter = 0;

interface MarkedTarget {
  locator: Locator;
  selector: string;
  cleanup: () => Promise<void>;
}

async function markTarget(page: Page, target: StudioSemanticTarget, path: string, eventId: string): Promise<MarkedTarget> {
  const locator = await resolveStudioSemanticTarget(page, target, path, eventId);

  const marker = `dm-${Date.now().toString(36)}-${markerCounter++}`;
  await locator.evaluate((element, value) => element.setAttribute("data-domotion-studio-target", value), marker);
  const selector = `[${MARKER_ATTRIBUTE}="${marker}"]`;
  return {
    locator,
    selector,
    cleanup: async () => {
      await page.locator(selector).evaluateAll((elements) => {
        elements.forEach((element) => element.removeAttribute("data-domotion-studio-target"));
      }).catch(() => {});
    },
  };
}

export interface StudioScriptHookContext {
  page: Page;
  hookId: string;
  input?: Record<string, unknown>;
  event: Extract<StudioSemanticEvent, { kind: "scriptHook" }>;
  path: string;
}

export interface RunStudioSemanticPlanOptions {
  log?: (message: string) => void;
  runHook?: (context: StudioScriptHookContext) => void | Promise<void>;
  now?: () => number;
}

export type RunStudioSemanticStepOptions = Pick<RunStudioSemanticPlanOptions, "log" | "runHook">;

async function runWaitForState(
  page: Page,
  target: MarkedTarget,
  event: Extract<StudioSemanticEvent, { kind: "waitForState" }>,
): Promise<void> {
  const timeout = event.timeoutMs ?? 5_000;
  if (event.state === "attached" || event.state === "detached" || event.state === "visible" || event.state === "hidden") {
    await target.locator.waitFor({ state: event.state, timeout });
    return;
  }
  await page.waitForFunction(
    ({ selector, state, value }) => {
      const element = document.querySelector(selector) as (HTMLElement & { checked?: boolean; disabled?: boolean }) | null;
      if (element == null) return false;
      const disabled = element.disabled === true || element.getAttribute("aria-disabled") === "true";
      const checked = element.checked === true || element.getAttribute("aria-checked") === "true";
      if (state === "enabled") return !disabled;
      if (state === "disabled") return disabled;
      if (state === "checked") return checked;
      if (state === "unchecked") return !checked;
      return (element.textContent ?? "").includes(value ?? "");
    },
    { selector: target.selector, state: event.state, value: event.value },
    { timeout },
  );
}

async function runTargetedEvent(
  page: Page,
  step: StudioSemanticStep,
  log: (message: string) => void,
): Promise<void> {
  const event = step.event;
  if (event.kind === "scriptHook") return;
  const eventTarget = event.target;
  if (eventTarget == null) {
    throw new StudioInteractionError(step.path, "internal plan error: positional scroll reached the targeted executor", event.id);
  }
  const target = await markTarget(page, eventTarget, `${step.path}.target`, event.id);
  try {
    let action: AnimateAction | null = null;
    if (event.kind === "click" && event.button == null && event.clickCount == null) {
      action = { type: "click", selector: target.selector };
    } else if (event.kind === "click") {
      await target.locator.click({ button: event.button, clickCount: event.clickCount });
    }
    else if (event.kind === "hover") action = { type: "hover", selector: target.selector };
    else if (event.kind === "scrollTo" && event.behavior !== "smooth") action = { type: "scrollIntoView", selector: target.selector };
    else if (event.kind === "scrollTo") {
      await target.locator.evaluate((element) => element.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    }
    else if (event.kind === "type" && event.durationMs == null) {
      const prefix = event.replace === false ? await target.locator.inputValue() : "";
      action = { type: "fill", selector: target.selector, value: `${prefix}${event.text}` };
    } else if (event.kind === "type") {
      if (event.replace !== false) await target.locator.fill("");
      const characters = Array.from(event.text).length;
      await target.locator.pressSequentially(event.text, { delay: characters === 0 ? 0 : event.durationMs! / characters });
    } else if (event.kind === "waitForState") {
      await runWaitForState(page, target, event);
    } else if (event.kind === "drag") {
      if ("target" in event.to) {
        const destination = await markTarget(page, event.to.target, `${step.path}.to.target`, event.id);
        try {
          await target.locator.dragTo(destination.locator);
        } finally {
          await destination.cleanup();
        }
      } else {
        const box = await target.locator.boundingBox();
        if (box == null) throw new StudioInteractionError(`${step.path}.target`, "drag source has no visible bounding box", event.id);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(event.to.point.x, event.to.point.y, { steps: 12 });
        await page.mouse.up();
      }
    }
    if (action != null) await runActions(page, [action], log);
  } finally {
    await target.cleanup();
  }
}

/** Execute one already-compiled semantic step immediately, without timeline waiting. */
export async function runStudioSemanticStep(
  page: Page,
  step: StudioSemanticStep,
  options: RunStudioSemanticStepOptions = {},
): Promise<void> {
  const log = options.log ?? (() => {});
  try {
    if (step.event.kind === "scriptHook") {
      if (options.runHook == null) {
        throw new StudioInteractionError(step.path, `script hook "${step.event.hookId}" requires an explicit runHook handler`, step.event.id);
      }
      await options.runHook({ page, hookId: step.event.hookId, input: step.event.input, event: step.event, path: step.path });
    } else if (step.event.kind === "scrollTo" && step.event.position != null) {
      await runActions(page, [{ type: "scroll", x: step.event.position.x, y: step.event.position.y }], log);
    } else {
      await runTargetedEvent(page, step, log);
    }
  } catch (error) {
    if (error instanceof StudioInteractionError) throw error;
    throw new StudioInteractionError(step.path, error instanceof Error ? error.message : String(error), step.event.id, { cause: error });
  }
}

/** Execute a compiled scene-relative plan against one live page, in timeline order. */
export async function runStudioSemanticPlan(
  page: Page,
  plan: StudioSemanticPlan,
  options: RunStudioSemanticPlanOptions = {},
): Promise<void> {
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const startedAt = now();
  for (const step of plan.steps) {
    const remaining = step.event.atMs - (now() - startedAt);
    if (remaining > 0) await runActions(page, [{ type: "wait", ms: remaining }], log);
    log(`Studio interaction ${step.event.id}: ${step.event.kind} at ${step.event.atMs}ms`);
    await runStudioSemanticStep(page, step, options);
  }
}

export async function runStudioSemanticTracks(
  page: Page,
  tracks: readonly StudioSemanticTrack[],
  options: RunStudioSemanticPlanOptions & CompileStudioSemanticTracksOptions = {},
): Promise<StudioSemanticPlan> {
  const plan = compileStudioSemanticTracks(tracks, options);
  await runStudioSemanticPlan(page, plan, options);
  return plan;
}

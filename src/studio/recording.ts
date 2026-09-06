import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { compileStudioSemanticTracks } from "./interactions.js";
import { validateStudioProject } from "./project.js";
import {
  studioIdSchema,
  studioSceneSchema,
  studioSemanticTargetSchema,
  type StudioProject,
  type StudioScene,
} from "./project-schema.js";

export const STUDIO_INTERACTION_RECORDING_FORMAT = "domotion-studio-interaction-recording" as const;
export const STUDIO_INTERACTION_RECORDING_VERSION = 1 as const;
export const STUDIO_REDACTED_VALUE = "[REDACTED]" as const;

const nonEmpty = z.string().trim().min(1);
const pointSchema = z.strictObject({ x: z.number(), y: z.number() });
const rectSchema = z.strictObject({ x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative() });

export const studioRecordedTargetSchema = z.strictObject({
  tag: nonEmpty,
  selector: nonEmpty,
  semantic: studioSemanticTargetSchema.optional(),
  text: z.string(),
  rect: rectSchema,
  styles: z.record(z.string(), z.string()),
  state: z.strictObject({
    checked: z.boolean().optional(),
    disabled: z.boolean().optional(),
    expanded: z.string().nullable().optional(),
  }),
  sensitive: z.boolean(),
});

const eventBase = {
  sequence: z.number().int().nonnegative(),
  atMs: z.number().nonnegative(),
  url: nonEmpty,
};

export const studioRecordedEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...eventBase,
    kind: z.literal("pointer"),
    phase: z.enum(["move", "down", "up", "click"]),
    point: pointSchema,
    button: z.number().int(),
    buttons: z.number().int().nonnegative(),
    target: studioRecordedTargetSchema.optional(),
  }),
  z.strictObject({
    ...eventBase,
    kind: z.literal("keyboard"),
    phase: z.enum(["down", "up"]),
    key: z.string(),
    code: z.string(),
    modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])),
    target: studioRecordedTargetSchema.optional(),
    redacted: z.boolean(),
  }),
  z.strictObject({
    ...eventBase,
    kind: z.literal("input"),
    value: z.string(),
    inputType: z.string().optional(),
    target: studioRecordedTargetSchema,
    redacted: z.boolean(),
  }).superRefine((event, ctx) => {
    if (event.target.sensitive && (!event.redacted || event.value !== STUDIO_REDACTED_VALUE)) {
      ctx.addIssue({ code: "custom", path: ["value"], message: "sensitive input must be redacted before it enters a recording" });
    }
  }),
  z.strictObject({
    ...eventBase,
    kind: z.literal("scroll"),
    position: pointSchema,
    target: studioRecordedTargetSchema.optional(),
  }),
  z.strictObject({
    ...eventBase,
    kind: z.literal("navigation"),
    navigationKind: z.enum(["initial", "push-state", "replace-state", "pop-state", "hash-change", "page-show"]),
  }),
  z.strictObject({
    ...eventBase,
    kind: z.literal("dom-feedback"),
    mutationCount: z.number().int().positive(),
    mutations: z.array(z.strictObject({
      kind: z.enum(["attributes", "characterData", "childList"]),
      attribute: z.string().optional(),
      targetSelector: z.string(),
      addedNodes: z.number().int().nonnegative(),
      removedNodes: z.number().int().nonnegative(),
    })).min(1),
    snapshots: z.array(studioRecordedTargetSchema),
  }),
]);

export const studioInteractionRecordingSchema = z.strictObject({
  format: z.literal(STUDIO_INTERACTION_RECORDING_FORMAT),
  version: z.literal(STUDIO_INTERACTION_RECORDING_VERSION),
  id: studioIdSchema,
  startedAt: z.string().datetime({ offset: true }),
  durationMs: z.number().nonnegative(),
  viewport: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() }).nullable(),
  sourceUrls: z.array(nonEmpty).min(1),
  redactions: z.number().int().nonnegative(),
  events: z.array(studioRecordedEventSchema),
}).superRefine((recording, ctx) => {
  let previousSequence = -1;
  let previousTime = -1;
  let observedRedactions = 0;
  recording.events.forEach((event, index) => {
    if (event.sequence <= previousSequence) ctx.addIssue({ code: "custom", path: ["events", index, "sequence"], message: "must increase monotonically" });
    if (event.atMs < previousTime) ctx.addIssue({ code: "custom", path: ["events", index, "atMs"], message: "must not move backwards" });
    previousSequence = event.sequence;
    previousTime = event.atMs;
    if ((event.kind === "input" || event.kind === "keyboard") && event.redacted) observedRedactions++;
  });
  if (recording.redactions !== observedRedactions) {
    ctx.addIssue({ code: "custom", path: ["redactions"], message: `must equal the ${observedRedactions} redacted recorded events` });
  }
});

export type StudioRecordedTarget = z.infer<typeof studioRecordedTargetSchema>;
export type StudioRecordedEvent = z.infer<typeof studioRecordedEventSchema>;
export type StudioInteractionRecording = z.infer<typeof studioInteractionRecordingSchema>;

interface BrowserRecorderOptions {
  bindingName: string;
  recorderKey: string;
  redactSelectors: string[];
  pointerMoveIntervalMs: number;
}

interface BrowserRawEvent {
  atEpochMs: number;
  url: string;
  kind: StudioRecordedEvent["kind"];
  [key: string]: unknown;
}

/** Self-contained browser payload; it runs in the recorded application, including after navigation. */
function installStudioRecorderInPage(options: BrowserRecorderOptions): void {
  const root = globalThis as unknown as Record<string, unknown>;
  // Keep the browser payload self-contained: Playwright serializes this
  // function without module-scope constants.
  const redactedValue = "[REDACTED]";
  if (root[options.recorderKey] != null) return;
  let active = true;
  let lastPointerMove = Number.NEGATIVE_INFINITY;
  let feedbackQueued = false;
  let pendingMutations: MutationRecord[] = [];
  const listeners: Array<() => void> = [];
  const emit = (event: Record<string, unknown>): void => {
    if (!active) return;
    const binding = root[options.bindingName] as ((value: Record<string, unknown>) => Promise<void>) | undefined;
    void binding?.({ atEpochMs: Date.now(), url: sanitizeUrl(location.href), ...event });
  };
  const listen = <K extends keyof WindowEventMap>(target: Window | Document, type: K, handler: (event: WindowEventMap[K]) => void, capture = true): void => {
    target.addEventListener(type, handler as EventListener, capture);
    listeners.push(() => target.removeEventListener(type, handler as EventListener, capture));
  };
  const safeMatches = (element: Element, selector: string): boolean => {
    try { return element.matches(selector) || element.closest(selector) != null; } catch { return false; }
  };
  const sensitive = (element: Element): boolean => {
    if (options.redactSelectors.some((selector) => safeMatches(element, selector))) return true;
    if (element.closest("[data-domotion-redact]") != null) return true;
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
    const input = element as HTMLInputElement;
    const autocomplete = input.autocomplete.toLowerCase();
    return input.type === "password" || /(?:password|cc-|one-time-code|token|secret)/.test(autocomplete);
  };
  const selectorFor = (element: Element): string => {
    if (element.id !== "") return `#${CSS.escape(element.id)}`;
    const testId = element.getAttribute("data-testid");
    if (testId != null && testId !== "") return `[data-testid=${JSON.stringify(testId)}]`;
    const name = element.getAttribute("name");
    if (name != null && name !== "") return `${element.localName}[name=${JSON.stringify(name)}]`;
    const parts: string[] = [];
    for (let current: Element | null = element; current != null && current !== document.documentElement && parts.length < 6; current = current.parentElement) {
      const siblings = current.parentElement == null ? [] : [...current.parentElement.children].filter((item) => item.localName === current!.localName);
      parts.unshift(siblings.length > 1 ? `${current.localName}:nth-of-type(${siblings.indexOf(current) + 1})` : current.localName);
    }
    return `html > ${parts.join(" > ")}`;
  };
  const nativeRole = (element: Element): string | undefined => {
    const explicit = element.getAttribute("role")?.trim();
    if (explicit) return explicit.split(/\s+/)[0];
    if (element instanceof HTMLButtonElement) return "button";
    if (element instanceof HTMLAnchorElement && element.hasAttribute("href")) return "link";
    if (element instanceof HTMLTextAreaElement) return "textbox";
    if (element instanceof HTMLSelectElement) return "combobox";
    if (element instanceof HTMLInputElement) {
      if (["button", "submit", "reset"].includes(element.type)) return "button";
      if (element.type === "checkbox") return "checkbox";
      if (element.type === "radio") return "radio";
      return "textbox";
    }
    return undefined;
  };
  const labelText = (element: Element): string | undefined => {
    const control = element as HTMLInputElement;
    const labels = "labels" in control && control.labels != null ? [...control.labels] : [];
    const text = labels.map((label) => label.textContent?.trim() ?? "").filter(Boolean).join(" ");
    return text || undefined;
  };
  const snapshot = (element: Element): StudioRecordedTarget => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const isSensitive = sensitive(element);
    const role = nativeRole(element);
    const label = labelText(element);
    const name = element.getAttribute("aria-label")?.trim()
      || (role === "button" || role === "link" ? element.textContent?.trim() : undefined)
      || undefined;
    const testId = element.getAttribute("data-testid")?.trim() || undefined;
    const domId = element.id || undefined;
    const textValue = isSensitive ? redactedValue : (element.textContent ?? "").trim().slice(0, 500);
    const semantic = role != null && name != null
      ? { role, name, ...(testId == null ? {} : { testId }), ...(domId == null ? {} : { domId }), selector: selectorFor(element) }
      : label != null ? { label, ...(testId == null ? {} : { testId }), ...(domId == null ? {} : { domId }), selector: selectorFor(element) }
        : testId != null ? { testId, selector: selectorFor(element) }
          : domId != null ? { domId, selector: selectorFor(element) }
            : textValue !== "" ? { text: textValue, selector: selectorFor(element) }
              : { selector: selectorFor(element) };
    const control = element as HTMLInputElement;
    return {
      tag: element.localName,
      selector: selectorFor(element),
      semantic,
      text: textValue,
      rect: { x: rect.x, y: rect.y, width: Math.max(0, rect.width), height: Math.max(0, rect.height) },
      styles: {
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        color: style.color,
        backgroundColor: style.backgroundColor,
        cursor: style.cursor,
        pointerEvents: style.pointerEvents,
        position: style.position,
        transform: style.transform,
        transition: style.transition,
      },
      state: {
        ...(typeof control.checked === "boolean" && ["checkbox", "radio"].includes(control.type) ? { checked: control.checked } : {}),
        ...(typeof control.disabled === "boolean" ? { disabled: control.disabled } : {}),
        ...(element.hasAttribute("aria-expanded") ? { expanded: element.getAttribute("aria-expanded") } : {}),
      },
      sensitive: isSensitive,
    };
  };
  const targetElement = (target: EventTarget | null): Element | null => target instanceof Element ? target : null;
  const sanitizeUrl = (raw: string): string => {
    try {
      const url = new URL(raw, location.href);
      for (const key of [...url.searchParams.keys()]) {
        if (/(?:token|secret|password|passwd|key|session|code)/i.test(key)) url.searchParams.set(key, redactedValue);
      }
      if (/(?:token|secret|password|passwd)=/i.test(url.hash)) url.hash = "#redacted";
      return url.href;
    } catch { return raw; }
  };
  const targetPayload = (event: Event): { target?: StudioRecordedTarget } => {
    const element = targetElement(event.target);
    return element == null ? {} : { target: snapshot(element) };
  };

  for (const phase of ["pointerdown", "pointerup", "click"] as const) {
    listen(document, phase, (event) => emit({
      kind: "pointer",
      phase: phase === "pointerdown" ? "down" : phase === "pointerup" ? "up" : "click",
      point: { x: event.clientX, y: event.clientY },
      button: event.button,
      buttons: event.buttons,
      ...targetPayload(event),
    }));
  }
  listen(document, "pointermove", (event) => {
    if (event.timeStamp - lastPointerMove < options.pointerMoveIntervalMs) return;
    lastPointerMove = event.timeStamp;
    emit({ kind: "pointer", phase: "move", point: { x: event.clientX, y: event.clientY }, button: event.button, buttons: event.buttons, ...targetPayload(event) });
  });
  for (const phase of ["keydown", "keyup"] as const) {
    listen(document, phase, (event) => {
      const element = targetElement(event.target);
      const redacted = element != null && sensitive(element);
      emit({
        kind: "keyboard",
        phase: phase === "keydown" ? "down" : "up",
        key: redacted && event.key.length === 1 ? redactedValue : event.key,
        code: event.code,
        modifiers: [event.altKey ? "Alt" : "", event.ctrlKey ? "Control" : "", event.metaKey ? "Meta" : "", event.shiftKey ? "Shift" : ""].filter(Boolean),
        redacted,
        ...(element == null ? {} : { target: snapshot(element) }),
      });
    });
  }
  listen(document, "input", (event) => {
    const element = targetElement(event.target);
    if (element == null) return;
    const redacted = sensitive(element);
    const input = element as HTMLInputElement;
    emit({
      kind: "input",
      value: redacted ? redactedValue : ("value" in input ? String(input.value) : element.textContent ?? ""),
      inputType: event instanceof InputEvent ? event.inputType : undefined,
      target: snapshot(element),
      redacted,
    });
  });
  listen(document, "scroll", (event) => {
    const element = targetElement(event.target);
    const owner = element === document.documentElement || element === document.body ? undefined : element;
    emit({
      kind: "scroll",
      position: owner == null ? { x: scrollX, y: scrollY } : { x: owner.scrollLeft, y: owner.scrollTop },
      ...(owner == null ? {} : { target: snapshot(owner) }),
    });
  });

  const navigation = (navigationKind: "initial" | "push-state" | "replace-state" | "pop-state" | "hash-change" | "page-show"): void => emit({ kind: "navigation", navigationKind });
  const historyPush = history.pushState.bind(history);
  const historyReplace = history.replaceState.bind(history);
  history.pushState = (...args: Parameters<History["pushState"]>) => { historyPush(...args); navigation("push-state"); };
  history.replaceState = (...args: Parameters<History["replaceState"]>) => { historyReplace(...args); navigation("replace-state"); };
  listen(window, "popstate", () => navigation("pop-state"));
  listen(window, "hashchange", () => navigation("hash-change"));
  listen(window, "pageshow", () => navigation("page-show"));
  navigation("initial");

  const flushFeedback = (): void => {
    feedbackQueued = false;
    if (!active || pendingMutations.length === 0) return;
    const batch = pendingMutations;
    pendingMutations = [];
    const elements = [...new Set(batch.map((mutation) => mutation.target instanceof Element ? mutation.target : mutation.target.parentElement).filter((item): item is Element => item != null))].slice(0, 25);
    emit({
      kind: "dom-feedback",
      mutationCount: batch.length,
      mutations: batch.slice(0, 100).map((mutation) => ({
        kind: mutation.type,
        ...(mutation.attributeName == null ? {} : { attribute: mutation.attributeName }),
        targetSelector: mutation.target instanceof Element ? selectorFor(mutation.target) : mutation.target.parentElement == null ? "" : selectorFor(mutation.target.parentElement),
        addedNodes: mutation.addedNodes.length,
        removedNodes: mutation.removedNodes.length,
      })),
      snapshots: elements.map(snapshot),
    });
  };
  const observer = new MutationObserver((mutations) => {
    pendingMutations.push(...mutations);
    if (feedbackQueued) return;
    feedbackQueued = true;
    setTimeout(flushFeedback, 0);
  });
  observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true, characterDataOldValue: true });

  root[options.recorderKey] = {
    stop: () => {
      flushFeedback();
      active = false;
      observer.disconnect();
      listeners.forEach((remove) => remove());
      history.pushState = historyPush;
      history.replaceState = historyReplace;
    },
  };
}

export interface RecordStudioInteractionsOptions {
  id?: string;
  startedAt?: string;
  redactSelectors?: readonly string[];
  pointerMoveIntervalMs?: number;
  settleMs?: number;
}

/** Record one real browser flow. Sensitive values are replaced inside the page, before crossing the binding. */
export async function recordStudioInteractions(
  page: Page,
  perform: (page: Page) => void | Promise<void>,
  options: RecordStudioInteractionsOptions = {},
): Promise<StudioInteractionRecording> {
  const id = options.id ?? `recording-${randomUUID()}`;
  const bindingName = `__domotionStudioRecord_${randomUUID().replaceAll("-", "")}`;
  const recorderKey = `${bindingName}State`;
  const startedAt = options.startedAt ?? new Date().toISOString();
  const startedEpochMs = Date.parse(startedAt);
  const rawEvents: BrowserRawEvent[] = [];
  let active = true;
  await page.exposeBinding(bindingName, (_source, value: BrowserRawEvent) => {
    if (active) rawEvents.push(structuredClone(value));
  });
  const installOptions: BrowserRecorderOptions = {
    bindingName,
    recorderKey,
    redactSelectors: [...(options.redactSelectors ?? [])],
    pointerMoveIntervalMs: options.pointerMoveIntervalMs ?? 80,
  };
  const cdp = await page.context().newCDPSession(page);
  const source = `(${installStudioRecorderInPage.toString()})(${JSON.stringify(installOptions)})`;
  const { identifier: initScriptId } = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source }) as { identifier: string };
  await page.evaluate(installStudioRecorderInPage, installOptions);
  let failure: unknown;
  try {
    await perform(page);
    await page.waitForTimeout(options.settleMs ?? 100);
  } catch (error) {
    failure = error;
  } finally {
    await page.evaluate(({ key }) => {
      const value = (globalThis as unknown as Record<string, unknown>)[key] as { stop?: () => void } | undefined;
      value?.stop?.();
    }, { key: recorderKey }).catch(() => {});
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: initScriptId }).catch(() => {});
    await cdp.detach().catch(() => {});
  }
  await page.waitForTimeout(10).catch(() => {});
  active = false;
  if (failure != null) throw failure;

  const ordered = rawEvents
    .map((event, order) => ({ event, order }))
    .sort((a, b) => a.event.atEpochMs - b.event.atEpochMs || a.order - b.order);
  const events = ordered.map(({ event }, sequence) => {
    const { atEpochMs, ...rest } = event;
    return studioRecordedEventSchema.parse({ ...rest, sequence, atMs: Math.max(0, atEpochMs - startedEpochMs) });
  });
  const sourceUrls = [...new Set([sanitizeRecordedUrl(page.url()), ...events.map((event) => String(event.url))])];
  const redactions = events.filter((event) => (event.kind === "input" || event.kind === "keyboard") && event.redacted === true).length;
  return studioInteractionRecordingSchema.parse({
    format: STUDIO_INTERACTION_RECORDING_FORMAT,
    version: STUDIO_INTERACTION_RECORDING_VERSION,
    id,
    startedAt,
    durationMs: events.at(-1)?.atMs ?? 0,
    viewport: page.viewportSize(),
    sourceUrls,
    redactions,
    events,
  });
}

function sanitizeRecordedUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|secret|password|passwd|key|session|code)/i.test(key)) url.searchParams.set(key, STUDIO_REDACTED_VALUE);
    }
    if (/(?:token|secret|password|passwd)=/i.test(url.hash)) url.hash = "#redacted";
    return url.href;
  } catch { return raw; }
}

const automationEvidenceSchema = z.strictObject({ summary: nonEmpty, data: z.json().optional() });
const healDecisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("candidate"), scene: studioSceneSchema, summary: nonEmpty, evidence: automationEvidenceSchema }),
  z.strictObject({ kind: z.literal("clarify"), question: nonEmpty, reason: nonEmpty, evidence: automationEvidenceSchema }),
]);
const reviewDecisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("accept"), summary: nonEmpty, evidence: automationEvidenceSchema }),
  z.strictObject({ kind: z.literal("edit"), scene: studioSceneSchema, summary: nonEmpty, evidence: automationEvidenceSchema }),
  z.strictObject({ kind: z.literal("clarify"), question: nonEmpty, reason: nonEmpty, evidence: automationEvidenceSchema }),
]);

export type StudioRecordingHealDecision = z.infer<typeof healDecisionSchema>;
export type StudioRecordingReviewDecision = z.infer<typeof reviewDecisionSchema>;
export interface StudioRecordingAiRequest {
  project: StudioProject;
  recording: StudioInteractionRecording;
  aiPolicy: { healing: "required"; review: "required" };
}
export interface StudioRecordingReviewRequest extends StudioRecordingAiRequest { candidate: StudioScene }
export interface StudioRecordingAiAdapter {
  heal: (request: StudioRecordingAiRequest) => StudioRecordingHealDecision | Promise<StudioRecordingHealDecision>;
  review: (request: StudioRecordingReviewRequest) => StudioRecordingReviewDecision | Promise<StudioRecordingReviewDecision>;
}
export interface ImportStudioInteractionRecordingOptions {
  ai: StudioRecordingAiAdapter;
  evidencePath?: string;
  now?: string;
  generatorVersion?: string;
}
export type StudioRecordingImportResult = {
  status: "clarification";
  project: StudioProject;
  question: string;
  reason: string;
  phase: "healing" | "review";
} | {
  status: "imported";
  project: StudioProject;
  scene: StudioScene;
  evidencePath: string;
  evidenceText: string;
  ai: { healing: { summary: string }; review: { summary: string } };
};

export class StudioRecordingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StudioRecordingError";
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateImportedScene(raw: unknown, project: StudioProject, phase: string): StudioScene {
  const parsed = studioSceneSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StudioRecordingError(`AI ${phase} scene is invalid at $.${issue.path.join(".")}: ${issue.message}`);
  }
  const scene = parsed.data;
  if (project.scenes.some((candidate) => candidate.id === scene.id)) throw new StudioRecordingError(`AI ${phase} scene reused existing scene id "${scene.id}"`);
  if ((scene.tracks?.flatMap((track) => track.events).length ?? 0) === 0) throw new StudioRecordingError(`AI ${phase} scene must contain inferred semantic interaction events`);
  compileStudioSemanticTracks(scene.tracks ?? [], { path: "$.scene.tracks" });
  return scene;
}

/** Run required AI healing and review, then append a normal editable Studio scene and redacted evidence artifact. */
export async function importStudioInteractionRecording(
  rawProject: unknown,
  rawRecording: unknown,
  options: ImportStudioInteractionRecordingOptions,
): Promise<StudioRecordingImportResult> {
  const project = validateStudioProject(rawProject);
  const recording = studioInteractionRecordingSchema.parse(rawRecording);
  const request: StudioRecordingAiRequest = { project: structuredClone(project), recording: structuredClone(recording), aiPolicy: { healing: "required", review: "required" } };
  const healed = healDecisionSchema.parse(await options.ai.heal(request));
  if (healed.kind === "clarify") return { status: "clarification", project, question: healed.question, reason: healed.reason, phase: "healing" };
  let scene = validateImportedScene(healed.scene, project, "healing");
  const reviewed = reviewDecisionSchema.parse(await options.ai.review({ ...request, candidate: structuredClone(scene) }));
  if (reviewed.kind === "clarify") return { status: "clarification", project, question: reviewed.question, reason: reviewed.reason, phase: "review" };
  if (reviewed.kind === "edit") scene = validateImportedScene(reviewed.scene, project, "review");

  const now = options.now ?? new Date().toISOString();
  const evidenceText = `${JSON.stringify(recording, null, 2)}\n`;
  const token = digest(`${project.review.headRevisionId}:${recording.id}:${JSON.stringify(scene)}`).slice(0, 16);
  const revisionId = `revision-recording-${token}`;
  const artifactId = `artifact-recording-${token}`;
  const evidencePath = options.evidencePath ?? `.domotion-studio/recordings/${recording.id}.json`;
  const next = structuredClone(project);
  next.scenes.push(scene);
  for (const beatId of scene.narrativeBeatIds ?? []) {
    const beat = next.narrative.beats.find((candidate) => candidate.id === beatId);
    if (beat != null && !beat.sceneIds.includes(scene.id)) beat.sceneIds.push(scene.id);
  }
  next.review.revisions.push({
    id: revisionId,
    parentId: project.review.headRevisionId,
    createdAt: now,
    author: { kind: "ai", name: "Studio recording import" },
    kind: "content",
    summary: reviewed.summary,
    metadata: {
      operation: "studio.recording.import",
      recordingId: recording.id,
      healingSummary: healed.summary,
      healingEvidence: healed.evidence,
      reviewEvidence: reviewed.evidence,
    },
  });
  next.review.headRevisionId = revisionId;
  next.artifacts.push({
    id: artifactId,
    kind: "capture-evidence",
    path: evidencePath,
    generatedAt: now,
    generator: { name: "domotion-studio-recorder", ...(options.generatorVersion == null ? {} : { version: options.generatorVersion }) },
    sourceRevisionId: revisionId,
    sceneIds: [scene.id],
    sha256: digest(evidenceText),
    metadata: {
      format: recording.format,
      version: recording.version,
      eventCount: recording.events.length,
      redactions: recording.redactions,
      sourceUrls: recording.sourceUrls,
    },
  });
  next.updatedAt = now;
  return {
    status: "imported",
    project: validateStudioProject(next),
    scene,
    evidencePath,
    evidenceText,
    ai: { healing: { summary: healed.summary }, review: { summary: reviewed.summary } },
  };
}

/** Atomically persist the already-redacted evidence returned by the importer inside a Studio workspace. */
export function persistStudioRecordingEvidence(workspaceRoot: string, result: Extract<StudioRecordingImportResult, { status: "imported" }>): string {
  const root = resolve(workspaceRoot);
  const destination = resolve(root, result.evidencePath);
  const local = relative(root, destination);
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new StudioRecordingError(`recording evidence path must stay inside the Studio workspace: ${root}`);
  if (!destination.toLowerCase().endsWith(".json")) throw new StudioRecordingError("recording evidence files must use a .json extension");
  if (existsSync(destination)) {
    if (readFileSync(destination, "utf8") === result.evidenceText) return destination;
    throw new StudioRecordingError(`recording evidence already exists with different content: ${local}`);
  }
  mkdirSync(resolve(destination, ".."), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, result.evidenceText, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
  return destination;
}

import type { ElementHandle, Locator, Page } from "@playwright/test";
import {
  HOVER_DIFF_PROPERTIES,
  classifyHoverTransition,
  diffHoverSnapshots,
  type ElementStyleSnapshot,
  type HoverDiff,
  type HoverSynthesisMode,
} from "../cli/hover-detect.js";
import { JS_REVEAL_DEFAULTS } from "../cli/mutation-detect.js";
import type { StudioSemanticStep } from "./interactions.js";
import { resolveStudioSemanticTarget } from "./interactions.js";

export type StudioObservationPhase = "baseline" | "action";
export type StudioEvidenceClassification = "direct-feedback" | "action-effect" | "incidental-churn";

export interface StudioObservedRect { x: number; y: number; width: number; height: number }

export interface StudioObservedElement {
  ref: string;
  relation: "target" | "descendant" | "ancestor" | "related" | "other";
  tag: string;
  text: string;
  rect: StudioObservedRect;
  styles: Record<string, string>;
  pseudos: Record<string, Record<string, string>>;
  animations: Array<{ type: string; name?: string; property?: string; playState: string; duration: number | string; delay: number; easing: string }>;
  scroll: { x: number; y: number; width: number; height: number };
  state: { hover: boolean; active: boolean; focus: boolean; focusVisible: boolean; focusWithin: boolean; checked?: boolean; disabled?: boolean; expanded?: string | null };
}

export interface StudioMutationEvidence {
  sequence: number;
  phase: StudioObservationPhase;
  atMs: number;
  kind: "attributes" | "characterData" | "childList";
  targetRef: string;
  attribute?: string;
  oldValue?: string | null;
  newValue?: string | null;
  addedRefs?: string[];
  removedRefs?: string[];
}

export interface StudioInteractionSignal {
  sequence: number;
  phase: StudioObservationPhase;
  atMs: number;
  type: string;
  targetRef: string;
  sample?: StudioObservedElement;
}

export interface StudioElementChange {
  ref: string;
  relation: StudioObservedElement["relation"];
  classification: StudioEvidenceClassification;
  reasons: string[];
  before?: StudioObservedElement;
  after?: StudioObservedElement;
  styleDeltas: Array<{ property: string; from?: string; to?: string }>;
  pseudoDeltas: Array<{ pseudo: string; property: string; from?: string; to?: string }>;
  geometryChanged: boolean;
  textChanged: boolean;
  animationChanged: boolean;
  scrollChanged: boolean;
  stateChanged: boolean;
}

export interface StudioInteractionEvidence {
  version: 1;
  eventId: string;
  path: string;
  targetRef: string;
  settleReason: "settled" | "timeout";
  durationMs: number;
  truncated: boolean;
  meaningful: boolean;
  summary: { addedNodes: number; removedNodes: number; attributes: number; characterData: number; directChanges: number; actionEffects: number; incidentalChanges: number };
  changes: StudioElementChange[];
  mutations: StudioMutationEvidence[];
  signals: StudioInteractionSignal[];
  hoverDiff: HoverDiff;
  suggestedSynthesis: HoverSynthesisMode;
}

export interface ObserveStudioInteractionOptions {
  eventId: string;
  path: string;
  target: Locator;
  relatedTargets?: readonly Locator[];
  settleMs?: number;
  debounceMs?: number;
  baselineMs?: number;
  maxNodes?: number;
  ignoredAttributes?: readonly string[];
}

export class StudioInteractionObservationError extends Error {
  readonly evidence: StudioInteractionEvidence;

  constructor(message: string, evidence: StudioInteractionEvidence, options?: ErrorOptions) {
    super(message, options);
    this.name = "StudioInteractionObservationError";
    this.evidence = evidence;
  }
}

const OBSERVER_KEY = "__domotionStudioInteractionObserverV1";
const OBSERVED_STYLE_PROPERTIES = [
  ...HOVER_DIFF_PROPERTIES,
  "display", "visibility", "position", "zIndex", "filter", "clipPath",
  "pointerEvents", "overflow", "transitionProperty", "transitionDuration",
  "transitionTimingFunction", "animationName", "animationDuration",
] as const;

interface RawObservation {
  targetRef: string;
  before: StudioObservedElement[];
  after: StudioObservedElement[];
  mutations: StudioMutationEvidence[];
  signals: StudioInteractionSignal[];
  ambientRefs: string[];
  settleReason: "settled" | "timeout";
  durationMs: number;
  truncated: boolean;
}

function changedRecord<T>(a: T, b: T): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

function deltaRecord(before: Record<string, string>, after: Record<string, string>): Array<{ property: string; from?: string; to?: string }> {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter((property) => before[property] !== after[property])
    .map((property) => ({ property, from: before[property], to: after[property] }));
}

function classifyRawObservation(raw: RawObservation, eventId: string, path: string): StudioInteractionEvidence {
  const before = new Map(raw.before.map((item) => [item.ref, item]));
  const after = new Map(raw.after.map((item) => [item.ref, item]));
  const ambient = new Set(raw.ambientRefs);
  const actionMutations = raw.mutations.filter((item) => item.phase === "action");
  const actionMutationRefs = new Set(actionMutations.flatMap((item) => [item.targetRef, ...(item.addedRefs ?? []), ...(item.removedRefs ?? [])]));
  const ambientActionRefs = new Set(actionMutations
    .filter((item) => ambient.has(item.targetRef))
    .flatMap((item) => [item.targetRef, ...(item.addedRefs ?? []), ...(item.removedRefs ?? [])]));
  const refs = [...new Set([...before.keys(), ...after.keys(), ...actionMutationRefs])].sort();
  const changes: StudioElementChange[] = [];
  for (const ref of refs) {
    const a = before.get(ref);
    const b = after.get(ref);
    const relation = b?.relation ?? a?.relation ?? "other";
    const styleDeltas = deltaRecord(a?.styles ?? {}, b?.styles ?? {});
    const pseudoDeltas = [...new Set([...Object.keys(a?.pseudos ?? {}), ...Object.keys(b?.pseudos ?? {})])]
      .sort()
      .flatMap((pseudo) => deltaRecord(a?.pseudos[pseudo] ?? {}, b?.pseudos[pseudo] ?? {}).map((delta) => ({ pseudo, ...delta })));
    const geometryChanged = changedRecord(a?.rect, b?.rect);
    const textChanged = a?.text !== b?.text;
    const animationChanged = changedRecord(a?.animations, b?.animations);
    const scrollChanged = changedRecord(a?.scroll, b?.scroll);
    const stateChanged = changedRecord(a?.state, b?.state);
    const addedOrRemoved = a == null || b == null;
    if (!addedOrRemoved && styleDeltas.length === 0 && pseudoDeltas.length === 0 && !geometryChanged && !textChanged && !animationChanged && !scrollChanged && !stateChanged && !actionMutationRefs.has(ref)) continue;
    const direct = relation !== "other";
    const hasRenderedOrDocumentEffect = addedOrRemoved
      || styleDeltas.length > 0
      || pseudoDeltas.length > 0
      || geometryChanged
      || textChanged
      || animationChanged
      || scrollChanged
      || actionMutationRefs.has(ref);
    // Pointer movement necessarily changes :hover/:active bookkeeping even when
    // the page renders no response. Keep that state as evidence, but do not
    // promote a visually inert target into meaningful direct feedback.
    const classification: StudioEvidenceClassification = !hasRenderedOrDocumentEffect || ambient.has(ref) || ambientActionRefs.has(ref)
      ? "incidental-churn"
      : direct ? "direct-feedback" : "action-effect";
    const reasons = [
      ...(addedOrRemoved ? [a == null ? "added" : "removed"] : []),
      ...(styleDeltas.length > 0 ? ["computed-style"] : []),
      ...(pseudoDeltas.length > 0 ? ["pseudo-style"] : []),
      ...(geometryChanged ? ["geometry"] : []),
      ...(textChanged ? ["text"] : []),
      ...(animationChanged ? ["animation"] : []),
      ...(scrollChanged ? ["scroll"] : []),
      ...(stateChanged ? ["state"] : []),
      ...(actionMutationRefs.has(ref) ? ["dom-mutation"] : []),
    ];
    changes.push({ ref, relation, classification, reasons, before: a, after: b, styleDeltas, pseudoDeltas, geometryChanged, textChanged, animationChanged, scrollChanged, stateChanged });
  }

  const targetSnapshots = (items: StudioObservedElement[]): ElementStyleSnapshot[] => items
    .filter((item) => item.relation === "target" || item.relation === "descendant")
    .map((item) => ({ key: item.ref, styles: item.styles, rect: item.rect }));
  const hoverDiff = diffHoverSnapshots(targetSnapshots(raw.before), targetSnapshots(raw.after));
  const mutations = raw.mutations.sort((a, b) => a.sequence - b.sequence);
  for (let index = 0; index < mutations.length; index++) {
    const current = mutations[index];
    if (current.kind !== "attributes" && current.kind !== "characterData") continue;
    const next = mutations.slice(index + 1).find((candidate) =>
      candidate.kind === current.kind && candidate.targetRef === current.targetRef && candidate.attribute === current.attribute,
    );
    if (next != null) current.newValue = next.oldValue;
  }
  const signals = raw.signals.sort((a, b) => a.sequence - b.sequence);
  const summary = {
    addedNodes: actionMutations.reduce((sum, item) => sum + (item.addedRefs?.length ?? 0), 0),
    removedNodes: actionMutations.reduce((sum, item) => sum + (item.removedRefs?.length ?? 0), 0),
    attributes: actionMutations.filter((item) => item.kind === "attributes").length,
    characterData: actionMutations.filter((item) => item.kind === "characterData").length,
    directChanges: changes.filter((item) => item.classification === "direct-feedback").length,
    actionEffects: changes.filter((item) => item.classification === "action-effect").length,
    incidentalChanges: changes.filter((item) => item.classification === "incidental-churn").length,
  };
  const meaningfulSignal = signals.some((item) => item.phase === "action" && /^(focusin|focusout|transition|animation|scroll)/.test(item.type));
  return {
    version: 1,
    eventId,
    path,
    targetRef: raw.targetRef,
    settleReason: raw.settleReason,
    durationMs: raw.durationMs,
    truncated: raw.truncated,
    meaningful: changes.some((item) => item.classification !== "incidental-churn") || meaningfulSignal,
    summary,
    changes,
    mutations,
    signals,
    hoverDiff,
    suggestedSynthesis: classifyHoverTransition(hoverDiff),
  };
}

async function elementHandles(locators: readonly Locator[]): Promise<Array<ElementHandle<Element>>> {
  const handles: Array<ElementHandle<Element>> = [];
  for (const locator of locators) {
    const handle = await locator.elementHandle();
    if (handle != null) handles.push(handle as ElementHandle<Element>);
  }
  return handles;
}

async function beginObservation(page: Page, target: ElementHandle<Element>, related: Array<ElementHandle<Element>>, options: Required<Pick<ObserveStudioInteractionOptions, "baselineMs" | "maxNodes">> & { ignoredAttributes: string[] }): Promise<void> {
  await page.evaluate(async ({ target, related, options, key, properties }) => {
    const root = globalThis as unknown as Record<string, unknown>;
    if (root[key] != null) throw new Error("a Studio interaction observation is already active");
    const started = performance.now();
    const references = new WeakMap<Node, string>();
    const referenceNodes = new Map<string, Node>();
    let referenceCounter = 0;
    const relatedElements = new Set<Element>(related);
    const relatedIds = new Set<string>();
    for (const attribute of ["aria-controls", "aria-describedby", "aria-details", "aria-owns"]) {
      for (const id of (target.getAttribute(attribute) ?? "").split(/\s+/).filter(Boolean)) relatedIds.add(id);
    }
    const ignored = new Set(options.ignoredAttributes);
    let sequence = 0;
    let phase: "baseline" | "action" = "baseline";
    let lastSignalAt = started;
    let truncated = false;

    const round = (value: number): number => Math.round(value * 1000) / 1000;
    const domPath = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return `${domPath(node.parentNode ?? document.documentElement)}/text()`;
      if (!(node instanceof Element)) return node.nodeName.toLowerCase();
      if (node.id !== "" && [...document.querySelectorAll("[id]")].filter((candidate) => candidate.id === node.id).length === 1) return `#${node.id}`;
      const parts: string[] = [];
      for (let element: Element | null = node; element != null && element !== document.documentElement; element = element.parentElement) {
        const siblings = element.parentElement == null ? [] : [...element.parentElement.children].filter((item) => item.localName === element.localName);
        parts.push(`${element.localName}:nth-of-type(${Math.max(1, siblings.indexOf(element) + 1)})`);
      }
      return `html/${parts.reverse().join("/")}`;
    };
    const refFor = (node: Node): string => {
      const known = references.get(node);
      if (known != null) return known;
      const ref = `n${String(referenceCounter++).padStart(6, "0")}:${domPath(node)}`;
      references.set(node, ref);
      referenceNodes.set(ref, node);
      return ref;
    };
    const relationFor = (element: Element): "target" | "descendant" | "ancestor" | "related" | "other" => {
      if (element === target) return "target";
      if (target.contains(element)) return "descendant";
      if (element.contains(target)) return "ancestor";
      if (relatedElements.has(element) || (element.id !== "" && relatedIds.has(element.id))) return "related";
      return "other";
    };
    const snapshotElement = (element: Element): StudioObservedElement => {
      const style = getComputedStyle(element);
      const styles: Record<string, string> = {};
      for (const property of properties) styles[property] = (style as unknown as Record<string, string>)[property] ?? "";
      const pseudos: Record<string, Record<string, string>> = {};
      for (const pseudo of ["::before", "::after", "::marker", "::placeholder", "::file-selector-button"]) {
        const value = getComputedStyle(element, pseudo);
        if (value.content !== "none" || value.display !== "none") {
          pseudos[pseudo] = { content: value.content, display: value.display, color: value.color, backgroundColor: value.backgroundColor, opacity: value.opacity, transform: value.transform };
        }
      }
      const rect = element.getBoundingClientRect();
      const animations = element.getAnimations().map((animation) => {
        const timing = animation.effect?.getTiming();
        const duration = timing?.duration;
        const named = animation as Animation & { animationName?: string; transitionProperty?: string };
        return {
          type: animation.constructor.name,
          ...(named.animationName == null ? {} : { name: named.animationName }),
          ...(named.transitionProperty == null ? {} : { property: named.transitionProperty }),
          playState: animation.playState,
          duration: typeof duration === "number" || typeof duration === "string" ? duration : String(duration ?? 0),
          delay: Number(timing?.delay ?? 0),
          easing: timing?.easing ?? "linear",
        };
      }).sort((a, b) => `${a.type}:${a.name ?? ""}:${a.property ?? ""}`.localeCompare(`${b.type}:${b.name ?? ""}:${b.property ?? ""}`));
      return {
        ref: refFor(element),
        relation: relationFor(element),
        tag: element.localName,
        text: (element.childNodes.length === 1 && element.firstChild?.nodeType === Node.TEXT_NODE ? element.textContent ?? "" : "").slice(0, 240),
        rect: { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) },
        styles,
        pseudos,
        animations,
        scroll: { x: round(element.scrollLeft), y: round(element.scrollTop), width: element.scrollWidth, height: element.scrollHeight },
        state: {
          hover: element.matches(":hover"),
          active: element.matches(":active"),
          focus: element.matches(":focus"),
          focusVisible: element.matches(":focus-visible"),
          focusWithin: element.matches(":focus-within"),
          ...("checked" in element ? { checked: Boolean((element as HTMLInputElement).checked) } : {}),
          ...("disabled" in element ? { disabled: Boolean((element as HTMLInputElement).disabled) } : {}),
          expanded: element.getAttribute("aria-expanded"),
        },
      };
    };
    const collectElements = (): Element[] => {
      const elements: Element[] = [];
      const visit = (container: Document | ShadowRoot): void => {
        for (const element of container.querySelectorAll("*")) {
          elements.push(element);
          if (element.shadowRoot != null) visit(element.shadowRoot);
        }
      };
      visit(document);
      return elements;
    };
    const snapshotDocument = (): StudioObservedElement[] => {
      const elements = collectElements();
      if (elements.length > options.maxNodes) truncated = true;
      return elements.slice(0, options.maxNodes).map((element) => snapshotElement(element)).sort((a, b) => a.ref.localeCompare(b.ref));
    };
    const before = snapshotDocument();
    const mutations: StudioMutationEvidence[] = [];
    const signals: StudioInteractionSignal[] = [];
    const ambientRefs = new Set<string>();
    const stamp = (): number => round(performance.now() - started);
    const recordSignal = (type: string, node: EventTarget | null): void => {
      // A mouseover can be synthesized merely because a new document appears
      // beneath Chromium's last pointer position. Baseline DOM mutations are
      // useful provenance; baseline input/lifecycle signals are not part of
      // the caller-owned action and would make canonical evidence stateful.
      if (phase === "baseline") return;
      const element = node instanceof Node ? node : document.documentElement;
      const ref = refFor(element);
      signals.push({ sequence: sequence++, phase, atMs: stamp(), type, targetRef: ref, ...(element instanceof Element ? { sample: snapshotElement(element) } : {}) });
      lastSignalAt = performance.now();
    };
    const consume = (records: MutationRecord[]): void => {
      for (const record of records) {
        if (record.type === "attributes" && record.attributeName != null && ignored.has(record.attributeName)) continue;
        const targetRef = refFor(record.target);
        if (phase === "baseline") {
          ambientRefs.add(targetRef);
          if (record.target.parentNode != null) ambientRefs.add(refFor(record.target.parentNode));
        }
        const addedRefs = record.type === "childList" ? [...record.addedNodes].map((node) => refFor(node)) : undefined;
        const removedRefs = record.type === "childList" ? [...record.removedNodes].map((node) => refFor(node)) : undefined;
        mutations.push({
          sequence: sequence++, phase, atMs: stamp(), kind: record.type, targetRef,
          ...(record.type === "attributes" ? { attribute: record.attributeName ?? undefined, oldValue: record.oldValue, newValue: (record.target as Element).getAttribute(record.attributeName ?? "") } : {}),
          ...(record.type === "characterData" ? { oldValue: record.oldValue, newValue: record.target.textContent } : {}),
          ...(addedRefs == null ? {} : { addedRefs }),
          ...(removedRefs == null ? {} : { removedRefs }),
        });
        lastSignalAt = performance.now();
      }
    };
    const observers: MutationObserver[] = [];
    const observeRoot = (observationRoot: Node): void => {
      const observer = new MutationObserver(consume);
      observer.observe(observationRoot, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true, characterDataOldValue: true });
      observers.push(observer);
    };
    observeRoot(document.documentElement);
    for (const element of collectElements()) if (element.shadowRoot != null) observeRoot(element.shadowRoot);
    const eventTypes = ["pointerdown", "pointerup", "click", "mouseover", "focusin", "focusout", "transitionrun", "transitionstart", "transitionend", "animationstart", "animationiteration", "animationend", "scroll"];
    const listener = (event: Event): void => recordSignal(event.type, event.target);
    for (const type of eventTypes) document.addEventListener(type, listener, { capture: true, passive: true });
    await new Promise<void>((resolve) => setTimeout(resolve, options.baselineMs));
    for (const observer of observers) consume(observer.takeRecords());
    phase = "action";
    lastSignalAt = performance.now();
    root[key] = { started, references, referenceNodes, before, mutations, signals, ambientRefs, observers, consume, snapshotDocument, eventTypes, listener, getLastSignalAt: () => lastSignalAt, getTruncated: () => truncated, targetRef: refFor(target) };
  }, { target, related, options, key: OBSERVER_KEY, properties: [...OBSERVED_STYLE_PROPERTIES] });
}

async function finishObservation(page: Page, settleMs: number, debounceMs: number): Promise<RawObservation> {
  return page.evaluate(async ({ key, settleMs, debounceMs }) => {
    const root = globalThis as unknown as Record<string, unknown>;
    const state = root[key] as {
      started: number;
      before: StudioObservedElement[];
      mutations: StudioMutationEvidence[];
      signals: StudioInteractionSignal[];
      ambientRefs: Set<string>;
      observers: MutationObserver[];
      consume: (records: MutationRecord[]) => void;
      snapshotDocument: () => StudioObservedElement[];
      eventTypes: string[];
      listener: EventListener;
      getLastSignalAt: () => number;
      getTruncated: () => boolean;
      targetRef: string;
    } | undefined;
    if (state == null) throw new Error("no Studio interaction observation is active");
    const waitStarted = performance.now();
    let settleReason: "settled" | "timeout" = "settled";
    while (performance.now() - state.getLastSignalAt() < debounceMs) {
      if (performance.now() - waitStarted >= settleMs) { settleReason = "timeout"; break; }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(16, debounceMs)));
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    for (const observer of state.observers) state.consume(observer.takeRecords());
    const after = state.snapshotDocument();
    for (const observer of state.observers) observer.disconnect();
    for (const type of state.eventTypes) document.removeEventListener(type, state.listener, { capture: true });
    delete root[key];
    return {
      targetRef: state.targetRef,
      before: state.before,
      after,
      mutations: state.mutations,
      signals: state.signals,
      ambientRefs: [...state.ambientRefs].sort(),
      settleReason,
      durationMs: Math.round((performance.now() - state.started) * 1000) / 1000,
      truncated: state.getTruncated(),
    };
  }, { key: OBSERVER_KEY, settleMs, debounceMs });
}

/** Passively observe one real action, settle it, and classify its visual evidence. */
export async function observeStudioInteraction(
  page: Page,
  options: ObserveStudioInteractionOptions,
  action: () => void | Promise<void>,
): Promise<StudioInteractionEvidence> {
  const settleMs = options.settleMs ?? JS_REVEAL_DEFAULTS.settleMs;
  const debounceMs = options.debounceMs ?? JS_REVEAL_DEFAULTS.debounceMs;
  const baselineMs = options.baselineMs ?? 40;
  const maxNodes = options.maxNodes ?? 1_500;
  if (![settleMs, debounceMs, baselineMs, maxNodes].every(Number.isFinite) || settleMs <= 0 || debounceMs < 0 || baselineMs < 0 || !Number.isInteger(maxNodes) || maxNodes < 1) {
    throw new Error("Studio interaction observation timing must be finite and maxNodes must be a positive integer");
  }
  const target = await options.target.elementHandle();
  if (target == null) throw new Error(`Studio interaction observation ${options.path}: target is not attached`);
  const related = await elementHandles(options.relatedTargets ?? []);
  let actionError: unknown;
  try {
    await beginObservation(page, target as ElementHandle<Element>, related, {
      baselineMs,
      maxNodes,
      ignoredAttributes: [...(options.ignoredAttributes ?? ["data-domotion-studio-target"])],
    });
    try {
      await action();
    } catch (error) {
      actionError = error;
    }
    const evidence = classifyRawObservation(await finishObservation(page, settleMs, debounceMs), options.eventId, options.path);
    if (actionError != null) {
      throw new StudioInteractionObservationError(`Studio interaction ${options.path} (${options.eventId}) failed while evidence was captured`, evidence, { cause: actionError });
    }
    return evidence;
  } finally {
    await Promise.all([target.dispose(), ...related.map((handle) => handle.dispose())]);
    await page.evaluate((key) => {
      const root = globalThis as unknown as Record<string, unknown>;
      const state = root[key] as { observers?: MutationObserver[]; eventTypes?: string[]; listener?: EventListener } | undefined;
      for (const observer of state?.observers ?? []) observer.disconnect();
      if (state?.eventTypes != null && state.listener != null) {
        for (const type of state.eventTypes) document.removeEventListener(type, state.listener, { capture: true });
      }
      delete root[key];
    }, OBSERVER_KEY).catch(() => {});
  }
}

/** Resolve a semantic step's acted-on and drag-related nodes, then observe its executor. */
export async function observeStudioSemanticStep(
  page: Page,
  step: StudioSemanticStep,
  action: () => void | Promise<void>,
  options: Omit<ObserveStudioInteractionOptions, "eventId" | "path" | "target" | "relatedTargets"> = {},
): Promise<StudioInteractionEvidence> {
  const event = step.event;
  const target = "target" in event && event.target != null
    ? await resolveStudioSemanticTarget(page, event.target, `${step.path}.target`, event.id)
    : page.locator("html");
  const relatedTargets: Locator[] = [];
  if (event.kind === "drag" && "target" in event.to) {
    relatedTargets.push(await resolveStudioSemanticTarget(page, event.to.target, `${step.path}.to.target`, event.id));
  }
  return observeStudioInteraction(page, { ...options, eventId: event.id, path: step.path, target, relatedTargets }, action);
}

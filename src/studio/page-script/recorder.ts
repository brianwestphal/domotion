import type { StudioRecordedTarget } from "../recording.js";

export interface BrowserRecorderOptions {
  bindingName: string;
  recorderKey: string;
  redactSelectors: string[];
  pointerMoveIntervalMs: number;
}

/** Self-contained browser payload; it runs in the recorded application, including after navigation. */
export function installStudioRecorderInPage(
  options: BrowserRecorderOptions,
  selectorFor: (element: Element) => string,
): void {
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
  const listen = <K extends keyof WindowEventMap>(
    target: Window | Document,
    type: K,
    handler: (event: WindowEventMap[K]) => void,
    capture = true,
  ): void => {
    target.addEventListener(type, handler as EventListener, capture);
    listeners.push(() => target.removeEventListener(type, handler as EventListener, capture));
  };
  const safeMatches = (element: Element, selector: string): boolean => {
    try {
      return element.matches(selector) || element.closest(selector) != null;
    } catch {
      return false;
    }
  };
  const sensitive = (element: Element): boolean => {
    if (options.redactSelectors.some((selector) => safeMatches(element, selector))) return true;
    if (element.closest("[data-domotion-redact]") != null) return true;
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
    const input = element as HTMLInputElement;
    const autocomplete = input.autocomplete.toLowerCase();
    return input.type === "password" || /(?:password|cc-|one-time-code|token|secret)/.test(autocomplete);
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
    const text = labels
      .map((label) => label.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
    return text || undefined;
  };
  const snapshot = (element: Element): StudioRecordedTarget => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const isSensitive = sensitive(element);
    const role = nativeRole(element);
    const label = labelText(element);
    const name =
      element.getAttribute("aria-label")?.trim() ||
      (role === "button" || role === "link" ? element.textContent?.trim() : undefined) ||
      undefined;
    const testId = element.getAttribute("data-testid")?.trim() || undefined;
    const domId = element.id || undefined;
    const textValue = isSensitive ? redactedValue : (element.textContent ?? "").trim().slice(0, 500);
    const semantic =
      role != null && name != null
        ? {
            role,
            name,
            ...(testId == null ? {} : { testId }),
            ...(domId == null ? {} : { domId }),
            selector: selectorFor(element),
          }
        : label != null
          ? {
              label,
              ...(testId == null ? {} : { testId }),
              ...(domId == null ? {} : { domId }),
              selector: selectorFor(element),
            }
          : testId != null
            ? { testId, selector: selectorFor(element) }
            : domId != null
              ? { domId, selector: selectorFor(element) }
              : textValue !== ""
                ? { text: textValue, selector: selectorFor(element) }
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
        ...(typeof control.checked === "boolean" && ["checkbox", "radio"].includes(control.type)
          ? { checked: control.checked }
          : {}),
        ...(typeof control.disabled === "boolean" ? { disabled: control.disabled } : {}),
        ...(element.hasAttribute("aria-expanded") ? { expanded: element.getAttribute("aria-expanded") } : {}),
      },
      sensitive: isSensitive,
    };
  };
  const targetElement = (target: EventTarget | null): Element | null => (target instanceof Element ? target : null);
  const sanitizeUrl = (raw: string): string => {
    try {
      const url = new URL(raw, location.href);
      for (const key of [...url.searchParams.keys()]) {
        if (/(?:token|secret|password|passwd|key|session|code)/i.test(key)) url.searchParams.set(key, redactedValue);
      }
      if (/(?:token|secret|password|passwd)=/i.test(url.hash)) url.hash = "#redacted";
      return url.href;
    } catch {
      return raw;
    }
  };
  const targetPayload = (event: Event): { target?: StudioRecordedTarget } => {
    const element = targetElement(event.target);
    return element == null ? {} : { target: snapshot(element) };
  };

  for (const phase of ["pointerdown", "pointerup", "click"] as const) {
    listen(document, phase, (event) =>
      emit({
        kind: "pointer",
        phase: phase === "pointerdown" ? "down" : phase === "pointerup" ? "up" : "click",
        point: { x: event.clientX, y: event.clientY },
        button: event.button,
        buttons: event.buttons,
        ...targetPayload(event),
      }),
    );
  }
  listen(document, "pointermove", (event) => {
    if (event.timeStamp - lastPointerMove < options.pointerMoveIntervalMs) return;
    lastPointerMove = event.timeStamp;
    emit({
      kind: "pointer",
      phase: "move",
      point: { x: event.clientX, y: event.clientY },
      button: event.button,
      buttons: event.buttons,
      ...targetPayload(event),
    });
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
        modifiers: [
          event.altKey ? "Alt" : "",
          event.ctrlKey ? "Control" : "",
          event.metaKey ? "Meta" : "",
          event.shiftKey ? "Shift" : "",
        ].filter(Boolean),
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
      value: redacted ? redactedValue : "value" in input ? String(input.value) : (element.textContent ?? ""),
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

  const navigation = (
    navigationKind: "initial" | "push-state" | "replace-state" | "pop-state" | "hash-change" | "page-show",
  ): void => emit({ kind: "navigation", navigationKind });
  const historyPush = history.pushState.bind(history);
  const historyReplace = history.replaceState.bind(history);
  history.pushState = (...args: Parameters<History["pushState"]>) => {
    historyPush(...args);
    navigation("push-state");
  };
  history.replaceState = (...args: Parameters<History["replaceState"]>) => {
    historyReplace(...args);
    navigation("replace-state");
  };
  listen(window, "popstate", () => navigation("pop-state"));
  listen(window, "hashchange", () => navigation("hash-change"));
  listen(window, "pageshow", () => navigation("page-show"));
  navigation("initial");

  const flushFeedback = (): void => {
    feedbackQueued = false;
    if (!active || pendingMutations.length === 0) return;
    const batch = pendingMutations;
    pendingMutations = [];
    const elements = [
      ...new Set(
        batch
          .map((mutation) => (mutation.target instanceof Element ? mutation.target : mutation.target.parentElement))
          .filter((item): item is Element => item != null),
      ),
    ].slice(0, 25);
    emit({
      kind: "dom-feedback",
      mutationCount: batch.length,
      mutations: batch.slice(0, 100).map((mutation) => ({
        kind: mutation.type,
        ...(mutation.attributeName == null ? {} : { attribute: mutation.attributeName }),
        targetSelector:
          mutation.target instanceof Element
            ? selectorFor(mutation.target)
            : mutation.target.parentElement == null
              ? ""
              : selectorFor(mutation.target.parentElement),
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
  observer.observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeOldValue: true,
    characterDataOldValue: true,
  });

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

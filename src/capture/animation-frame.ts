import type { Frame, Page } from "@playwright/test";

export interface StableAnimationDocumentState {
  url: string;
  animationCount: number;
  documentTimelineCount: number;
  progressTimelineCount: number;
  treeScopeCount: number;
  progressTimelines: StableProgressTimelineState[];
  smilTimelineCount: number;
  failures: string[];
}

export interface StableProgressTimelineState {
  timelineKind: string;
  axis: string;
  percentage: number;
  sourceSnapshot: string;
  targetIdentity: string;
  effectProgress: number | null;
  committed: true;
}

/**
 * Exact document-timeline state installed before a frame-scoped capture.
 *
 * `requestedTimeMs` is intentionally the caller's finite number rather than a
 * sampled wall-clock value. Chromium owns interpolation and composition; this
 * record only proves that every participating document was paused at that
 * caller-owned time before geometry/paint prepasses began.
 */
export interface StableAnimationFrameState {
  source: "chromium-paused-document-and-progress-timelines-v2";
  requestedTimeMs: number;
  animationCount: number;
  documentTimelineCount: number;
  progressTimelineCount: number;
  treeScopeCount: number;
  smilTimelineCount: number;
  documents: StableAnimationDocumentState[];
}

export interface SeekAnimationsToFrameOptions {
  /** Fail rather than silently sampling a timeline that refused the seek. */
  strict?: boolean;
  /** Seek same- and cross-origin child frames as well as the top document. */
  includeChildFrames?: boolean;
}

const CURRENT_TIME_EPSILON_MS = 0.02;

async function closedShadowRootCount(page: Page, frame: Frame): Promise<number> {
  let session;
  try {
    session = await page.context().newCDPSession(frame);
  } catch (error) {
    // Same-process child documents are included in the main target's flattened
    // snapshot and intentionally have no independent CDP session.
    if (/part of the parent frame's session/i.test(String(error))) return 0;
    throw error;
  }
  try {
    const snapshot = await session.send("DOMSnapshot.captureSnapshot", {
      computedStyles: [],
      includeDOMRects: false,
      includePaintOrder: false,
    });
    let count = 0;
    for (const document of snapshot.documents) {
      const rare = document.nodes.shadowRootType;
      if (rare == null) continue;
      for (const value of rare.value) {
        if (snapshot.strings[value] === "closed") count++;
      }
    }
    return count;
  } finally {
    await session.detach();
  }
}

async function seekDocumentFrame(frame: Frame, timeMs: number): Promise<StableAnimationDocumentState> {
  // `tsx` keeps nested browser-function names via an esbuild `__name` helper,
  // while Playwright serializes only this callback. Production bundles inline
  // the helper; source-run logical oracles need the equivalent target binding.
  await frame.evaluate("globalThis.__name ||= (target => target)");
  return frame.evaluate(async ({ requestedTimeMs, epsilonMs }) => {
    type ProgressTime = { value: number; unit: string; toString(): string };
    type AnimationScope = Document | (ShadowRoot & { getAnimations(): Animation[] });
    type ProgressSource = Element & {
      scrollLeft: number;
      scrollTop: number;
      scrollWidth: number;
      scrollHeight: number;
      clientWidth: number;
      clientHeight: number;
    };
    type ProgressTimeline = AnimationTimeline & {
      axis?: string;
      source?: ProgressSource | null;
      subject?: Element | null;
    };
    type ProgressFact = {
      animation: Animation;
      time: ProgressTime;
      timelineKind: string;
      axis: string;
      source: Element | null;
      sourceState: string;
      effectProgress: number | null;
      targetIdentity: string;
    };
    const failures: string[] = [];
    const root = document.documentElement as unknown as { __domotionSeekSettled?: boolean } | null;

    const elementIdentity = (element: Element | null): string => {
      if (element == null) return "none";
      const parts: string[] = [];
      let current: Element | null = element;
      while (current != null) {
        const parent: Element | null = current.parentElement;
        const index = parent == null ? 0 : Array.prototype.indexOf.call(parent.children, current);
        parts.push(`${current.localName}:${index}`);
        const rootNode = current.getRootNode();
        current = parent ?? (rootNode instanceof ShadowRoot ? rootNode.host : null);
      }
      return parts.reverse().join("/");
    };
    const nearestScrollSource = (subject: Element): Element => {
      let current = subject.parentElement;
      while (current != null) {
        const style = getComputedStyle(current);
        if (/(auto|scroll|hidden)/.test(`${style.overflowX} ${style.overflowY}`)) return current;
        current = current.parentElement;
      }
      return document.scrollingElement ?? document.documentElement;
    };
    const sourceState = (
      source: Element | null,
      axis: string,
      subject: Element | null,
    ): string => {
      if (source == null) return "none";
      const style = getComputedStyle(source);
      const scroll = source as ProgressSource;
      const subjectState = subject == null ? null : subject instanceof SVGGraphicsElement
        ? (() => {
            const box = subject.getBBox();
            const rect = subject.getBoundingClientRect();
            return { branch: "svg-mapped-bounds", id: elementIdentity(subject), box: [box.x, box.y, box.width, box.height], rect: [rect.x, rect.y, rect.width, rect.height] };
          })()
        : { branch: "html-stitched-size", id: elementIdentity(subject), offsetLeft: (subject as HTMLElement).offsetLeft, offsetTop: (subject as HTMLElement).offsetTop, offsetWidth: (subject as HTMLElement).offsetWidth, offsetHeight: (subject as HTMLElement).offsetHeight };
      return JSON.stringify({
        id: elementIdentity(source),
        axis,
        writingMode: style.writingMode,
        direction: style.direction,
        zoom: style.zoom,
        scrollLeft: scroll.scrollLeft,
        scrollTop: scroll.scrollTop,
        scrollWidth: scroll.scrollWidth,
        scrollHeight: scroll.scrollHeight,
        clientWidth: scroll.clientWidth,
        clientHeight: scroll.clientHeight,
        subject: subjectState,
      });
    };
    const collectScopes = (): AnimationScope[] => {
      const scopes: AnimationScope[] = [document];
      const visit = (scope: Document | ShadowRoot): void => {
        for (const element of scope.querySelectorAll("*")) {
          if (element.shadowRoot == null) continue;
          scopes.push(element.shadowRoot as AnimationScope);
          visit(element.shadowRoot);
        }
      };
      visit(document);
      return scopes;
    };
    const collectAnimations = (scopes: AnimationScope[]): Animation[] => {
      const seen = new Set<Animation>();
      const result: Animation[] = [];
      for (const scope of scopes) {
        for (const animation of scope.getAnimations()) {
          if (seen.has(animation)) continue;
          seen.add(animation);
          result.push(animation);
        }
      }
      return result;
    };

    // A CSS animation joins the document timeline only after the first style
    // recalc. Settle once per Document before enumeration (DM-1781), then
    // settle again after the seek so every later CDP/layout read observes the
    // same committed compositor frame.
    if (root != null && root.__domotionSeekSettled !== true) {
      root.__domotionSeekSettled = true;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    }

    const scopes = collectScopes();
    const before = collectAnimations(scopes);
    const documentAnimations: Animation[] = [];
    const progressAnimations: ProgressFact[] = [];

    // Prevalidate the complete reachable set before mutating any Animation.
    // Blink may auto-align a progress animation as soon as pause() runs, so a
    // later rejected numeric seek cannot be rolled back reliably.
    for (let index = 0; index < before.length; index++) {
      const animation = before[index];
      const currentTime = animation.currentTime;
      if (typeof currentTime === "number") {
        documentAnimations.push(animation);
        continue;
      }
      if (currentTime == null) {
        failures.push(`animation[${index}] has an inactive or unresolved timeline`);
        continue;
      }
      const progress = currentTime as unknown as ProgressTime;
      if (progress.unit !== "percent" || !Number.isFinite(progress.value)) {
        failures.push(`animation[${index}] exposed unsupported progress time ${progress.toString()}`);
        continue;
      }
      const timeline = animation.timeline as ProgressTimeline | null;
      const subject = timeline?.subject ?? null;
      const source = timeline?.source ?? (subject == null ? null : nearestScrollSource(subject));
      const axis = timeline?.axis ?? "block";
      const target = (animation.effect as KeyframeEffect | null)?.target ?? null;
      if (source == null || !source.isConnected) {
        failures.push(`animation[${index}] progress source is missing or detached`);
        continue;
      }
      if (getComputedStyle(source).scrollBehavior === "smooth") {
        failures.push(`animation[${index}] progress source uses smooth scrolling`);
        continue;
      }
      if (!(target instanceof Element) || !target.isConnected || target.getClientRects().length === 0) {
        failures.push(`animation[${index}] progress target is hidden or unavailable`);
        continue;
      }
      progressAnimations.push({
        animation,
        time: progress,
        timelineKind: timeline?.constructor?.name ?? "AnimationTimeline",
        axis,
        source,
        sourceState: sourceState(source, axis, subject),
        effectProgress: animation.effect?.getComputedTiming().progress ?? null,
        targetIdentity: elementIdentity(target),
      });
    }

    if (failures.length === 0) for (const animation of documentAnimations) {
      try {
        animation.pause();
        animation.currentTime = requestedTimeMs;
      } catch (error) {
        failures.push(`document animation refused seek: ${String(error)}`);
      }
    }
    if (failures.length === 0) for (const fact of progressAnimations) {
      try {
        fact.animation.pause();
        fact.animation.currentTime = CSS.percent(fact.time.value);
      } catch (error) {
        failures.push(`progress animation refused percentage hold: ${String(error)}`);
      }
    }

    let smilTimelineCount = 0;
    const smilRoots: SVGSVGElement[] = [];
    for (const svg of document.querySelectorAll("svg")) {
      if (typeof svg.pauseAnimations !== "function") continue;
      smilTimelineCount++;
      smilRoots.push(svg);
      if (failures.length > 0) continue;
      try {
        svg.pauseAnimations();
        svg.setCurrentTime(requestedTimeMs / 1000);
      } catch (error) {
        failures.push(`smil[${smilTimelineCount - 1}] refused document-time seek: ${String(error)}`);
      }
    }

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    const after = collectAnimations(scopes);
    if (after.length !== before.length) {
      failures.push(`animation enumeration changed during settle: ${before.length} -> ${after.length}`);
    }
    for (let index = 0; index < after.length; index++) {
      const animation = after[index];
      const currentTime = animation.currentTime;
      if (typeof currentTime !== "number") {
        continue;
      }
      if (Math.abs(currentTime - requestedTimeMs) > epsilonMs) {
        failures.push(`animation[${index}] drifted to ${currentTime}ms`);
      }
      if (animation.playState !== "paused" && animation.playState !== "finished") {
        failures.push(`animation[${index}] remained ${animation.playState}`);
      }
    }
    for (let index = 0; index < progressAnimations.length; index++) {
      const fact = progressAnimations[index];
      const currentTime = fact.animation.currentTime as unknown as ProgressTime | number | null;
      if (currentTime == null || typeof currentTime === "number"
        || currentTime.unit !== "percent" || currentTime.value !== fact.time.value) {
        failures.push(`progress animation[${index}] did not retain ${fact.time.value}%`);
      }
      if (fact.animation.playState !== "paused" && fact.animation.playState !== "finished") {
        failures.push(`progress animation[${index}] remained ${fact.animation.playState}`);
      }
      const timeline = fact.animation.timeline as ProgressTimeline | null;
      if (sourceState(fact.source, fact.axis, timeline?.subject ?? null) !== fact.sourceState) {
        failures.push(`progress animation[${index}] source snapshot drifted`);
      }
      if ((fact.animation.effect?.getComputedTiming().progress ?? null) !== fact.effectProgress) {
        failures.push(`progress animation[${index}] effect progress drifted`);
      }
    }
    for (let index = 0; index < smilRoots.length; index++) {
      const currentTimeSeconds = smilRoots[index].getCurrentTime();
      if (!Number.isFinite(currentTimeSeconds)
        || Math.abs(currentTimeSeconds * 1000 - requestedTimeMs) > epsilonMs) {
        failures.push(`smil[${index}] drifted to ${currentTimeSeconds}s`);
      }
    }

    return {
      url: location.href,
      animationCount: after.length,
      documentTimelineCount: documentAnimations.length,
      progressTimelineCount: progressAnimations.length,
      treeScopeCount: scopes.length,
      progressTimelines: progressAnimations.map((fact) => ({
        timelineKind: fact.timelineKind,
        axis: fact.axis,
        percentage: fact.time.value,
        sourceSnapshot: fact.sourceState,
        targetIdentity: fact.targetIdentity,
        effectProgress: fact.effectProgress,
        committed: true as const,
      })),
      smilTimelineCount,
      failures,
    };
  }, { requestedTimeMs: timeMs, epsilonMs: CURRENT_TIME_EPSILON_MS });
}

/**
 * Pause CSS/WAAPI and SMIL animation timelines at one exact time and wait for
 * Chromium to commit that state to paint. Geometry capture must call this
 * before *any* prepass; otherwise independently scheduled CDP/layout reads can
 * straddle two compositor frames.
 */
export async function seekAnimationsToFrame(
  page: Page,
  timeMs: number,
  options: SeekAnimationsToFrameOptions = {},
): Promise<StableAnimationFrameState> {
  if (!Number.isFinite(timeMs) || timeMs < 0) {
    throw new Error(`animationTimeMs must be a finite non-negative number (got ${String(timeMs)})`);
  }

  const frames = options.includeChildFrames === false ? [page.mainFrame()] : page.frames();
  const documents = await Promise.all(frames.map(async (frame) => {
    try {
      const closedRoots = await closedShadowRootCount(page, frame);
      if (closedRoots > 0) {
        return {
          url: frame.url(),
          animationCount: 0,
          documentTimelineCount: 0,
          progressTimelineCount: 0,
          treeScopeCount: 0,
          progressTimelines: [],
          smilTimelineCount: 0,
          failures: [`${closedRoots} closed shadow TreeScope(s) are not reachable for animation enumeration`],
        };
      }
      return await seekDocumentFrame(frame, timeMs);
    } catch (error) {
      return {
        url: frame.url(),
        animationCount: 0,
        documentTimelineCount: 0,
        progressTimelineCount: 0,
        treeScopeCount: 0,
        progressTimelines: [],
        smilTimelineCount: 0,
        failures: [`document frame could not be seeked: ${String(error)}`],
      };
    }
  }));
  const failures = documents.flatMap((documentState) =>
    documentState.failures.map((failure) => `${documentState.url || "about:blank"}: ${failure}`));
  if (options.strict === true && failures.length > 0) {
    throw new Error(`Stable animation frame unavailable at ${timeMs}ms:\n${failures.join("\n")}`);
  }
  return {
    source: "chromium-paused-document-and-progress-timelines-v2",
    requestedTimeMs: timeMs,
    animationCount: documents.reduce((sum, state) => sum + state.animationCount, 0),
    documentTimelineCount: documents.reduce((sum, state) => sum + state.documentTimelineCount, 0),
    progressTimelineCount: documents.reduce((sum, state) => sum + state.progressTimelineCount, 0),
    treeScopeCount: documents.reduce((sum, state) => sum + state.treeScopeCount, 0),
    smilTimelineCount: documents.reduce((sum, state) => sum + state.smilTimelineCount, 0),
    documents,
  };
}

/** Re-sample the exact timeline contract and reject any participant/source drift. */
export async function reverifyAnimationsAtFrame(
  page: Page,
  expected: StableAnimationFrameState,
  options: SeekAnimationsToFrameOptions = {},
): Promise<void> {
  const actual = await seekAnimationsToFrame(page, expected.requestedTimeMs, {
    ...options,
    strict: true,
  });
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Stable animation frame changed between capture prepasses");
  }
}

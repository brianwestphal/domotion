#!/usr/bin/env tsx
/**
 * DM-2531 investigation oracle for ScrollTimeline, ViewTimeline, and rAF.
 *
 * This gate compares target-local logical state only: CSS percentage times,
 * computed progress/style, exact scroll offsets, DevTools quads, rAF counters,
 * target identities, and the current capture helper's rejection record. It
 * reads no pixels, defines no visual tolerance, and does not implement a
 * production freeze protocol.
 */

import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { arch, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Frame,
  type Page,
} from "@playwright/test";

import { seekAnimationsToFrame } from "../src/capture/animation-frame.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const require = createRequire(import.meta.url);

export const TIMELINE_OWNERSHIP_SOURCE_PINS = {
  chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
  blinkScrollSnapshotTimeline: "third_party/blink/renderer/core/animation/scroll_snapshot_timeline.cc",
  blinkScrollTimeline: "third_party/blink/renderer/core/animation/scroll_timeline.cc",
  blinkViewTimeline: "third_party/blink/renderer/core/animation/view_timeline.cc",
  blinkAnimation: "third_party/blink/renderer/core/animation/animation.cc",
  blinkDocumentAnimations: "third_party/blink/renderer/core/animation/document_animations.cc",
  blinkPageAnimator: "third_party/blink/renderer/core/page/page_animator.cc",
  blinkScriptedAnimationController: "third_party/blink/renderer/core/dom/scripted_animation_controller.cc",
  compositorScrollTimeline: "cc/animation/scroll_timeline.cc",
} as const;

export const REQUIRED_TIMELINE_OWNERSHIP_DISCRIMINATORS = [
  "absolute-milliseconds-rejected",
  "transformed-scroller-does-not-retime-scroll-timeline",
  "projective-html-box-does-not-retime-view-timeline",
  "transformed-svg-subject-retimes-view-timeline",
  "percentage-hold-freezes-effect-not-source",
  "closed-shadow-progress-fails-before-mutation",
  "document-and-open-shadow-progress-held",
  "pre-navigation-clock-freezes-benign-main-and-oopif-raf",
  "pre-navigation-clock-exposes-native-raf-escape",
  "pre-navigation-clock-does-not-own-worker-raf",
  "late-clock-cannot-own-saved-native-raf",
] as const;

export type TimelineOwnershipDiscriminator = typeof REQUIRED_TIMELINE_OWNERSHIP_DISCRIMINATORS[number];

interface CssProgressTime {
  value: number;
  unit: string;
  text: string;
}

interface RectRecord {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TimelineFrameState {
  scrollTop: number;
  rafCount: number;
  scrollTimeline: CssProgressTime | null;
  viewTimeline: CssProgressTime | null;
  svgViewTimeline: CssProgressTime | null;
  scrollAnimation: CssProgressTime | null;
  viewAnimation: CssProgressTime | null;
  svgViewAnimation: CssProgressTime | null;
  scrollProgress: number | null;
  viewProgress: number | null;
  svgViewProgress: number | null;
  scrollOpacity: string;
  viewOpacity: string;
  svgViewOpacity: string;
  scrollerTransform: string;
  subjectTransform: string;
  svgSubjectTransform: string;
  viewOwnerPerspective: string;
  scrollerRect: RectRecord;
  subjectRect: RectRecord;
  svgSubjectRect: RectRecord;
}

interface TargetIdentity {
  targetId: string;
  type: string;
  url: string;
}

interface GeometryDiscriminator {
  before: TimelineFrameState;
  after: TimelineFrameState;
  beforeQuad: number[];
  afterQuad: number[];
  beforeQuadIsExactParallelogram: boolean;
  afterQuadIsExactParallelogram: boolean;
  timelineTimeExact: boolean;
  quadChanged: boolean;
  pass: boolean;
}

interface SvgViewDiscriminator {
  before: TimelineFrameState;
  after: TimelineFrameState;
  beforeQuad: number[];
  afterQuad: number[];
  timelineTimeChanged: boolean;
  quadChanged: boolean;
  pass: boolean;
}

interface AbsoluteSeekDiscriminator {
  errorName: string | null;
  errorMessage: string | null;
  rejected: boolean;
  pass: boolean;
}

interface HeldEffectDiscriminator {
  pinned: TimelineFrameState;
  sourceMoved: TimelineFrameState;
  pinFailures: string[];
  sourceTimelineChanged: boolean;
  animationTimesExact: boolean;
  effectProgressExact: boolean;
  computedStylesExact: boolean;
  pass: boolean;
}

interface NativeFrameReport {
  role: "main" | "oopif";
  identity: TargetIdentity;
  transformedScroller: GeometryDiscriminator;
  projectiveHtmlSubject: GeometryDiscriminator;
  transformedSvgSubject: SvgViewDiscriminator;
  absoluteSeek: AbsoluteSeekDiscriminator;
  heldEffects: HeldEffectDiscriminator;
  pass: boolean;
}

interface TreeScopeAnimationState {
  documentAnimationCount: number;
  documentProgressCount: number;
  openShadowAnimationCount: number;
  openShadowProgressCount: number;
  closedShadowAnimationCount: number;
  closedShadowProgressCount: number;
}

interface CaptureBoundaryReport {
  beforeRafCounts: Record<"main" | "oopif", number>;
  afterRafCounts: Record<"main" | "oopif", number>;
  nonStrictFailures: string[];
  strictError: string | null;
  closedScopeRejected: boolean;
  reachableProgressHeld: boolean;
  rafMutatedDuringCaptureSettle: boolean;
  treeScopesBefore: Record<"main" | "oopif", TreeScopeAnimationState>;
  reachableState: Awaited<ReturnType<typeof seekAnimationsToFrame>> | null;
  reachableError: string | null;
  pass: boolean;
}

interface ClockFrameState {
  rafCount: number;
  builtinRafCount: number;
  workerRafCount: number;
  performanceNow: number;
  clockInjected: boolean;
  nativeClockBuiltinsExposed: boolean;
  requestAnimationFrameWrapped: boolean;
}

interface ClockTargetPair {
  main: TargetIdentity;
  oopif: TargetIdentity;
  distinctOopifTargets: boolean;
}

interface PreNavigationClockReport {
  targets: ClockTargetPair;
  before: Record<"main" | "oopif", ClockFrameState>;
  afterRealDelay: Record<"main" | "oopif", ClockFrameState>;
  targetLocalTimesExact: boolean;
  countersFrozen: boolean;
  pass: boolean;
}

interface PreNavigationClockEscapeReport {
  targets: ClockTargetPair;
  afterPause: Record<"main" | "oopif", ClockFrameState>;
  afterRealDelay: Record<"main" | "oopif", ClockFrameState>;
  exposedClocksFrozen: boolean;
  benignCountersFrozen: boolean;
  exposedNativeCallbacksAdvanced: boolean;
  workerCallbacksAdvanced: boolean;
  pass: boolean;
}

interface LateClockEscapeReport {
  targets: ClockTargetPair;
  afterPause: Record<"main" | "oopif", ClockFrameState>;
  afterRealDelay: Record<"main" | "oopif", ClockFrameState>;
  exposedClocksFrozen: boolean;
  savedNativeCallbacksAdvanced: boolean;
  pass: boolean;
}

export interface TimelineSamplingOwnershipReport {
  schemaVersion: 2;
  ticket: "DM-2553";
  contract: "source-exact-progress-timeline-ownership-no-pixels";
  generatedAt: string;
  sourcePins: typeof TIMELINE_OWNERSHIP_SOURCE_PINS;
  environment: {
    browserProduct: string;
    browserRevision: string;
    protocolVersion: string;
    playwrightVersion: string;
    playwrightClockServerSha256: string;
    playwrightClockInjectedSha256: string;
    os: NodeJS.Platform;
    osRelease: string;
    architecture: string;
    node: string;
  };
  native: {
    targets: ClockTargetPair;
    frames: NativeFrameReport[];
    captureBoundary: CaptureBoundaryReport;
    pass: boolean;
  };
  clocks: {
    benignPreNavigation: PreNavigationClockReport;
    preNavigationEscapes: PreNavigationClockEscapeReport;
    lateNativeEscape: LateClockEscapeReport;
    pass: boolean;
  };
  discriminators: Record<TimelineOwnershipDiscriminator, boolean>;
  freezeableStates: string[];
  failClosedStates: string[];
  pass: boolean;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isExactParallelogram(quad: number[]): boolean {
  return quad.length === 8
    && quad[0] + quad[4] === quad[2] + quad[6]
    && quad[1] + quad[5] === quad[3] + quad[7];
}

function timelineHtml(
  port: number,
  child: boolean,
  options: { nativeEscape: boolean; builtinEscape: boolean; workerEscape: boolean; omitClosed: boolean },
): string {
  const role = child ? "oopif" : "main";
  const childQuery = new URLSearchParams(Object.entries(options)
    .filter(([, enabled]) => enabled)
    .map(([key]) => [key, "1"])).toString();
  const frame = child
    ? ""
    : `<iframe id="oopif" src="http://localhost:${port}/child${childQuery === "" ? "" : `?${childQuery}`}"></iframe>`;
  return `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%}
    #stage{position:relative;width:700px;height:520px;padding:24px}
    #scroller{position:relative;width:260px;height:180px;overflow:auto;transform:matrix(.94,.16,-.11,1.03,17.25,-8.5);transform-origin:31px 47px}
    #content{position:relative;height:840px}
    #scrollTarget{position:absolute;left:28px;top:30px;width:70px;height:50px;background:#234}
    #viewOwner{position:absolute;left:41px;top:330px;width:130px;height:110px;perspective:380px;perspective-origin:23% 67%;transform-style:preserve-3d}
    #viewSubject{width:100px;height:80px;background:#864;transform:rotateY(21deg) translateZ(17px);transform-origin:19px 61px;transform-style:preserve-3d}
    #svgViewOwner{position:absolute;left:176px;top:345px;width:60px;height:60px;overflow:visible}
    #svgViewSubject{transform-box:fill-box;transform-origin:0 0}
    #numberProbe{position:absolute;left:180px;top:45px;width:20px;height:20px}
    .shadow-host{position:absolute;left:24px;top:470px;width:140px;height:90px}
    #closedShadowHost{left:180px}
    iframe{position:absolute;left:330px;top:24px;width:320px;height:430px;border:0}
  </style><div id="stage" data-role="${role}">
    <div id="scroller"><div id="content"><div id="scrollTarget"></div><div id="numberProbe"></div><div id="viewOwner"><div id="viewSubject"></div></div><svg id="svgViewOwner" viewBox="0 0 60 60"><rect id="svgViewSubject" x="5" y="5" width="40" height="40" fill="#286"></rect></svg></div></div>
    <div id="openShadowHost" class="shadow-host"></div>${options.omitClosed ? "" : '<div id="closedShadowHost" class="shadow-host"></div>'}
    ${frame}
  </div><script>
  (() => {
    const scroller = document.querySelector('#scroller');
    const scrollTarget = document.querySelector('#scrollTarget');
    const viewSubject = document.querySelector('#viewSubject');
    const svgViewSubject = document.querySelector('#svgViewSubject');
    const scrollTimeline = new ScrollTimeline({ source: scroller, axis: 'block' });
    const viewTimeline = new ViewTimeline({ subject: viewSubject, axis: 'block', inset: '13px 29px' });
    const svgViewTimeline = new ViewTimeline({ subject: svgViewSubject, axis: 'block' });
    const scrollAnimation = scrollTarget.animate([{ opacity: .17 }, { opacity: .83 }], { duration: 1000, fill: 'both', timeline: scrollTimeline });
    const viewAnimation = viewSubject.animate([{ opacity: .23 }, { opacity: .91 }], { duration: 1000, fill: 'both', timeline: viewTimeline });
    const svgViewAnimation = svgViewSubject.animate([{ opacity: .31 }, { opacity: .79 }], { duration: 1000, fill: 'both', timeline: svgViewTimeline });
    const makeShadowScope = (host, mode) => {
      const root = host.attachShadow({ mode });
      root.innerHTML = '<style>.s{width:120px;height:70px;overflow:auto}.c{position:relative;height:350px}.t{position:absolute;top:115px;width:35px;height:25px;background:#347}</style><div class="s"><div class="c"><div class="t"></div></div></div>';
      const source = root.querySelector('.s');
      const target = root.querySelector('.t');
      source.scrollTop = 83;
      const timeline = new ScrollTimeline({ source, axis: 'block' });
      const animation = target.animate([{ opacity: .2 }, { opacity: .8 }], { duration: 1000, fill: 'both', timeline });
      return { root, source, target, timeline, animation };
    };
    const openShadow = makeShadowScope(document.querySelector('#openShadowHost'), 'open');
    const closedShadow = ${options.omitClosed ? "null" : "makeShadowScope(document.querySelector('#closedShadowHost'), 'closed')"};
    globalThis.__dm2531 = { scroller, scrollTarget, viewSubject, svgViewSubject, scrollTimeline, viewTimeline, svgViewTimeline, scrollAnimation, viewAnimation, svgViewAnimation, openShadow, closedShadow };
    globalThis.__dm2531RafCount = 0;
    globalThis.__dm2531BuiltinRafCount = 0;
    globalThis.__dm2531WorkerRafCount = 0;
    // Snapshot the callback function visible to first-party script. The
    // pre-navigation arm retains the installed shim; the late-install arm
    // retains Chromium's native function and proves that it escapes the shim.
    const schedule = requestAnimationFrame.bind(window);
    const loop = () => { globalThis.__dm2531RafCount++; schedule(loop); };
    schedule(loop);
    if (${options.builtinEscape ? "true" : "false"}) {
      const builtinSchedule = globalThis.__pwClock && globalThis.__pwClock.builtins.requestAnimationFrame;
      if (typeof builtinSchedule === 'function') {
        const builtinLoop = () => { globalThis.__dm2531BuiltinRafCount++; builtinSchedule(builtinLoop); };
        builtinSchedule(builtinLoop);
      }
    }
    if (${options.workerEscape ? "true" : "false"}) {
      const workerSource = 'let count=0; const loop=()=>{ postMessage(++count); requestAnimationFrame(loop); }; requestAnimationFrame(loop);';
      const worker = new Worker(URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })));
      worker.onmessage = event => { globalThis.__dm2531WorkerRafCount = event.data; };
      globalThis.__dm2531Worker = worker;
    }
    document.documentElement.dataset.ready = 'true';
  })();
  <\/script>`;
}

async function startFixtureServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    const port = (server.address() as { port: number }).port;
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `127.0.0.1:${port}`}`);
    const child = url.pathname === "/child";
    response.statusCode = 200;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(timelineHtml(port, child, {
      nativeEscape: url.searchParams.get("nativeEscape") === "1",
      builtinEscape: url.searchParams.get("builtinEscape") === "1",
      workerEscape: url.searchParams.get("workerEscape") === "1",
      omitClosed: url.searchParams.get("omitClosed") === "1",
    }));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  return { server, port: (server.address() as { port: number }).port };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function fixtureFrames(page: Page): Promise<{ main: Frame; oopif: Frame }> {
  await page.locator("#scroller").waitFor();
  const oopif = page.frames().find((frame) => frame !== page.mainFrame());
  if (oopif == null) throw new Error("DM-2531 fixture lost its OOPIF");
  await oopif.locator("#scroller").waitFor();
  return { main: page.mainFrame(), oopif };
}

async function enableTarget(context: BrowserContext, owner: Page | Frame): Promise<CDPSession> {
  const cdp = await context.newCDPSession(owner);
  await cdp.send("DOM.enable");
  return cdp;
}

async function targetIdentity(cdp: CDPSession): Promise<TargetIdentity> {
  const { targetInfo } = await cdp.send("Target.getTargetInfo");
  return { targetId: targetInfo.targetId, type: targetInfo.type, url: targetInfo.url };
}

function targetPair(main: TargetIdentity, oopif: TargetIdentity): ClockTargetPair {
  return {
    main,
    oopif,
    distinctOopifTargets: main.targetId !== oopif.targetId
      && main.type === "page"
      && oopif.type === "iframe"
      && new URL(main.url).hostname !== new URL(oopif.url).hostname,
  };
}

async function contentQuad(cdp: CDPSession, selector: string): Promise<number[]> {
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  if (nodeId === 0) throw new Error(`missing DevTools quad owner ${selector}`);
  const result = await cdp.send("DOM.getContentQuads", { nodeId });
  const quad = result.quads?.[0];
  if (quad == null || quad.length !== 8 || quad.some((coordinate: number) => !Number.isFinite(coordinate))) {
    throw new Error(`invalid DevTools content quad for ${selector}`);
  }
  return [...quad];
}

async function settleNativeFrame(frame: Frame): Promise<void> {
  await frame.evaluate(() => new Promise<void>((resolveFrame) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()));
  }));
}

async function prepareTimelineFrame(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    const state = (globalThis as typeof globalThis & {
      __dm2531: { scroller: HTMLElement; viewSubject: HTMLElement; svgViewSubject: SVGElement };
    }).__dm2531;
    state.scroller.scrollTop = 211;
    state.scroller.style.transform = "matrix(.94,.16,-.11,1.03,17.25,-8.5)";
    state.viewSubject.style.transform = "rotateY(21deg) translateZ(17px)";
    state.svgViewSubject.style.transform = "none";
  });
  await settleNativeFrame(frame);
}

async function readTimelineState(frame: Frame): Promise<TimelineFrameState> {
  return frame.evaluate(() => {
    type ProgressValue = { value: number; unit: string; toString(): string };
    type FixtureState = {
      scroller: HTMLElement;
      scrollTarget: HTMLElement;
      viewSubject: HTMLElement;
      svgViewSubject: SVGElement;
      scrollTimeline: AnimationTimeline;
      viewTimeline: AnimationTimeline;
      svgViewTimeline: AnimationTimeline;
      scrollAnimation: Animation;
      viewAnimation: Animation;
      svgViewAnimation: Animation;
    };
    const fixture = (globalThis as typeof globalThis & { __dm2531: FixtureState }).__dm2531;
    const scrollTimelineValue = fixture.scrollTimeline.currentTime as ProgressValue | number | null;
    const viewTimelineValue = fixture.viewTimeline.currentTime as ProgressValue | number | null;
    const svgViewTimelineValue = fixture.svgViewTimeline.currentTime as ProgressValue | number | null;
    const scrollAnimationValue = fixture.scrollAnimation.currentTime as ProgressValue | number | null;
    const viewAnimationValue = fixture.viewAnimation.currentTime as ProgressValue | number | null;
    const svgViewAnimationValue = fixture.svgViewAnimation.currentTime as ProgressValue | number | null;
    const scrollTimeline = scrollTimelineValue == null || typeof scrollTimelineValue === "number"
      ? null
      : { value: scrollTimelineValue.value, unit: scrollTimelineValue.unit, text: scrollTimelineValue.toString() };
    const viewTimeline = viewTimelineValue == null || typeof viewTimelineValue === "number"
      ? null
      : { value: viewTimelineValue.value, unit: viewTimelineValue.unit, text: viewTimelineValue.toString() };
    const svgViewTimeline = svgViewTimelineValue == null || typeof svgViewTimelineValue === "number"
      ? null
      : { value: svgViewTimelineValue.value, unit: svgViewTimelineValue.unit, text: svgViewTimelineValue.toString() };
    const scrollAnimation = scrollAnimationValue == null || typeof scrollAnimationValue === "number"
      ? null
      : { value: scrollAnimationValue.value, unit: scrollAnimationValue.unit, text: scrollAnimationValue.toString() };
    const viewAnimation = viewAnimationValue == null || typeof viewAnimationValue === "number"
      ? null
      : { value: viewAnimationValue.value, unit: viewAnimationValue.unit, text: viewAnimationValue.toString() };
    const svgViewAnimation = svgViewAnimationValue == null || typeof svgViewAnimationValue === "number"
      ? null
      : { value: svgViewAnimationValue.value, unit: svgViewAnimationValue.unit, text: svgViewAnimationValue.toString() };
    const scrollerRect = fixture.scroller.getBoundingClientRect();
    const subjectRect = fixture.viewSubject.getBoundingClientRect();
    const svgSubjectRect = fixture.svgViewSubject.getBoundingClientRect();
    const scrollStyle = getComputedStyle(fixture.scrollTarget);
    const viewStyle = getComputedStyle(fixture.viewSubject);
    const svgViewStyle = getComputedStyle(fixture.svgViewSubject);
    return {
      scrollTop: fixture.scroller.scrollTop,
      rafCount: (globalThis as typeof globalThis & { __dm2531RafCount: number }).__dm2531RafCount,
      scrollTimeline,
      viewTimeline,
      svgViewTimeline,
      scrollAnimation,
      viewAnimation,
      svgViewAnimation,
      scrollProgress: fixture.scrollAnimation.effect?.getComputedTiming().progress ?? null,
      viewProgress: fixture.viewAnimation.effect?.getComputedTiming().progress ?? null,
      svgViewProgress: fixture.svgViewAnimation.effect?.getComputedTiming().progress ?? null,
      scrollOpacity: scrollStyle.opacity,
      viewOpacity: viewStyle.opacity,
      svgViewOpacity: svgViewStyle.opacity,
      scrollerTransform: getComputedStyle(fixture.scroller).transform,
      subjectTransform: viewStyle.transform,
      svgSubjectTransform: svgViewStyle.transform,
      viewOwnerPerspective: getComputedStyle(document.querySelector("#viewOwner")!).perspective,
      scrollerRect: { x: scrollerRect.x, y: scrollerRect.y, width: scrollerRect.width, height: scrollerRect.height },
      subjectRect: { x: subjectRect.x, y: subjectRect.y, width: subjectRect.width, height: subjectRect.height },
      svgSubjectRect: { x: svgSubjectRect.x, y: svgSubjectRect.y, width: svgSubjectRect.width, height: svgSubjectRect.height },
    };
  });
}

async function mutateGeometry(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    const fixture = (globalThis as typeof globalThis & {
      __dm2531: { scroller: HTMLElement; viewSubject: HTMLElement; svgViewSubject: SVGElement };
    }).__dm2531;
    fixture.scroller.style.transform = "matrix(.71,-.29,.24,1.18,63.5,21.25)";
    fixture.viewSubject.style.transform = "rotateY(67deg) rotateX(19deg) translateZ(83px)";
    fixture.svgViewSubject.style.transform = "scale(2)";
  });
  await settleNativeFrame(frame);
}

async function absoluteSeekDiscriminator(frame: Frame): Promise<AbsoluteSeekDiscriminator> {
  const error = await frame.evaluate(() => {
    const fixture = (globalThis as typeof globalThis & { __dm2531: { scrollTimeline: AnimationTimeline } }).__dm2531;
    const target = document.querySelector("#numberProbe") as HTMLElement;
    const probe = target.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 1000,
      fill: "both",
      timeline: fixture.scrollTimeline,
    });
    let result: { name: string; message: string } | null = null;
    try {
      probe.pause();
      probe.currentTime = 375;
    } catch (caught) {
      const value = caught as Error;
      result = { name: value.name, message: value.message };
    } finally {
      probe.cancel();
    }
    return result;
  });
  const rejected = error != null
    && /absolute time values|progress based animations/i.test(error.message);
  return {
    errorName: error?.name ?? null,
    errorMessage: error?.message ?? null,
    rejected,
    pass: rejected,
  };
}

async function pinProgressEffects(frame: Frame): Promise<string[]> {
  return frame.evaluate(() => {
    type ProgressValue = { value: number; unit: string };
    type FixtureState = { scrollAnimation: Animation; viewAnimation: Animation; svgViewAnimation: Animation };
    const fixture = (globalThis as typeof globalThis & { __dm2531: FixtureState }).__dm2531;
    const failures: string[] = [];
    for (const [id, animation] of [
      ["scroll", fixture.scrollAnimation],
      ["html-view", fixture.viewAnimation],
      ["svg-view", fixture.svgViewAnimation],
    ] as const) {
      const time = animation.currentTime;
      if (time == null || typeof time === "number") {
        failures.push(`${id} animation did not expose a resolved CSS percentage`);
        continue;
      }
      const progress = time as ProgressValue;
      if (progress.unit !== "percent" || !Number.isFinite(progress.value)) {
        failures.push(`${id} animation exposed ${progress.value}${progress.unit}`);
        continue;
      }
      try {
        animation.pause();
        animation.currentTime = CSS.percent(progress.value);
      } catch (error) {
        failures.push(`${id} percentage hold failed: ${String(error)}`);
      }
    }
    return failures;
  });
}

async function moveTimelineSource(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    const fixture = (globalThis as typeof globalThis & { __dm2531: { scroller: HTMLElement } }).__dm2531;
    fixture.scroller.scrollTop = 367;
  });
  await settleNativeFrame(frame);
}

async function runNativeFrame(role: NativeFrameReport["role"], frame: Frame, cdp: CDPSession): Promise<NativeFrameReport> {
  await prepareTimelineFrame(frame);
  const baseline = await readTimelineState(frame);
  const scrollerQuadBefore = await contentQuad(cdp, "#scroller");
  const subjectQuadBefore = await contentQuad(cdp, "#viewSubject");
  const svgSubjectQuadBefore = await contentQuad(cdp, "#svgViewSubject");
  await mutateGeometry(frame);
  const transformed = await readTimelineState(frame);
  const scrollerQuadAfter = await contentQuad(cdp, "#scroller");
  const subjectQuadAfter = await contentQuad(cdp, "#viewSubject");
  const svgSubjectQuadAfter = await contentQuad(cdp, "#svgViewSubject");

  const transformedScroller: GeometryDiscriminator = {
    before: baseline,
    after: transformed,
    beforeQuad: scrollerQuadBefore,
    afterQuad: scrollerQuadAfter,
    beforeQuadIsExactParallelogram: isExactParallelogram(scrollerQuadBefore),
    afterQuadIsExactParallelogram: isExactParallelogram(scrollerQuadAfter),
    timelineTimeExact: equal(baseline.scrollTimeline, transformed.scrollTimeline),
    quadChanged: !equal(scrollerQuadBefore, scrollerQuadAfter),
    pass: false,
  };
  transformedScroller.pass = transformedScroller.timelineTimeExact
    && transformedScroller.quadChanged
    && baseline.scrollTop === transformed.scrollTop
    && baseline.scrollerTransform !== transformed.scrollerTransform;

  const projectiveHtmlSubject: GeometryDiscriminator = {
    before: baseline,
    after: transformed,
    beforeQuad: subjectQuadBefore,
    afterQuad: subjectQuadAfter,
    beforeQuadIsExactParallelogram: isExactParallelogram(subjectQuadBefore),
    afterQuadIsExactParallelogram: isExactParallelogram(subjectQuadAfter),
    timelineTimeExact: equal(baseline.viewTimeline, transformed.viewTimeline),
    quadChanged: !equal(subjectQuadBefore, subjectQuadAfter),
    pass: false,
  };
  projectiveHtmlSubject.pass = projectiveHtmlSubject.timelineTimeExact
    && projectiveHtmlSubject.quadChanged
    && baseline.scrollTop === transformed.scrollTop
    && baseline.subjectTransform.startsWith("matrix3d(")
    && transformed.subjectTransform.startsWith("matrix3d(")
    && baseline.viewOwnerPerspective !== "none"
    && transformed.viewOwnerPerspective !== "none"
    && !projectiveHtmlSubject.beforeQuadIsExactParallelogram
    && !projectiveHtmlSubject.afterQuadIsExactParallelogram
    && baseline.subjectTransform !== transformed.subjectTransform;

  const transformedSvgSubject: SvgViewDiscriminator = {
    before: baseline,
    after: transformed,
    beforeQuad: svgSubjectQuadBefore,
    afterQuad: svgSubjectQuadAfter,
    timelineTimeChanged: !equal(baseline.svgViewTimeline, transformed.svgViewTimeline),
    quadChanged: !equal(svgSubjectQuadBefore, svgSubjectQuadAfter),
    pass: false,
  };
  transformedSvgSubject.pass = transformedSvgSubject.timelineTimeChanged
    && transformedSvgSubject.quadChanged
    && baseline.scrollTop === transformed.scrollTop
    && baseline.svgSubjectTransform !== transformed.svgSubjectTransform
    && baseline.svgSubjectRect.width !== transformed.svgSubjectRect.width
    && baseline.svgSubjectRect.height !== transformed.svgSubjectRect.height;

  const absoluteSeek = await absoluteSeekDiscriminator(frame);
  const pinFailures = await pinProgressEffects(frame);
  await settleNativeFrame(frame);
  const pinned = await readTimelineState(frame);
  await moveTimelineSource(frame);
  const sourceMoved = await readTimelineState(frame);
  const heldEffects: HeldEffectDiscriminator = {
    pinned,
    sourceMoved,
    pinFailures,
    sourceTimelineChanged: !equal(pinned.scrollTimeline, sourceMoved.scrollTimeline)
      && !equal(pinned.viewTimeline, sourceMoved.viewTimeline)
      && !equal(pinned.svgViewTimeline, sourceMoved.svgViewTimeline),
    animationTimesExact: equal(pinned.scrollAnimation, sourceMoved.scrollAnimation)
      && equal(pinned.viewAnimation, sourceMoved.viewAnimation)
      && equal(pinned.svgViewAnimation, sourceMoved.svgViewAnimation),
    effectProgressExact: pinned.scrollProgress === sourceMoved.scrollProgress
      && pinned.viewProgress === sourceMoved.viewProgress
      && pinned.svgViewProgress === sourceMoved.svgViewProgress,
    computedStylesExact: pinned.scrollOpacity === sourceMoved.scrollOpacity
      && pinned.viewOpacity === sourceMoved.viewOpacity
      && pinned.svgViewOpacity === sourceMoved.svgViewOpacity,
    pass: false,
  };
  heldEffects.pass = pinFailures.length === 0
    && heldEffects.sourceTimelineChanged
    && heldEffects.animationTimesExact
    && heldEffects.effectProgressExact
    && heldEffects.computedStylesExact
    && pinned.scrollTop !== sourceMoved.scrollTop;

  const identity = await targetIdentity(cdp);
  return {
    role,
    identity,
    transformedScroller,
    projectiveHtmlSubject,
    transformedSvgSubject,
    absoluteSeek,
    heldEffects,
    pass: transformedScroller.pass
      && projectiveHtmlSubject.pass
      && transformedSvgSubject.pass
      && absoluteSeek.pass
      && heldEffects.pass,
  };
}

async function rafCounts(frames: { main: Frame; oopif: Frame }): Promise<Record<"main" | "oopif", number>> {
  const [main, oopif] = await Promise.all([frames.main, frames.oopif].map((frame) => frame.evaluate(
    () => (globalThis as typeof globalThis & { __dm2531RafCount: number }).__dm2531RafCount,
  )));
  return { main, oopif };
}

async function readTreeScopeAnimationState(frame: Frame): Promise<TreeScopeAnimationState> {
  return frame.evaluate(() => {
    type FixtureState = {
      openShadow: { root: ShadowRoot };
      closedShadow: { root: ShadowRoot };
    };
    type AnimationScope = { getAnimations(): Animation[] };
    const fixture = (globalThis as typeof globalThis & { __dm2531: FixtureState }).__dm2531;
    const documentAnimations = document.getAnimations();
    const openShadowAnimations = (fixture.openShadow.root as unknown as AnimationScope).getAnimations();
    const closedShadowAnimations = (fixture.closedShadow.root as unknown as AnimationScope).getAnimations();
    return {
      documentAnimationCount: documentAnimations.length,
      documentProgressCount: documentAnimations.filter((animation) =>
        animation.currentTime != null && typeof animation.currentTime !== "number").length,
      openShadowAnimationCount: openShadowAnimations.length,
      openShadowProgressCount: openShadowAnimations.filter((animation) =>
        animation.currentTime != null && typeof animation.currentTime !== "number").length,
      closedShadowAnimationCount: closedShadowAnimations.length,
      closedShadowProgressCount: closedShadowAnimations.filter((animation) =>
        animation.currentTime != null && typeof animation.currentTime !== "number").length,
    };
  });
}

async function readTreeScopePair(
  frames: { main: Frame; oopif: Frame },
): Promise<Record<"main" | "oopif", TreeScopeAnimationState>> {
  const [main, oopif] = await Promise.all([
    readTreeScopeAnimationState(frames.main),
    readTreeScopeAnimationState(frames.oopif),
  ]);
  return { main, oopif };
}

async function runCaptureBoundary(page: Page, frames: { main: Frame; oopif: Frame }): Promise<CaptureBoundaryReport> {
  const treeScopesBefore = await readTreeScopePair(frames);
  const beforeRafCounts = await rafCounts(frames);
  const nonStrict = await seekAnimationsToFrame(page, 375, { strict: false, includeChildFrames: true });
  const afterRafCounts = await rafCounts(frames);
  const nonStrictFailures = nonStrict.documents.flatMap((document) =>
    document.failures.map((failure) => `${document.url}: ${failure}`));
  let strictError: string | null = null;
  try {
    await seekAnimationsToFrame(page, 375, { strict: true, includeChildFrames: true });
  } catch (error) {
    strictError = String(error);
  }
  const closedScopeRejected = nonStrictFailures.some((failure) => /closed shadow TreeScope/.test(failure))
    && strictError != null
    && /Stable animation frame unavailable/.test(strictError);
  const reachableUrl = new URL(page.url());
  reachableUrl.searchParams.set("omitClosed", "1");
  await page.goto(reachableUrl.href);
  const reachableFrames = await fixtureFrames(page);
  const beforeReachableRafCounts = await rafCounts(reachableFrames);
  let reachableState: Awaited<ReturnType<typeof seekAnimationsToFrame>> | null = null;
  let reachableError: string | null = null;
  try {
    reachableState = await seekAnimationsToFrame(page, 375, { strict: true, includeChildFrames: true });
  } catch (error) {
    reachableError = String(error);
  }
  const afterReachableRafCounts = await rafCounts(reachableFrames);
  const rafMutatedDuringCaptureSettle = afterReachableRafCounts.main > beforeReachableRafCounts.main
    && afterReachableRafCounts.oopif > beforeReachableRafCounts.oopif;
  const reachableProgressHeld = reachableError == null
    && reachableState != null
    && reachableState.progressTimelineCount === 8
    && reachableState.treeScopeCount === 4
    && reachableState.documents.every((state) => state.failures.length === 0
      && state.progressTimelines.length === 4);
  return {
    beforeRafCounts,
    afterRafCounts,
    nonStrictFailures,
    strictError,
    closedScopeRejected,
    reachableProgressHeld,
    rafMutatedDuringCaptureSettle,
    treeScopesBefore,
    reachableState,
    reachableError,
    pass: closedScopeRejected && reachableProgressHeld && rafMutatedDuringCaptureSettle,
  };
}

async function readClockState(frame: Frame): Promise<ClockFrameState> {
  return frame.evaluate(() => {
    type ClockGlobal = typeof globalThis & {
      __dm2531RafCount: number;
      __dm2531BuiltinRafCount: number;
      __dm2531WorkerRafCount: number;
      __pwClock?: { builtins?: { requestAnimationFrame?: unknown } };
    };
    const scope = globalThis as ClockGlobal;
    return {
      rafCount: scope.__dm2531RafCount,
      builtinRafCount: scope.__dm2531BuiltinRafCount,
      workerRafCount: scope.__dm2531WorkerRafCount,
      performanceNow: performance.now(),
      clockInjected: scope.__pwClock != null,
      nativeClockBuiltinsExposed: typeof scope.__pwClock?.builtins?.requestAnimationFrame === "function",
      requestAnimationFrameWrapped: !/\[native code\]/.test(Function.prototype.toString.call(requestAnimationFrame)),
    };
  });
}

async function readClockPair(frames: { main: Frame; oopif: Frame }): Promise<Record<"main" | "oopif", ClockFrameState>> {
  const [main, oopif] = await Promise.all([readClockState(frames.main), readClockState(frames.oopif)]);
  return { main, oopif };
}

async function clockTargets(context: BrowserContext, page: Page, frames: { main: Frame; oopif: Frame }): Promise<{ pair: ClockTargetPair; sessions: CDPSession[] }> {
  const mainCdp = await enableTarget(context, page);
  const oopifCdp = await enableTarget(context, frames.oopif);
  const [main, oopif] = await Promise.all([targetIdentity(mainCdp), targetIdentity(oopifCdp)]);
  return { pair: targetPair(main, oopif), sessions: [mainCdp, oopifCdp] };
}

async function delayRealTime(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function runPreNavigationClock(browser: Browser, url: string): Promise<PreNavigationClockReport> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const sessions: CDPSession[] = [];
  try {
    await page.clock.install({ time: 1_000_000 });
    // Freeze before navigation. Leaving the installed clock ticking while the
    // page and OOPIF targets are discovered makes a later fixed pause target
    // retrograde on slower hosts (the Linux helper setup can exceed one real
    // second), and weakens the pre-navigation ownership experiment.
    await page.clock.pauseAt(1_001_000);
    await page.goto(url);
    const frames = await fixtureFrames(page);
    const target = await clockTargets(context, page, frames);
    sessions.push(...target.sessions);
    const before = await readClockPair(frames);
    await delayRealTime(100);
    const afterRealDelay = await readClockPair(frames);
    // Each cross-origin target has its own performance time origin. With the
    // clock frozen before navigation, navigation and OOPIF creation can
    // therefore leave different (but deterministic) target-local values. The
    // ownership invariant is that every target's exact value remains frozen,
    // not that unrelated documents both happen to read 1000 ms.
    const targetLocalTimesExact = Number.isFinite(before.main.performanceNow)
      && Number.isFinite(before.oopif.performanceNow)
      && afterRealDelay.main.performanceNow === before.main.performanceNow
      && afterRealDelay.oopif.performanceNow === before.oopif.performanceNow;
    const countersFrozen = before.main.rafCount === afterRealDelay.main.rafCount
      && before.oopif.rafCount === afterRealDelay.oopif.rafCount;
    const installedInBoth = [before.main, before.oopif, afterRealDelay.main, afterRealDelay.oopif]
      .every((state) => state.clockInjected && state.requestAnimationFrameWrapped);
    return {
      targets: target.pair,
      before,
      afterRealDelay,
      targetLocalTimesExact,
      countersFrozen,
      pass: target.pair.distinctOopifTargets && targetLocalTimesExact && countersFrozen && installedInBoth,
    };
  } finally {
    await Promise.all(sessions.map((session) => session.detach().catch(() => undefined)));
    await context.close();
  }
}

async function runPreNavigationClockEscapes(browser: Browser, url: string): Promise<PreNavigationClockEscapeReport> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const sessions: CDPSession[] = [];
  try {
    await page.clock.install({ time: 1_000_000 });
    await page.clock.pauseAt(1_001_000);
    await page.goto(`${url}?builtinEscape=1&workerEscape=1`);
    const frames = await fixtureFrames(page);
    const target = await clockTargets(context, page, frames);
    sessions.push(...target.sessions);
    await delayRealTime(100);
    const afterPause = await readClockPair(frames);
    await delayRealTime(100);
    const afterRealDelay = await readClockPair(frames);
    const exposedClocksFrozen = afterPause.main.performanceNow === afterRealDelay.main.performanceNow
      && afterPause.oopif.performanceNow === afterRealDelay.oopif.performanceNow
      && [afterPause.main, afterPause.oopif, afterRealDelay.main, afterRealDelay.oopif]
        .every((state) => state.clockInjected && state.requestAnimationFrameWrapped);
    const benignCountersFrozen = afterPause.main.rafCount === afterRealDelay.main.rafCount
      && afterPause.oopif.rafCount === afterRealDelay.oopif.rafCount;
    const exposedNativeCallbacksAdvanced = afterRealDelay.main.builtinRafCount > afterPause.main.builtinRafCount
      && afterRealDelay.oopif.builtinRafCount > afterPause.oopif.builtinRafCount
      && [afterPause.main, afterPause.oopif, afterRealDelay.main, afterRealDelay.oopif]
        .every((state) => state.nativeClockBuiltinsExposed);
    const workerCallbacksAdvanced = afterRealDelay.main.workerRafCount > afterPause.main.workerRafCount
      && afterRealDelay.oopif.workerRafCount > afterPause.oopif.workerRafCount;
    return {
      targets: target.pair,
      afterPause,
      afterRealDelay,
      exposedClocksFrozen,
      benignCountersFrozen,
      exposedNativeCallbacksAdvanced,
      workerCallbacksAdvanced,
      pass: target.pair.distinctOopifTargets
        && exposedClocksFrozen
        && benignCountersFrozen
        && exposedNativeCallbacksAdvanced
        && workerCallbacksAdvanced,
    };
  } finally {
    await Promise.all(sessions.map((session) => session.detach().catch(() => undefined)));
    await context.close();
  }
}

async function runLateClockEscape(browser: Browser, url: string): Promise<LateClockEscapeReport> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const sessions: CDPSession[] = [];
  try {
    await page.goto(`${url}?nativeEscape=1`);
    const frames = await fixtureFrames(page);
    const target = await clockTargets(context, page, frames);
    sessions.push(...target.sessions);
    await delayRealTime(50);
    await page.clock.install({ time: 2_000_000 });
    // Pause immediately after installation; the exact elapsed fake time is not
    // part of this late-install discriminator, while allowing it to run before
    // the pause makes the fixed target host-speed dependent.
    await page.clock.pauseAt(2_001_000);
    const afterPause = await readClockPair(frames);
    await delayRealTime(100);
    const afterRealDelay = await readClockPair(frames);
    const exposedClocksFrozen = afterPause.main.performanceNow === afterRealDelay.main.performanceNow
      && afterPause.oopif.performanceNow === afterRealDelay.oopif.performanceNow
      && [afterPause.main, afterPause.oopif, afterRealDelay.main, afterRealDelay.oopif]
        .every((state) => state.clockInjected && state.requestAnimationFrameWrapped);
    const savedNativeCallbacksAdvanced = afterRealDelay.main.rafCount > afterPause.main.rafCount
      && afterRealDelay.oopif.rafCount > afterPause.oopif.rafCount;
    return {
      targets: target.pair,
      afterPause,
      afterRealDelay,
      exposedClocksFrozen,
      savedNativeCallbacksAdvanced,
      pass: target.pair.distinctOopifTargets && exposedClocksFrozen && savedNativeCallbacksAdvanced,
    };
  } finally {
    await Promise.all(sessions.map((session) => session.detach().catch(() => undefined)));
    await context.close();
  }
}

async function runNativeOwnership(browser: Browser, url: string): Promise<TimelineSamplingOwnershipReport["native"]> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const sessions: CDPSession[] = [];
  try {
    await page.goto(url);
    let frames = await fixtureFrames(page);
    const mainCdp = await enableTarget(context, page);
    const oopifCdp = await enableTarget(context, frames.oopif);
    sessions.push(mainCdp, oopifCdp);
    const reports = await Promise.all([
      runNativeFrame("main", frames.main, mainCdp),
      runNativeFrame("oopif", frames.oopif, oopifCdp),
    ]);
    const targets = targetPair(reports[0].identity, reports[1].identity);

    // Restore the untouched fixture before asking the current capture helper to
    // classify progress timelines and observing its own two-rAF prepasses.
    await page.reload();
    frames = await fixtureFrames(page);
    const captureBoundary = await runCaptureBoundary(page, frames);
    return {
      targets,
      frames: reports,
      captureBoundary,
      pass: targets.distinctOopifTargets && reports.every((report) => report.pass) && captureBoundary.pass,
    };
  } finally {
    await Promise.all(sessions.map((session) => session.detach().catch(() => undefined)));
    await context.close();
  }
}

export function validateTimelineOwnershipCorpus(): string[] {
  const errors: string[] = [];
  if (new Set(REQUIRED_TIMELINE_OWNERSHIP_DISCRIMINATORS).size !== REQUIRED_TIMELINE_OWNERSHIP_DISCRIMINATORS.length) {
    errors.push("timeline discriminator ids must be unique");
  }
  for (const required of [
    "absolute-milliseconds-rejected",
    "projective-html-box-does-not-retime-view-timeline",
    "transformed-svg-subject-retimes-view-timeline",
    "closed-shadow-progress-fails-before-mutation",
    "document-and-open-shadow-progress-held",
    "pre-navigation-clock-exposes-native-raf-escape",
    "pre-navigation-clock-does-not-own-worker-raf",
    "late-clock-cannot-own-saved-native-raf",
  ] as const) {
    if (!REQUIRED_TIMELINE_OWNERSHIP_DISCRIMINATORS.includes(required)) {
      errors.push(`missing required discriminator ${required}`);
    }
  }
  if (TIMELINE_OWNERSHIP_SOURCE_PINS.chromium.length !== 40) errors.push("Chromium source pin must be a full SHA");
  return errors;
}

export async function runTimelineSamplingOwnershipOracle(): Promise<TimelineSamplingOwnershipReport> {
  const corpusErrors = validateTimelineOwnershipCorpus();
  if (corpusErrors.length > 0) throw new Error(corpusErrors.join("\n"));
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true, args: ["--site-per-process"] });
  let identityContext: BrowserContext | null = null;
  try {
    const url = `http://127.0.0.1:${fixture.port}/main`;
    identityContext = await browser.newContext();
    const identityPage = await identityContext.newPage();
    const identityCdp = await identityContext.newCDPSession(identityPage);
    const version = await identityCdp.send("Browser.getVersion");
    await identityCdp.detach();
    await identityContext.close();
    identityContext = null;

    const native = await runNativeOwnership(browser, url);
    const benignPreNavigation = await runPreNavigationClock(browser, url);
    const preNavigationEscapes = await runPreNavigationClockEscapes(browser, url);
    const lateNativeEscape = await runLateClockEscape(browser, url);
    const clocks = {
      benignPreNavigation,
      preNavigationEscapes,
      lateNativeEscape,
      pass: benignPreNavigation.pass && preNavigationEscapes.pass && lateNativeEscape.pass,
    };
    const allFrames = native.frames;
    const discriminators: Record<TimelineOwnershipDiscriminator, boolean> = {
      "absolute-milliseconds-rejected": allFrames.every((frame) => frame.absoluteSeek.pass),
      "transformed-scroller-does-not-retime-scroll-timeline": allFrames.every((frame) => frame.transformedScroller.pass),
      "projective-html-box-does-not-retime-view-timeline": allFrames.every((frame) => frame.projectiveHtmlSubject.pass),
      "transformed-svg-subject-retimes-view-timeline": allFrames.every((frame) => frame.transformedSvgSubject.pass),
      "percentage-hold-freezes-effect-not-source": allFrames.every((frame) => frame.heldEffects.pass),
      "closed-shadow-progress-fails-before-mutation": native.captureBoundary.closedScopeRejected,
      "document-and-open-shadow-progress-held": native.captureBoundary.reachableProgressHeld
        && native.captureBoundary.rafMutatedDuringCaptureSettle,
      "pre-navigation-clock-freezes-benign-main-and-oopif-raf": benignPreNavigation.pass,
      "pre-navigation-clock-exposes-native-raf-escape": preNavigationEscapes.exposedNativeCallbacksAdvanced,
      "pre-navigation-clock-does-not-own-worker-raf": preNavigationEscapes.workerCallbacksAdvanced,
      "late-clock-cannot-own-saved-native-raf": lateNativeEscape.pass,
    };
    const playwrightPackage = require("playwright-core/package.json") as { version: string };
    const playwrightPackagePath = require.resolve("playwright-core/package.json");
    const playwrightRoot = dirname(playwrightPackagePath);
    const clockServerPath = resolve(playwrightRoot, "lib/server/clock.js");
    const clockInjectedPath = resolve(playwrightRoot, "lib/generated/clockSource.js");
    const pass = native.pass && clocks.pass && Object.values(discriminators).every(Boolean);
    return {
      schemaVersion: 2,
      ticket: "DM-2553",
      contract: "source-exact-progress-timeline-ownership-no-pixels",
      generatedAt: new Date().toISOString(),
      sourcePins: TIMELINE_OWNERSHIP_SOURCE_PINS,
      environment: {
        browserProduct: version.product,
        browserRevision: version.revision,
        protocolVersion: version.protocolVersion,
        playwrightVersion: playwrightPackage.version,
        playwrightClockServerSha256: sha256(readFileSync(clockServerPath)),
        playwrightClockInjectedSha256: sha256(readFileSync(clockInjectedPath)),
        os: platform(),
        osRelease: release(),
        architecture: arch(),
        node: process.version,
      },
      native,
      clocks,
      discriminators,
      freezeableStates: [
        "A resolved ScrollTimeline/ViewTimeline effect can be held at its exact CSS percentage after pause and compositor commit; the source timeline remains independently scroll-owned.",
        "A benign main/OOPIF callback that uses the replaced global requestAnimationFrame function stops under a pre-navigation Playwright clock; this is a narrow observation, not an ownership boundary.",
      ],
      failClosedStates: [
        "An animationTimeMs number has no defined conversion to a progress timeline percentage.",
        "An inactive or unresolved progress timeline has no CSS percentage to hold and authenticate.",
        "Document.getAnimations() proves only its requested TreeScope; an unenumerated open or closed shadow-root progress animation is not safe to ignore.",
        "An SVG-child ViewTimeline subject has transform-sensitive mapped bounding-box size even though subject position ignores transforms; HTML/CSS-box transform invariance cannot be generalized to SVG.",
        "A scroll/view source offset, range geometry, or compositor snapshot that drifts between prepasses is not frozen by holding only its effects.",
        "Playwright exposes its saved native requestAnimationFrame function through page-visible __pwClock.builtins, so pre-navigation installation and a frozen fake performance clock are insufficient ownership proof.",
        "Dedicated-worker requestAnimationFrame is outside BrowserContext init scripts and can continue posting mutations while page clocks are paused.",
        "A late clock install cannot intercept a callback retaining the native requestAnimationFrame function.",
        "Cross-target state without distinct main/OOPIF identities and authenticated target-local clock installation cannot be treated as one deterministic frame.",
      ],
      pass,
    };
  } finally {
    await identityContext?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    await stopServer(fixture.server);
  }
}

async function main(): Promise<void> {
  const report = await runTimelineSamplingOwnershipOracle();
  const outputIndex = process.argv.indexOf("--json");
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
  if (output) {
    const absolute = resolve(ROOT, output);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.pass) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}

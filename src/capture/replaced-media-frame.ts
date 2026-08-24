import { createHash, randomUUID } from "node:crypto";
import type { Frame, Page } from "@playwright/test";
import type { StableAnimationFrameState } from "./animation-frame.js";
import type { StableCaptureRafState } from "./raf-clock.js";
import type { CapturedElement } from "./types.js";

export const REPLACED_MEDIA_FRAME_PROTOCOL = "domotion-replaced-media-frame-v1" as const;
export const REPLACED_MEDIA_CHROMIUM_REVISION = "7d859f271cbda744098ac69f44978d4edfa62be3" as const;

export type ReplacedMediaKind =
  | "canvas"
  | "video"
  | "iframe"
  | "object"
  | "embed"
  | "custom-element"
  | "image-replacement";

export interface ReplacedMediaDimensions {
  cssWidth: number;
  cssHeight: number;
  intrinsicWidth: number;
  intrinsicHeight: number;
}

export interface ReplacedMediaFrameOwner {
  rid: string;
  kind: ReplacedMediaKind;
  readyState: number | null;
  requestedTimeSeconds: number | null;
  currentTimeSeconds: number | null;
  dimensions: ReplacedMediaDimensions;
  frameEpoch: string;
  capturedByteDigest: string;
  sourceIdentity: string;
}

export interface StableReplacedMediaFrameState {
  protocol: typeof REPLACED_MEDIA_FRAME_PROTOCOL;
  chromiumRevision: typeof REPLACED_MEDIA_CHROMIUM_REVISION;
  requestedTimeMs: number;
  documentIdentity: string;
  frameUrls: string[];
  frameEpoch: string;
  rafProtocol: StableCaptureRafState["protocol"];
  animationSource: StableAnimationFrameState["source"];
  owners: ReplacedMediaFrameOwner[];
}

interface BrowserOwnerFact {
  rid: string;
  kind: ReplacedMediaKind;
  connected: boolean;
  readyState: number | null;
  requestedTimeSeconds: number | null;
  currentTimeSeconds: number | null;
  dimensions: ReplacedMediaDimensions;
  frameEpoch: string;
  sourceIdentity: string;
  canvasDataUrl: string | null;
}

export interface ComparableReplacedMediaOwnerFact {
  rid: string;
  kind: ReplacedMediaKind;
  connected: boolean;
  readyState: number | null;
  requestedTimeSeconds: number | null;
  currentTimeSeconds: number | null;
  dimensions: ReplacedMediaDimensions;
  frameEpoch: string;
  sourceIdentity: string;
  surfaceDigest: string | null;
}

interface BoundTarget {
  element: CapturedElement;
  snapshot: NonNullable<CapturedElement["replacedSnapshot"]>;
  kind: ReplacedMediaKind;
}

export interface ReplacedMediaFrameTransaction {
  bindCapturedOwners(tree: CapturedElement[]): Promise<void>;
  finalize(tree: CapturedElement[]): Promise<StableReplacedMediaFrameState>;
  dispose(): Promise<void>;
}

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

function digestDataUri(uri: string, expectedMime?: string): string {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(uri);
  if (match == null || (expectedMime != null && match[1] !== expectedMime)) {
    throw new Error(`replaced-media transaction received a non-${expectedMime ?? "base64"} raster`);
  }
  return sha256(Buffer.from(match[2], "base64"));
}

function comparableFact(fact: BrowserOwnerFact): ComparableReplacedMediaOwnerFact {
  return {
    rid: fact.rid,
    kind: fact.kind,
    connected: fact.connected,
    readyState: fact.readyState,
    requestedTimeSeconds: fact.requestedTimeSeconds,
    currentTimeSeconds: fact.currentTimeSeconds,
    dimensions: fact.dimensions,
    frameEpoch: fact.frameEpoch,
    sourceIdentity: fact.sourceIdentity,
    surfaceDigest: fact.canvasDataUrl == null ? null : digestDataUri(fact.canvasDataUrl, "image/png"),
  };
}

/** Pure exact comparator used by the hostile transition controls. */
export function replacedMediaOwnerFactDifferences(
  expected: ComparableReplacedMediaOwnerFact,
  actual: ComparableReplacedMediaOwnerFact,
): string[] {
  const differences: string[] = [];
  const compare = (name: string, left: unknown, right: unknown): void => {
    if (left !== right) differences.push(name);
  };
  compare("rid", expected.rid, actual.rid);
  compare("kind", expected.kind, actual.kind);
  compare("connected", expected.connected, actual.connected);
  compare("readyState", expected.readyState, actual.readyState);
  compare("requestedTimeSeconds", expected.requestedTimeSeconds, actual.requestedTimeSeconds);
  compare("currentTimeSeconds", expected.currentTimeSeconds, actual.currentTimeSeconds);
  compare("cssWidth", expected.dimensions.cssWidth, actual.dimensions.cssWidth);
  compare("cssHeight", expected.dimensions.cssHeight, actual.dimensions.cssHeight);
  compare("intrinsicWidth", expected.dimensions.intrinsicWidth, actual.dimensions.intrinsicWidth);
  compare("intrinsicHeight", expected.dimensions.intrinsicHeight, actual.dimensions.intrinsicHeight);
  compare("frameEpoch", expected.frameEpoch, actual.frameEpoch);
  compare("sourceIdentity", expected.sourceIdentity, actual.sourceIdentity);
  compare("surfaceDigest", expected.surfaceDigest, actual.surfaceDigest);
  return differences;
}

function targetKind(element: CapturedElement): ReplacedMediaKind {
  if (element.imageReplacement != null) return "image-replacement";
  if (element.tag === "canvas" || element.tag === "video" || element.tag === "iframe"
      || element.tag === "object" || element.tag === "embed") return element.tag;
  return "custom-element";
}

function collectBoundTargets(tree: CapturedElement[]): BoundTarget[] {
  const targets: BoundTarget[] = [];
  const visit = (nodes: CapturedElement[], projectiveOwner: boolean): void => {
    for (const element of nodes) {
      const ownsProjectiveSurface = projectiveOwner || element.transformSubtreeRaster != null;
      if (element.replacedSnapshot != null && !ownsProjectiveSurface) {
        targets.push({ element, snapshot: element.replacedSnapshot, kind: targetKind(element) });
      }
      visit(element.children ?? [], ownsProjectiveSurface);
    }
  };
  visit(tree, false);
  return targets;
}

function exactFrameSet(expected: Frame[], expectedUrls: string[], actual: Frame[]): boolean {
  return expected.length === actual.length
    && expectedUrls.length === actual.length
    && expected.every((frame, index) => frame === actual[index] && expectedUrls[index] === actual[index]?.url());
}

/**
 * Begin the strict replaced-media transaction after the caller-owned page/rAF
 * clocks have committed, but before any capture prepass. Chromium owns the
 * decoded/presented frame; this code records and freezes that ownership rather
 * than attempting to reproduce playback in SVG.
 */
export async function prepareReplacedMediaFrameTransaction(
  page: Page,
  selector: string,
  viewport: { x: number; y: number; width: number; height: number },
  animationState: StableAnimationFrameState,
  rafState: StableCaptureRafState,
): Promise<ReplacedMediaFrameTransaction> {
  if (animationState.requestedTimeMs !== rafState.requestedTimeMs) {
    throw new Error("replaced-media transaction requires one page/rAF requested time");
  }
  const requestedTimeMs = animationState.requestedTimeMs;
  if (!Number.isFinite(requestedTimeMs) || requestedTimeMs < 0) {
    throw new Error("replaced-media transaction requires a finite non-negative time");
  }

  const stateKey = `__domotionReplacedMedia_${randomUUID().replaceAll("-", "")}`;
  const releasePageState = async (): Promise<void> => {
    await page.evaluate(async (key) => {
      type Entry = {
        element: Element;
        originalCurrentTime: number | null;
        originalPaused: boolean | null;
        callbackId: number | null;
      };
      type State = { active: boolean; entries: Entry[] };
      const scope = globalThis as typeof globalThis & Record<string, unknown>;
      const state = scope[key] as State | undefined;
      if (state == null) return;
      state.active = false;
      for (const entry of state.entries) {
        if (!(entry.element instanceof HTMLVideoElement)) continue;
        if (entry.callbackId != null && typeof entry.element.cancelVideoFrameCallback === "function") {
          entry.element.cancelVideoFrameCallback(entry.callbackId);
        }
        try {
          if (entry.originalCurrentTime != null) entry.element.currentTime = entry.originalCurrentTime;
          if (entry.originalPaused === false) await entry.element.play();
        } catch {}
      }
      delete scope[key];
    }, stateKey).catch(() => undefined);
  };
  await page.evaluate("globalThis.__name ||= (target => target)");
  let documentIdentity: string;
  try {
    documentIdentity = await page.evaluate(async ({ key, rootSelector, rect, requestedSeconds, protocol }) => {
      type VideoFrameMetadataLike = {
        mediaTime: number;
        presentedFrames: number;
        width: number;
        height: number;
      };
      type TransactionEntry = {
        element: Element;
        kind: ReplacedMediaKind;
        rid: string;
        requestedTimeSeconds: number | null;
        originalCurrentTime: number | null;
        originalPaused: boolean | null;
        callbackId: number | null;
        videoEpoch: VideoFrameMetadataLike | null;
        preflightSignature: string;
      };
      type TransactionState = {
        protocol: string;
        active: boolean;
        documentIdentity: string;
        entries: TransactionEntry[];
        bound: TransactionEntry[];
        mediaFailure: string | null;
      };
      const scope = globalThis as typeof globalThis & Record<string, unknown>;
      const root = document.querySelector(rootSelector);
      if (root == null) throw new Error(`replaced-media transaction selector not found: ${rootSelector}`);
      const documentIdentity = `${document.URL}\n${performance.timeOrigin}`;
      const state: TransactionState = {
        protocol,
        active: true,
        documentIdentity,
        entries: [],
        bound: [],
        mediaFailure: null,
      };
      Object.defineProperty(scope, key, { configurable: true, enumerable: false, value: state });

      const visible = (element: Element): boolean => {
        const box = element.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0 || getComputedStyle(element).display === "none") return false;
        return box.right >= rect.x && box.bottom >= rect.y
          && box.left <= rect.x + rect.width && box.top <= rect.y + rect.height;
      };
      const candidates = [root, ...Array.from(root.querySelectorAll("canvas,video"))]
        .filter((element, index, values) => values.indexOf(element) === index)
        .filter((element) => (element instanceof HTMLCanvasElement || element instanceof HTMLVideoElement) && visible(element));

      const waitFor = (target: EventTarget, eventName: string, predicate: () => boolean): Promise<void> => {
        if (predicate()) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => finish(new Error(`timed out waiting for ${eventName}`)), 5000);
          const failed = () => finish(new Error(`media failed while waiting for ${eventName}`));
          const ready = () => { if (predicate()) finish(); };
          const finish = (error?: Error) => {
            clearTimeout(timeout);
            target.removeEventListener(eventName, ready);
            target.removeEventListener("error", failed);
            error == null ? resolve() : reject(error);
          };
          target.addEventListener(eventName, ready);
          target.addEventListener("error", failed, { once: true });
        });
      };

      for (const element of candidates) {
        if (element instanceof HTMLCanvasElement) {
          // Origin-clean readback is the exact mutation witness. A tainted canvas
          // is still capturable observationally, but cannot enter this strict
          // transaction because its surface cannot be reverified.
          const box = element.getBoundingClientRect();
          const preflightSignature = JSON.stringify({
            surface: element.toDataURL("image/png"),
            css: [box.width, box.height],
            intrinsic: [element.width, element.height],
          });
          state.entries.push({
            element,
            kind: "canvas",
            rid: "",
            requestedTimeSeconds: null,
            originalCurrentTime: null,
            originalPaused: null,
            callbackId: null,
            videoEpoch: null,
            preflightSignature,
          });
          continue;
        }

        const video = element as HTMLVideoElement;
        await waitFor(video, "loadedmetadata", () => video.readyState >= HTMLMediaElement.HAVE_METADATA);
        if (!Number.isFinite(video.duration) || requestedSeconds > video.duration) {
          throw new Error(`video cannot seek to requested capture time ${requestedSeconds}`);
        }
        const originalCurrentTime = video.currentTime;
        const originalPaused = video.paused;
        video.pause();
        const entry: TransactionEntry = {
          element: video,
          kind: "video",
          rid: "",
          requestedTimeSeconds: requestedSeconds,
          originalCurrentTime,
          originalPaused,
          callbackId: null,
          videoEpoch: null,
          preflightSignature: "",
        };
        state.entries.push(entry);
        if (typeof video.requestVideoFrameCallback !== "function") {
          throw new Error("requestVideoFrameCallback is unavailable for deterministic video capture");
        }
        const firstPresented = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("timed out waiting for a presented video frame")), 5000);
          const observe = (_now: number, metadata: VideoFrameCallbackMetadata) => {
            entry.videoEpoch = {
              mediaTime: metadata.mediaTime,
              presentedFrames: metadata.presentedFrames,
              width: metadata.width,
              height: metadata.height,
            };
            clearTimeout(timeout);
            resolve();
            if (state.active) entry.callbackId = video.requestVideoFrameCallback(observe);
          };
          entry.callbackId = video.requestVideoFrameCallback(observe);
        });
        video.currentTime = requestedSeconds;
        await waitFor(video, "seeked", () => !video.seeking && video.currentTime === requestedSeconds);
        await waitFor(video, "loadeddata", () => video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA);
        await firstPresented;
        video.pause();
        const box = video.getBoundingClientRect();
        entry.preflightSignature = JSON.stringify({
          readyState: video.readyState,
          currentTime: video.currentTime,
          css: [box.width, box.height],
          intrinsic: [video.videoWidth, video.videoHeight],
          source: video.currentSrc || video.src,
          epoch: entry.videoEpoch,
        });
      }
      return documentIdentity;
    }, {
      key: stateKey,
      rootSelector: selector,
      rect: viewport,
      requestedSeconds: requestedTimeMs / 1000,
      protocol: REPLACED_MEDIA_FRAME_PROTOCOL,
    });
  } catch (error) {
    await releasePageState();
    throw error;
  }

  const expectedFrames = page.frames();
  const expectedFrameUrls = expectedFrames.map((frame) => frame.url());
  const baselines = new Map<string, ComparableReplacedMediaOwnerFact>();
  let boundTargets: BoundTarget[] = [];
  let finalized = false;
  let disposed = false;

  const readBoundFacts = async (): Promise<BrowserOwnerFact[]> => page.evaluate(({ key, protocol }) => {
    type VideoEpoch = { mediaTime: number; presentedFrames: number; width: number; height: number };
    type Entry = {
      element: Element;
      kind: ReplacedMediaKind;
      rid: string;
      requestedTimeSeconds: number | null;
      videoEpoch: VideoEpoch | null;
    };
    type State = {
      protocol: string;
      active: boolean;
      documentIdentity: string;
      bound: Entry[];
      mediaFailure: string | null;
    };
    const state = (globalThis as typeof globalThis & Record<string, unknown>)[key] as State | undefined;
    if (state == null || !state.active || state.protocol !== protocol) {
      throw new Error("replaced-media transaction state is unavailable");
    }
    if (state.documentIdentity !== `${document.URL}\n${performance.timeOrigin}`) {
      throw new Error("document navigation changed during replaced-media capture");
    }
    if (state.mediaFailure != null) throw new Error(state.mediaFailure);
    const dimensions = (element: Element): ReplacedMediaDimensions => {
      const box = element.getBoundingClientRect();
      if (element instanceof HTMLCanvasElement) {
        return { cssWidth: box.width, cssHeight: box.height, intrinsicWidth: element.width, intrinsicHeight: element.height };
      }
      if (element instanceof HTMLVideoElement) {
        return { cssWidth: box.width, cssHeight: box.height, intrinsicWidth: element.videoWidth, intrinsicHeight: element.videoHeight };
      }
      return { cssWidth: box.width, cssHeight: box.height, intrinsicWidth: element.clientWidth, intrinsicHeight: element.clientHeight };
    };
    const sourceIdentity = (entry: Entry): string => {
      const element = entry.element;
      if (element instanceof HTMLVideoElement) return element.currentSrc || element.src;
      if (element instanceof HTMLIFrameElement) return element.src;
      if (element instanceof HTMLObjectElement) return element.data;
      if (element instanceof HTMLEmbedElement) return element.src;
      return `${element.localName}:${element.id}:${element.className}`;
    };
    return state.bound.map((entry): BrowserOwnerFact => {
      const element = entry.element;
      const video = element instanceof HTMLVideoElement ? element : null;
      const canvas = element instanceof HTMLCanvasElement ? element : null;
      if (video?.error != null) throw new Error(`video decoder drifted for ${entry.rid}`);
      const videoEpoch = entry.videoEpoch == null ? "" : [
        entry.videoEpoch.presentedFrames,
        entry.videoEpoch.mediaTime,
        entry.videoEpoch.width,
        entry.videoEpoch.height,
      ].join(":");
      const frameEpoch = canvas != null
        ? `canvas:${canvas.width}x${canvas.height}`
        : video != null ? `video:${videoEpoch}` : `document:${state.documentIdentity}`;
      return {
        rid: entry.rid,
        kind: entry.kind,
        connected: element.isConnected,
        readyState: video?.readyState ?? null,
        requestedTimeSeconds: entry.requestedTimeSeconds,
        currentTimeSeconds: video?.currentTime ?? null,
        dimensions: dimensions(element),
        frameEpoch,
        sourceIdentity: sourceIdentity(entry),
        canvasDataUrl: canvas?.toDataURL("image/png") ?? null,
      };
    });
  }, { key: stateKey, protocol: REPLACED_MEDIA_FRAME_PROTOCOL });

  return {
    async bindCapturedOwners(tree: CapturedElement[]): Promise<void> {
      if (disposed || finalized) throw new Error("replaced-media transaction is no longer active");
      boundTargets = collectBoundTargets(tree);
      const owners = boundTargets.map(({ snapshot, kind }) => ({ rid: snapshot.rid, kind }));
      if (new Set(owners.map((owner) => owner.rid)).size !== owners.length) {
        throw new Error("replaced-media transaction received duplicate owner ids");
      }
      await page.evaluate(({ key, owners }) => {
        type Entry = {
          element: Element;
          kind: ReplacedMediaKind;
          rid: string;
          requestedTimeSeconds: number | null;
          originalCurrentTime: number | null;
          originalPaused: boolean | null;
          callbackId: number | null;
          videoEpoch: unknown;
          preflightSignature: string;
        };
        type State = { active: boolean; entries: Entry[]; bound: Entry[] };
        const state = (globalThis as typeof globalThis & Record<string, unknown>)[key] as State | undefined;
        if (state == null || !state.active) throw new Error("replaced-media transaction state is unavailable");
        state.bound = owners.map(({ rid, kind }) => {
          const element = document.querySelector(`[data-domotion-rid="${rid}"]`);
          if (element == null) throw new Error(`replaced-media owner ${rid} detached before binding`);
          const prepared = state.entries.find((entry) => entry.element === element);
          if (kind === "canvas" || kind === "video") {
            if (prepared == null || prepared.kind !== kind) {
              throw new Error(`replaced-media owner ${rid} missed preflight`);
            }
            const box = element.getBoundingClientRect();
            const signature = element instanceof HTMLCanvasElement
              ? JSON.stringify({
                  surface: element.toDataURL("image/png"),
                  css: [box.width, box.height],
                  intrinsic: [element.width, element.height],
                })
              : element instanceof HTMLVideoElement
                ? JSON.stringify({
                    readyState: element.readyState,
                    currentTime: element.currentTime,
                    css: [box.width, box.height],
                    intrinsic: [element.videoWidth, element.videoHeight],
                    source: element.currentSrc || element.src,
                    epoch: prepared.videoEpoch,
                  })
                : "";
            if (signature !== prepared.preflightSignature) {
              throw new Error(`replaced-media owner ${rid} drifted between preflight and binding`);
            }
            prepared.rid = rid;
            return prepared;
          }
          return {
            element,
            kind,
            rid,
            requestedTimeSeconds: null,
            originalCurrentTime: null,
            originalPaused: null,
            callbackId: null,
            videoEpoch: null,
            preflightSignature: "",
          };
        });
      }, { key: stateKey, owners });
      const facts = await readBoundFacts();
      for (const fact of facts) baselines.set(fact.rid, comparableFact(fact));
      if (baselines.size !== boundTargets.length) {
        throw new Error("replaced-media transaction did not bind every raster owner");
      }
    },

    async finalize(tree: CapturedElement[]): Promise<StableReplacedMediaFrameState> {
      if (disposed || finalized) throw new Error("replaced-media transaction is no longer active");
      const currentTargets = collectBoundTargets(tree);
      if (currentTargets.length !== boundTargets.length
          || currentTargets.some((target, index) => target.snapshot.rid !== boundTargets[index]?.snapshot.rid)) {
        throw new Error("replaced-media owner set changed during capture");
      }
      if (!exactFrameSet(expectedFrames, expectedFrameUrls, page.frames())) {
        throw new Error("frame navigation changed during replaced-media capture");
      }
      const actualFacts = await readBoundFacts();
      const actualByRid = new Map(actualFacts.map((fact) => [fact.rid, comparableFact(fact)]));
      const owners: ReplacedMediaFrameOwner[] = [];
      for (const target of currentTargets) {
        const expected = baselines.get(target.snapshot.rid);
        const actual = actualByRid.get(target.snapshot.rid);
        if (expected == null || actual == null) {
          throw new Error(`replaced-media owner ${target.snapshot.rid} lost its transaction fact`);
        }
        const differences = replacedMediaOwnerFactDifferences(expected, actual);
        if (differences.length > 0) {
          throw new Error(`replaced-media owner ${target.snapshot.rid} drifted: ${differences.join(", ")}`);
        }
        if (target.snapshot.dataUri == null) {
          throw new Error(`replaced-media owner ${target.snapshot.rid} was not screenshotted`);
        }
        const capturedByteDigest = digestDataUri(target.snapshot.dataUri, "image/png");
        const owner: ReplacedMediaFrameOwner = {
          rid: actual.rid,
          kind: actual.kind,
          readyState: actual.readyState,
          requestedTimeSeconds: actual.requestedTimeSeconds,
          currentTimeSeconds: actual.currentTimeSeconds,
          dimensions: actual.dimensions,
          frameEpoch: `${actual.frameEpoch}:${actual.surfaceDigest ?? "presented"}`,
          capturedByteDigest,
          sourceIdentity: actual.sourceIdentity,
        };
        target.snapshot.frameTransaction = owner;
        owners.push(owner);
      }
      const frameEpoch = sha256(JSON.stringify({
        documentIdentity,
        requestedTimeMs,
        frames: expectedFrameUrls,
        owners: owners.map(({ rid, frameEpoch, capturedByteDigest }) => ({ rid, frameEpoch, capturedByteDigest })),
      }));
      finalized = true;
      return {
        protocol: REPLACED_MEDIA_FRAME_PROTOCOL,
        chromiumRevision: REPLACED_MEDIA_CHROMIUM_REVISION,
        requestedTimeMs,
        documentIdentity,
        frameUrls: expectedFrameUrls,
        frameEpoch,
        rafProtocol: rafState.protocol,
        animationSource: animationState.source,
        owners,
      };
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await releasePageState();
    },
  };
}

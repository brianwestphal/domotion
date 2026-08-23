/**
 * CDP-authenticated frame/scroll ownership for one capture (DM-2537).
 *
 * Chromium's inspector publishes IdentifiersFactory::FrameId in the default
 * execution-context auxData and uses the same id in Page.Frame and
 * DOMSnapshot.DocumentSnapshot.  We handshake a private random token through
 * each Playwright Frame's main world, then read that token through CDP.  This
 * avoids URL, name, child-order and geometry correlation, all of which are
 * ambiguous for repeated/nested frames.
 *
 * Pinned Chromium 7d859f271cbda744098ac69f44978d4edfa62be3:
 * - inspector/main_thread_debugger.cc:128-145 (default-context auxData)
 * - inspector/identifiers_factory.cc:84-92 (DevTools frame-token identity)
 * - inspector/inspector_page_agent.cc:1468-1501 (frame/parent serialization)
 * - public/devtools_protocol/domains/Target.pdl:20-35 (OOPIF target/parent ids)
 * - paint/paint_layer_scrollable_area.cc:619-649 (raw/snap scroll offset owner)
 */

import { createHash, randomUUID } from "node:crypto";
import type { CDPSession, Frame, Page } from "@playwright/test";

import { frameHostAllowed, parseCrossOriginAllowlist } from "./script/cross-origin.js";
import type {
  CapturedFrameAccess,
  CapturedFrameScrollOwner,
  CapturedFrameScrollRecord,
  CapturedFrameScrollState,
  CaptureWarning,
} from "./types.js";

interface FrameSetup {
  frame: Frame;
  token: string;
  url: string;
  origin: string;
  parentReadable: boolean;
  frameOffsetX: number;
  frameOffsetY: number;
  frameScaleX: number;
  frameScaleY: number;
  frameClip: { x: number; y: number; width: number; height: number } | null;
  axisAligned: boolean;
}

export interface PreparedFrameScrollFrame {
  frame: Frame;
  token: string;
  frameId: string;
  parentFrameId: string | null;
  origin: string;
  access: CapturedFrameAccess;
  allowlistMatched: boolean;
  readableFromParent: boolean;
  reachableFromTop: boolean;
  frameOffsetX: number;
  frameOffsetY: number;
  frameScaleX: number;
  frameScaleY: number;
  frameClip: { x: number; y: number; width: number; height: number } | null;
  axisAligned: boolean;
  diagnostic?: string;
}

export interface PreparedFrameScrollCapture {
  /** Private per-frame main-world registry read by CAPTURE_SCRIPT. */
  propertyKey: string;
  captureId: string;
  topFrameId: string;
  allowlistCanonical: string;
  allowlistSha256: string;
  frames: readonly PreparedFrameScrollFrame[];
  warnings: CaptureWarning[];
  snapshot(): Promise<CapturedFrameScrollState>;
  dispose(): Promise<void>;
}

interface RuntimeContextRow {
  contextId: number;
  frameId: string;
}

interface ProtocolFrameTree {
  frame: { id: string; parentId?: string };
  childFrames?: ProtocolFrameTree[];
}

interface ProtocolTargetInfo {
  targetId: string;
  type: string;
  parentFrameId?: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalAllowlist(raw: string | undefined): string {
  const parsed = parseCrossOriginAllowlist(raw);
  if (parsed == null) return "";
  if (parsed === "*") return "*";
  return [...new Set(parsed.map(({ host, port }) => `${host}${port == null ? "" : `:${port}`}`))]
    .sort()
    .join(",");
}

function frameTreePayload(frames: readonly CapturedFrameScrollRecord[]): string {
  return JSON.stringify([...frames]
    .sort((a, b) => a.frameId.localeCompare(b.frameId))
    .map(({ frameId, parentFrameId, origin, access, allowlistMatched, readableFromParent, reachableFromTop }) => ({
      frameId,
      parentFrameId,
      origin,
      access,
      allowlistMatched,
      readableFromParent,
      reachableFromTop,
    })));
}

function integrityPayload(state: Omit<CapturedFrameScrollState, "integritySha256">): string {
  return JSON.stringify({
    source: state.source,
    captureId: state.captureId,
    topFrameId: state.topFrameId,
    allowlist: state.allowlist,
    frameTreeSha256: state.frameTreeSha256,
    frames: [...state.frames]
      .sort((a, b) => a.frameId.localeCompare(b.frameId))
      .map((frame) => ({
        ...frame,
        scrollOwners: [...frame.scrollOwners].sort((a, b) => a.ownerId.localeCompare(b.ownerId)),
      })),
  });
}

export function sealCapturedFrameScrollState(
  state: Omit<CapturedFrameScrollState, "frameTreeSha256" | "integritySha256">,
): CapturedFrameScrollState {
  const frameTreeSha256 = sha256(frameTreePayload(state.frames));
  const unsigned: Omit<CapturedFrameScrollState, "integritySha256"> = {
    ...state,
    frameTreeSha256,
  };
  return { ...unsigned, integritySha256: sha256(integrityPayload(unsigned)) };
}

/** Structural + digest validation used before scroll composition. */
export function validateCapturedFrameScrollState(state: CapturedFrameScrollState): string[] {
  const failures: string[] = [];
  const validAccess = new Set<CapturedFrameAccess>([
    "top", "same-origin", "cross-origin-allowlisted", "cross-origin-denied",
    "inaccessible", "identity-unavailable",
  ]);
  if (state.source !== "chromium-cdp-frame-scroll-v1") failures.push("unknown frame-scroll source");
  if (state.captureId === "") failures.push("empty capture id");
  if (state.frames.length === 0) failures.push("empty frame graph");
  if (canonicalAllowlist(state.allowlist.canonical) !== state.allowlist.canonical) {
    failures.push("allowlist is not canonical");
  }
  if (sha256(state.allowlist.canonical) !== state.allowlist.sha256) failures.push("allowlist digest mismatch");
  const frameIds = new Set<string>();
  const ownerIds = new Set<string>();
  const parsedAllowlist = parseCrossOriginAllowlist(state.allowlist.canonical);
  for (const frame of state.frames) {
    if (frame.frameId === "") failures.push("empty frame id");
    if (frameIds.has(frame.frameId)) failures.push(`duplicate frame id ${frame.frameId}`);
    frameIds.add(frame.frameId);
    if (!validAccess.has(frame.access)) failures.push(`unknown access state on frame ${frame.frameId}`);
    if (frame.frameId === state.topFrameId && frame.access !== "top") {
      failures.push("top frame has a non-top access state");
    }
    if (frame.frameId !== state.topFrameId && frame.access === "top") {
      failures.push(`child frame ${frame.frameId} has a top access state`);
    }
    if (frame.access === "cross-origin-allowlisted" && !frame.allowlistMatched) {
      failures.push(`allowlisted frame ${frame.frameId} has no matching allowlist decision`);
    }
    if (frame.access === "cross-origin-allowlisted"
        && !frameHostAllowed(frame.origin, parsedAllowlist)) {
      failures.push(`allowlisted frame ${frame.frameId} is not authorized by the sealed allowlist`);
    }
    if (frame.access === "cross-origin-denied" && frame.allowlistMatched) {
      failures.push(`denied frame ${frame.frameId} carries an allowlist match`);
    }
    if (frame.access === "cross-origin-denied"
        && frameHostAllowed(frame.origin, parsedAllowlist)) {
      failures.push(`denied frame ${frame.frameId} is authorized by the sealed allowlist`);
    }
    if ((frame.access === "top" || frame.access === "same-origin") && frame.allowlistMatched) {
      failures.push(`same-origin frame ${frame.frameId} unexpectedly carries an allowlist match`);
    }
    if ((frame.access === "same-origin" || frame.access === "cross-origin-allowlisted")
        && !frame.readableFromParent) {
      failures.push(`readable child frame ${frame.frameId} was not readable from its parent`);
    }
    if (frame.access === "inaccessible" && frame.readableFromParent) {
      failures.push(`inaccessible frame ${frame.frameId} claims parent readability`);
    }
    const readableAccess = frame.access === "top" || frame.access === "same-origin"
      || frame.access === "cross-origin-allowlisted";
    const readable = frame.reachableFromTop && readableAccess;
    if (!readable && frame.scrollOwners.length !== 0) {
      failures.push(`fail-closed frame ${frame.frameId} leaked scroll owners`);
    }
    if (!readable && (frame.diagnostic == null || frame.diagnostic === "")) {
      failures.push(`fail-closed frame ${frame.frameId} omitted its diagnostic`);
    }
    if (readable && !frame.scrollOwners.some(({ kind }) => kind === "viewport")) {
      failures.push(`readable frame ${frame.frameId} has no viewport scroll owner`);
    }
    if (readable && frame.scrollOwners.filter(({ kind }) => kind === "viewport").length !== 1) {
      failures.push(`readable frame ${frame.frameId} has an ambiguous viewport scroll owner`);
    }
    for (const owner of frame.scrollOwners) {
      if (owner.frameId !== frame.frameId || owner.ownerId !== `${frame.frameId}:${owner.elementIndex}`) {
        failures.push(`scroll owner ${owner.ownerId} belongs to the wrong frame`);
      }
      if (ownerIds.has(owner.ownerId)) failures.push(`duplicate scroll owner ${owner.ownerId}`);
      ownerIds.add(owner.ownerId);
      for (const value of [
        owner.elementIndex, owner.scrollLeft, owner.scrollTop,
        owner.scrollWidth, owner.scrollHeight, owner.clientWidth, owner.clientHeight,
      ]) {
        if (!Number.isFinite(value)) failures.push(`non-finite scroll fact on ${owner.ownerId}`);
      }
      if (!Number.isInteger(owner.elementIndex) || owner.elementIndex < 0) {
        failures.push(`invalid live-node index on ${owner.ownerId}`);
      }
      if ([owner.scrollWidth, owner.scrollHeight, owner.clientWidth, owner.clientHeight].some((value) => value < 0)) {
        failures.push(`negative scroll extent on ${owner.ownerId}`);
      }
      if ((owner.kind !== "viewport" && owner.kind !== "element")
          || owner.tag === "" || owner.direction === "" || owner.writingMode === "") {
        failures.push(`invalid scroll owner metadata on ${owner.ownerId}`);
      }
    }
  }
  if (!frameIds.has(state.topFrameId)) failures.push("top frame id is absent from frame graph");
  for (const frame of state.frames) {
    if (frame.frameId === state.topFrameId && frame.parentFrameId != null) {
      failures.push("top frame unexpectedly has a parent");
    }
    if (frame.frameId !== state.topFrameId
        && (frame.parentFrameId == null || !frameIds.has(frame.parentFrameId))) {
      failures.push(`frame ${frame.frameId} has an unknown parent`);
    }
    if (frame.frameId === state.topFrameId && !frame.reachableFromTop) {
      failures.push("top frame is not reachable from itself");
    }
    if (frame.frameId !== state.topFrameId && frame.reachableFromTop) {
      const parent = state.frames.find(({ frameId }) => frameId === frame.parentFrameId);
      const readableAccess = frame.access === "same-origin" || frame.access === "cross-origin-allowlisted";
      if (parent?.reachableFromTop !== true || !readableAccess) {
        failures.push(`frame ${frame.frameId} has an impossible reachable ancestor chain`);
      }
    }
  }
  for (const frame of state.frames) {
    const ancestors = new Set<string>();
    let current: CapturedFrameScrollRecord | undefined = frame;
    while (current?.parentFrameId != null) {
      if (ancestors.has(current.frameId)) {
        failures.push(`frame ${frame.frameId} participates in a parent cycle`);
        break;
      }
      ancestors.add(current.frameId);
      current = state.frames.find(({ frameId }) => frameId === current!.parentFrameId);
    }
  }
  if (sha256(frameTreePayload(state.frames)) !== state.frameTreeSha256) failures.push("frame-tree digest mismatch");
  const { integritySha256: _ignored, ...unsigned } = state;
  if (sha256(integrityPayload(unsigned)) !== state.integritySha256) failures.push("frame-scroll integrity mismatch");
  return [...new Set(failures)];
}

/** Bind the composition-selected owner/offset to this immutable capture. */
export function capturedScrollOwnerBindingSha256(
  state: CapturedFrameScrollState,
  ownerId: string,
  scrollX: number,
  scrollY: number,
): string {
  return sha256(JSON.stringify({
    authority: state.integritySha256,
    ownerId,
    scrollX,
    scrollY,
  }));
}

async function setupFrame(
  frame: Frame,
  propertyKey: string,
  token: string,
  isTop: boolean,
): Promise<FrameSetup | null> {
  try {
    const own = await frame.evaluate(({ propertyKey, token }) => {
      Object.defineProperty(globalThis, propertyKey, {
        configurable: true,
        value: { token },
      });
      return {
        url: location.href,
        origin: location.origin || "null",
        width: window.innerWidth,
        height: window.innerHeight,
      };
    }, { propertyKey, token });
    if (isTop) {
      return {
        frame,
        token,
        url: own.url,
        origin: own.origin,
        parentReadable: true,
        frameOffsetX: 0,
        frameOffsetY: 0,
        frameScaleX: 1,
        frameScaleY: 1,
        frameClip: { x: 0, y: 0, width: own.width, height: own.height },
        axisAligned: true,
      };
    }
    const owner = await frame.frameElement();
    try {
      const [box, facts] = await Promise.all([
        owner.boundingBox(),
        owner.evaluate((element) => {
          const frameOwner = element as Element;
          const html = frameOwner as HTMLElement;
          const style = getComputedStyle(frameOwner);
          const rect = frameOwner.getBoundingClientRect();
          let readable = false;
          try {
            readable = html instanceof HTMLIFrameElement && html.contentDocument != null;
          } catch {
            readable = false;
          }
          const hasIndependentTransform = [style.translate, style.rotate, style.scale]
            .some((value) => value != null && value !== "" && value !== "none");
          let axisAligned = !hasIndependentTransform;
          if (style.transform !== "none") {
            try {
              const matrix = new DOMMatrixReadOnly(style.transform);
              axisAligned = axisAligned && matrix.is2D
                && matrix.a > 0 && matrix.d > 0
                && matrix.b === 0 && matrix.c === 0;
            } catch {
              axisAligned = false;
            }
          }
          return {
            readable,
            rectWidth: rect.width,
            rectHeight: rect.height,
            borderLeft: Number.parseFloat(style.borderLeftWidth) || 0,
            borderTop: Number.parseFloat(style.borderTopWidth) || 0,
            paddingLeft: Number.parseFloat(style.paddingLeft) || 0,
            paddingTop: Number.parseFloat(style.paddingTop) || 0,
            axisAligned,
          };
        }),
      ]);
      if (box == null) throw new Error("frame owner has no main-frame bounding box");
      const frameScaleX = facts.rectWidth > 0 ? box.width / facts.rectWidth : 1;
      const frameScaleY = facts.rectHeight > 0 ? box.height / facts.rectHeight : 1;
      const frameOffsetX = box.x + (facts.borderLeft + facts.paddingLeft) * frameScaleX;
      const frameOffsetY = box.y + (facts.borderTop + facts.paddingTop) * frameScaleY;
      return {
        frame,
        token,
        url: own.url,
        origin: own.origin,
        parentReadable: facts.readable,
        frameOffsetX,
        frameOffsetY,
        frameScaleX,
        frameScaleY,
        frameClip: {
          x: frameOffsetX,
          y: frameOffsetY,
          width: own.width * frameScaleX,
          height: own.height * frameScaleY,
        },
        axisAligned: facts.axisAligned,
      };
    } finally {
      await owner.dispose();
    }
  } catch {
    return null;
  }
}

function flattenProtocolFrameTree(tree: ProtocolFrameTree, output = new Map<string, string | null>()): Map<string, string | null> {
  output.set(tree.frame.id, tree.frame.parentId ?? null);
  for (const child of tree.childFrames ?? []) flattenProtocolFrameTree(child, output);
  return output;
}

async function collectDefaultContextTokens(
  session: CDPSession,
  propertyKey: string,
): Promise<Map<string, string>> {
  const contexts: RuntimeContextRow[] = [];
  session.on("Runtime.executionContextCreated", (event) => {
    const frameId = event.context.auxData?.frameId;
    if (event.context.auxData?.isDefault && typeof frameId === "string") {
      contexts.push({ contextId: event.context.id, frameId });
    }
  });
  await session.send("Runtime.enable");
  const byToken = new Map<string, string>();
  for (const context of contexts) {
    const result = await session.send("Runtime.evaluate", {
      expression: `globalThis[${JSON.stringify(propertyKey)}]?.token ?? ""`,
      contextId: context.contextId,
      returnByValue: true,
      silent: true,
    }).catch(() => null);
    const token = result?.result.value;
    if (typeof token === "string" && token !== "") byToken.set(token, context.frameId);
  }
  return byToken;
}

async function cdpFrameIds(page: Page, propertyKey: string, setups: readonly FrameSetup[]): Promise<{
  byToken: Map<string, string>;
  parents: Map<string, string | null>;
}> {
  const session = await page.context().newCDPSession(page);
  let byToken: Map<string, string>;
  let parents: Map<string, string | null>;
  try {
    await session.send("Page.enable");
    byToken = await collectDefaultContextTokens(session, propertyKey);
    const tree = await session.send("Page.getFrameTree") as unknown as { frameTree: ProtocolFrameTree };
    parents = flattenProtocolFrameTree(tree.frameTree);
    // Page.getFrameTree only contains the local-frame subtree of this target.
    // Site-isolated children are separate `iframe` targets; Chromium publishes
    // their exact target id (also the OOPIF's FrameId) and parent FrameId in
    // TargetInfo, so merge those protocol-owned edges into the same graph.
    const targets = await session.send("Target.getTargets") as unknown as {
      targetInfos: ProtocolTargetInfo[];
    };
    for (const target of targets.targetInfos) {
      if (target.type === "iframe" && target.parentFrameId != null) {
        parents.set(target.targetId, target.parentFrameId);
      }
    }
  } finally {
    await session.send("Runtime.disable").catch(() => undefined);
    await session.detach().catch(() => undefined);
  }

  // A CDP session on the top Page does not receive Runtime contexts owned by a
  // site-isolated OOPIF target. Playwright can attach a session to the Frame
  // itself; run the same private-token handshake only for unresolved frames.
  // Page.getFrameTree plus TargetInfo.parentFrameId above remain the protocol
  // parent-graph authority.
  const unresolved = setups.filter(({ token }) => !byToken.has(token));
  const oopifMaps = await Promise.all(unresolved.map(async ({ frame }) => {
    const frameSession = await page.context().newCDPSession(frame).catch(() => null);
    if (frameSession == null) return new Map<string, string>();
    try {
      return await collectDefaultContextTokens(frameSession, propertyKey);
    } catch {
      return new Map<string, string>();
    } finally {
      await frameSession.send("Runtime.disable").catch(() => undefined);
      await frameSession.detach().catch(() => undefined);
    }
  }));
  for (const map of oopifMaps) {
    for (const [token, frameId] of map) byToken.set(token, frameId);
  }
  return { byToken, parents };
}

function frameDiagnostic(
  frameId: string,
  origin: string,
  access: CapturedFrameAccess,
): string | undefined {
  if (access === "cross-origin-denied") {
    return `frame ${frameId} (${origin}) was denied by this capture's cross-origin allowlist; retained the Chromium raster and read no frame scroll state`;
  }
  if (access === "inaccessible") {
    return `frame ${frameId} (${origin}) was allowlisted/same-origin but inaccessible from its parent document; retained the Chromium raster and read no frame scroll state`;
  }
  if (access === "identity-unavailable") {
    return `frame identity could not be authenticated against Chromium's default execution context; retained the Chromium raster and read no frame scroll state`;
  }
  return undefined;
}

async function frameCaptureLiveness(
  frame: PreparedFrameScrollFrame,
  propertyKey: string,
  captureId: string,
  allowlistSha256: string,
): Promise<{ authorityMatches: boolean; parentReadable: boolean }> {
  const authorityMatches = await frame.frame.evaluate(({ propertyKey, expected }) => {
    const authority = (globalThis as typeof globalThis & Record<string, unknown>)[propertyKey] as {
      token?: string;
      source?: string;
      captureId?: string;
      frameId?: string;
      parentFrameId?: string | null;
      access?: CapturedFrameAccess;
      allowlistSha256?: string;
    } | undefined;
    return authority?.token === expected.token
      && authority.source === "chromium-cdp-frame-scroll-v1"
      && authority.captureId === expected.captureId
      && authority.frameId === expected.frameId
      && authority.parentFrameId === expected.parentFrameId
      && authority.access === expected.access
      && authority.allowlistSha256 === expected.allowlistSha256
      && (location.origin || "null") === expected.origin;
  }, {
    propertyKey,
    expected: {
      token: frame.token,
      captureId,
      frameId: frame.frameId,
      parentFrameId: frame.parentFrameId,
      access: frame.access,
      allowlistSha256,
      origin: frame.origin,
    },
  }).catch(() => false);
  if (frame.parentFrameId == null) return { authorityMatches, parentReadable: true };
  const owner = await frame.frame.frameElement().catch(() => null);
  if (owner == null) return { authorityMatches, parentReadable: false };
  try {
    const parentReadable = await owner.evaluate((element) => {
      try {
        return element instanceof HTMLIFrameElement && element.contentDocument != null;
      } catch {
        return false;
      }
    }).catch(() => false);
    return { authorityMatches, parentReadable };
  } finally {
    await owner.dispose();
  }
}

async function snapshotOwners(
  frame: PreparedFrameScrollFrame,
  propertyKey: string,
  captureId: string,
  allowlistSha256: string,
): Promise<CapturedFrameScrollOwner[]> {
  const rows = await frame.frame.evaluate(({ propertyKey, expected }) => {
    const authority = (globalThis as typeof globalThis & Record<string, unknown>)[propertyKey] as {
      token?: string;
      source?: string;
      captureId?: string;
      frameId?: string;
      parentFrameId?: string | null;
      access?: CapturedFrameAccess;
      allowlistSha256?: string;
    } | undefined;
    if (authority?.token !== expected.token
        || authority.source !== "chromium-cdp-frame-scroll-v1"
        || authority.captureId !== expected.captureId
        || authority.frameId !== expected.frameId
        || authority.parentFrameId !== expected.parentFrameId
        || authority.access !== expected.access
        || authority.allowlistSha256 !== expected.allowlistSha256
        || (location.origin || "null") !== expected.origin) {
      throw new Error("capture-local frame authority changed before scroll-owner sampling");
    }
    const root = document.documentElement;
    if (root == null) return [];
    const elements: Element[] = [];
    const stack: Element[] = [root];
    const seen = new Set<Element>();
    while (stack.length > 0) {
      const element = stack.pop()!;
      if (seen.has(element)) continue;
      seen.add(element);
      elements.push(element);
      const children: Element[] = [...element.children];
      if (element.shadowRoot != null) children.push(...element.shadowRoot.children);
      for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]!);
    }
    const rows: Array<{
      elementIndex: number;
      kind: "viewport" | "element";
      tag: string;
      direction: string;
      writingMode: string;
      scrollLeft: number;
      scrollTop: number;
      scrollWidth: number;
      scrollHeight: number;
      clientWidth: number;
      clientHeight: number;
    }> = [];
    for (let elementIndex = 0; elementIndex < elements.length; elementIndex++) {
      const element = elements[elementIndex]!;
      const style = getComputedStyle(element);
      const html = element as HTMLElement;
      const viewport = element === document.scrollingElement;
      const hasRange = html.scrollWidth > html.clientWidth || html.scrollHeight > html.clientHeight;
      const scrollStyle = [style.overflowX, style.overflowY].some((value) => value === "auto" || value === "scroll");
      if (!viewport && !hasRange && !scrollStyle && style.scrollbarGutter === "auto") continue;
      rows.push({
        elementIndex,
        kind: viewport ? "viewport" : "element",
        tag: element.localName,
        direction: style.direction,
        writingMode: style.writingMode,
        scrollLeft: html.scrollLeft ?? 0,
        scrollTop: html.scrollTop ?? 0,
        scrollWidth: html.scrollWidth ?? 0,
        scrollHeight: html.scrollHeight ?? 0,
        clientWidth: html.clientWidth ?? 0,
        clientHeight: html.clientHeight ?? 0,
      });
    }
    return rows;
  }, {
    propertyKey,
    expected: {
      token: frame.token,
      captureId,
      frameId: frame.frameId,
      parentFrameId: frame.parentFrameId,
      access: frame.access,
      allowlistSha256,
      origin: frame.origin,
    },
  });
  return rows.map((row) => ({
    ...row,
    frameId: frame.frameId,
    ownerId: `${frame.frameId}:${row.elementIndex}`,
  }));
}

/** Prepare one capture-local authority and install it into every authenticated frame. */
export async function prepareFrameScrollCapture(
  page: Page,
  rawAllowlist: string | undefined,
): Promise<PreparedFrameScrollCapture> {
  const captureId = randomUUID();
  const propertyKey = `__domotionFrameScroll_${captureId.replaceAll("-", "")}`;
  const initialFrames = page.frames();
  const setups = (await Promise.all(initialFrames.map((frame, index) => (
    setupFrame(frame, propertyKey, `${captureId}:${index}`, frame === page.mainFrame())
  )))).filter((entry): entry is FrameSetup => entry != null);
  let cdpIdentity: Awaited<ReturnType<typeof cdpFrameIds>>;
  try {
    cdpIdentity = await cdpFrameIds(page, propertyKey, setups);
  } catch (error) {
    await Promise.all(setups.map(({ frame }) => frame.evaluate((key) => {
      delete (globalThis as typeof globalThis & Record<string, unknown>)[key];
    }, propertyKey).catch(() => undefined)));
    throw error;
  }
  const { byToken, parents: protocolParents } = cdpIdentity;
  const byFrame = new Map<Frame, FrameSetup>(setups.map((entry) => [entry.frame, entry]));
  const allow = parseCrossOriginAllowlist(rawAllowlist);
  const allowlistCanonical = canonicalAllowlist(rawAllowlist);
  const allowlistSha256 = sha256(allowlistCanonical);
  const topSetup = byFrame.get(page.mainFrame());
  const topFrameId = topSetup == null ? "" : (byToken.get(topSetup.token) ?? "");
  const frames: PreparedFrameScrollFrame[] = [];
  for (const frame of initialFrames) {
    const setup = byFrame.get(frame);
    const frameId = setup == null ? "" : (byToken.get(setup.token) ?? "");
    const parent = frame.parentFrame();
    const parentSetup = parent == null ? null : byFrame.get(parent);
    const parentFrameId = parentSetup == null ? null : (byToken.get(parentSetup.token) ?? null);
    const protocolParent = frameId === "" ? undefined : protocolParents.get(frameId);
    const identityExact = setup != null && frameId !== "" && (
      frame === page.mainFrame()
        ? protocolParent === null
        : parentFrameId != null && protocolParent === parentFrameId
    );
    const origin = setup?.origin ?? "null";
    const parentOrigin = parentSetup?.origin ?? "null";
    const inheritedOrigin = origin === "" || origin === "null";
    // Origin access is an owner/child relationship, not a comparison with the
    // top page. In particular, a same-origin grandchild inside an allowlisted
    // foreign frame remains same-origin, while a grandchild that navigates
    // back to the top origin is cross-origin to its immediate owner and must
    // pass the allowlist again.
    const crossOrigin = parent != null && !inheritedOrigin && origin !== parentOrigin;
    const allowlistMatched = crossOrigin && setup != null && frameHostAllowed(setup.url, allow);
    let access: CapturedFrameAccess;
    let identityDiagnostic: string | undefined;
    if (!identityExact) {
      access = "identity-unavailable";
      if (setup == null) {
        identityDiagnostic = "frame setup became unavailable before Chromium identity authentication; retained the Chromium raster and read no frame scroll state";
      } else if (frameId === "") {
        identityDiagnostic = "frame identity could not be authenticated against Chromium's default execution context; retained the Chromium raster and read no frame scroll state";
      } else if (frame === page.mainFrame()) {
        identityDiagnostic = `top frame ${frameId} did not resolve as Chromium's root browsing context; retained the Chromium raster and read no frame scroll state`;
      } else if (parentFrameId == null) {
        identityDiagnostic = `frame ${frameId} had no authenticated parent-frame identity; retained the Chromium raster and read no frame scroll state`;
      } else if (protocolParent == null) {
        identityDiagnostic = `frame ${frameId} was absent from Chromium's Page.getFrameTree parent graph; retained the Chromium raster and read no frame scroll state`;
      } else {
        identityDiagnostic = `frame ${frameId} reported Chromium parent ${protocolParent}, not capture parent ${parentFrameId}; retained the Chromium raster and read no frame scroll state`;
      }
    }
    else if (frame === page.mainFrame()) access = "top";
    else if (crossOrigin && !allowlistMatched) access = "cross-origin-denied";
    else if (!setup.parentReadable) access = "inaccessible";
    else if (crossOrigin) access = "cross-origin-allowlisted";
    else access = "same-origin";
    const diagnostic = identityDiagnostic ?? frameDiagnostic(frameId || "unknown", origin, access);
    frames.push({
      frame,
      token: setup?.token ?? `${captureId}:missing`,
      frameId,
      parentFrameId,
      origin,
      access,
      allowlistMatched,
      readableFromParent: setup?.parentReadable ?? false,
      reachableFromTop: false,
      frameOffsetX: setup?.frameOffsetX ?? 0,
      frameOffsetY: setup?.frameOffsetY ?? 0,
      frameScaleX: setup?.frameScaleX ?? 1,
      frameScaleY: setup?.frameScaleY ?? 1,
      frameClip: setup?.frameClip ?? null,
      axisAligned: setup?.axisAligned ?? false,
      ...(diagnostic == null ? {} : { diagnostic }),
    });
  }
  const preparedByFrame = new Map(frames.map((frame) => [frame.frame, frame]));
  const geometryResolved = new Set<PreparedFrameScrollFrame>();
  const resolveFrameGeometry = (frame: PreparedFrameScrollFrame): void => {
    if (geometryResolved.has(frame)) return;
    const parentHandle = frame.frame.parentFrame();
    const parent = parentHandle == null ? undefined : preparedByFrame.get(parentHandle);
    if (parent != null) {
      resolveFrameGeometry(parent);
      frame.axisAligned = frame.axisAligned && parent.axisAligned;
      if (frame.frameClip != null && parent.frameClip != null) {
        const x = Math.max(frame.frameClip.x, parent.frameClip.x);
        const y = Math.max(frame.frameClip.y, parent.frameClip.y);
        const right = Math.min(
          frame.frameClip.x + frame.frameClip.width,
          parent.frameClip.x + parent.frameClip.width,
        );
        const bottom = Math.min(
          frame.frameClip.y + frame.frameClip.height,
          parent.frameClip.y + parent.frameClip.height,
        );
        frame.frameClip = {
          x,
          y,
          width: Math.max(0, right - x),
          height: Math.max(0, bottom - y),
        };
      }
    }
    geometryResolved.add(frame);
  };
  for (const frame of frames) resolveFrameGeometry(frame);

  const globalAuthorityInstalled = await Promise.all(frames.map((frame) => frame.frame.evaluate(({ propertyKey, authority }) => {
    const current = (globalThis as typeof globalThis & Record<string, unknown>)[propertyKey] as { token?: string } | undefined;
    if (current?.token !== authority.token) return false;
    Object.defineProperty(globalThis, propertyKey, {
      configurable: true,
      value: authority,
    });
    return true;
  }, {
    propertyKey,
    authority: {
      token: frame.token,
      source: "chromium-cdp-frame-scroll-v1",
      captureId,
      frameId: frame.frameId,
      parentFrameId: frame.parentFrameId,
      access: frame.access,
      allowlistSha256,
    },
  }).catch(() => false)));
  for (let index = 0; index < frames.length; index++) {
    if (globalAuthorityInstalled[index]) continue;
    const frame = frames[index]!;
    frame.access = "identity-unavailable";
    frame.diagnostic = `frame ${frame.frameId || "unknown"} navigated or became inaccessible before its capture-local Chromium authority could be installed; retained the Chromium raster and read no frame scroll state`;
  }

  // Bind the child authority directly to Chromium's iframe owner Element in
  // the immediate parent world. Reading contentWindow properties would itself
  // cross the Same-Origin Policy when web security is enabled, precisely where
  // the capture needs an exact identity for a fail-closed raster boundary.
  await Promise.all(frames.filter(({ parentFrameId }) => parentFrameId != null).map(async (frame) => {
    const owner = await frame.frame.frameElement().catch(() => null);
    let installed = false;
    if (owner == null) {
      frame.access = "identity-unavailable";
      frame.diagnostic = `frame ${frame.frameId || "unknown"} lost its Chromium frame-owner element before capture; retained the Chromium raster and read no frame scroll state`;
      return;
    }
    try {
      installed = await owner.evaluate((element, { propertyKey, authority }) => {
        Object.defineProperty(element, propertyKey, {
          configurable: true,
          value: authority,
        });
        return true;
      }, {
        propertyKey,
        authority: {
          token: frame.token,
          source: "chromium-cdp-frame-scroll-v1",
          captureId,
          frameId: frame.frameId,
          parentFrameId: frame.parentFrameId,
          access: frame.access,
          allowlistSha256,
        },
      }).catch(() => false);
    } finally {
      await owner.dispose();
    }
    if (!installed) {
      frame.access = "identity-unavailable";
      frame.diagnostic = `frame ${frame.frameId || "unknown"} could not bind its capture-local authority to the exact Chromium frame-owner element; retained the Chromium raster and read no frame scroll state`;
    }
  }));

  const resolving = new Set<PreparedFrameScrollFrame>();
  const resolveReachability = (frame: PreparedFrameScrollFrame): boolean => {
    if (frame.reachableFromTop) return true;
    if (resolving.has(frame)) return false;
    resolving.add(frame);
    const readableAccess = frame.access === "top" || frame.access === "same-origin"
      || frame.access === "cross-origin-allowlisted";
    const parentHandle = frame.frame.parentFrame();
    const parent = parentHandle == null ? undefined : preparedByFrame.get(parentHandle);
    frame.reachableFromTop = readableAccess && (
      frame.frame === page.mainFrame() ? frame.access === "top" : parent != null && resolveReachability(parent)
    );
    if (!frame.reachableFromTop && frame.diagnostic == null) {
      frame.diagnostic = `frame ${frame.frameId || "unknown"} is below an inaccessible or denied ancestor browsing context; retained the ancestor Chromium raster and read no descendant scroll state`;
    }
    resolving.delete(frame);
    return frame.reachableFromTop;
  };
  for (const frame of frames) resolveReachability(frame);

  const warnings: CaptureWarning[] = frames.flatMap((frame) => frame.diagnostic == null ? [] : [{
    selector: `frame[${frame.frameId || "unknown"}]`,
    feature: "cross-origin-frame-scroll",
    detail: frame.diagnostic,
    status: "unavailable" as const,
  }]);

  const snapshot = async (): Promise<CapturedFrameScrollState> => {
    const records = await Promise.all(frames.map(async (frame): Promise<CapturedFrameScrollRecord> => {
      let canRead = frame.reachableFromTop && (
        frame.access === "top" || frame.access === "same-origin"
          || frame.access === "cross-origin-allowlisted"
      );
      let scrollOwners: CapturedFrameScrollOwner[] = [];
      let access = frame.access;
      let diagnostic = frame.diagnostic;
      let reachableFromTop = canRead;
      let readableFromParent = frame.readableFromParent;
      const live = await frameCaptureLiveness(
        frame,
        propertyKey,
        captureId,
        allowlistSha256,
      );
      readableFromParent = live.parentReadable;
      if (!live.authorityMatches) {
        access = "identity-unavailable";
        canRead = false;
        reachableFromTop = false;
        diagnostic = `frame ${frame.frameId || "unknown"} navigated or lost its capture-local Chromium authority before scroll-owner sampling; retained the Chromium raster and read no frame scroll state`;
      } else if (canRead && !live.parentReadable) {
        access = "inaccessible";
        canRead = false;
        reachableFromTop = false;
        diagnostic = `frame ${frame.frameId || "unknown"} became inaccessible from its parent before scroll-owner sampling; retained the Chromium raster and read no frame scroll state`;
      }
      if (canRead) {
        try {
          scrollOwners = await snapshotOwners(
            frame,
            propertyKey,
            captureId,
            allowlistSha256,
          );
        } catch (error) {
          access = "inaccessible";
          reachableFromTop = false;
          readableFromParent = false;
          diagnostic = `frame ${frame.frameId} scroll ownership became inaccessible during capture (${error instanceof Error ? error.message : String(error)}); retained no frame scroll state`;
        }
      }
      return {
        frameId: frame.frameId,
        parentFrameId: frame.parentFrameId,
        origin: frame.origin,
        access,
        allowlistMatched: frame.allowlistMatched,
        readableFromParent,
        reachableFromTop,
        scrollOwners,
        ...(diagnostic == null ? {} : { diagnostic }),
      };
    }));
    const recordsById = new Map(records.map((record) => [record.frameId, record]));
    const resolved = new Set<CapturedFrameScrollRecord>();
    const resolvingRecords = new Set<CapturedFrameScrollRecord>();
    const resolveRecordReachability = (record: CapturedFrameScrollRecord): boolean => {
      if (resolved.has(record)) return record.reachableFromTop;
      if (resolvingRecords.has(record)) return false;
      resolvingRecords.add(record);
      const readableAccess = record.access === "top" || record.access === "same-origin"
        || record.access === "cross-origin-allowlisted";
      const parent = record.parentFrameId == null ? undefined : recordsById.get(record.parentFrameId);
      record.reachableFromTop = record.reachableFromTop && readableAccess && (
        record.frameId === topFrameId ? record.access === "top" : parent != null && resolveRecordReachability(parent)
      );
      if (!record.reachableFromTop) {
        record.scrollOwners = [];
        record.diagnostic ??= `frame ${record.frameId || "unknown"} is below a frame that became inaccessible during capture; retained the ancestor Chromium raster and read no descendant scroll state`;
      }
      resolvingRecords.delete(record);
      resolved.add(record);
      return record.reachableFromTop;
    };
    for (const record of records) resolveRecordReachability(record);
    for (const record of records) {
      if (record.diagnostic == null || warnings.some((warning) => warning.detail === record.diagnostic)) continue;
      warnings.push({
        selector: `frame[${record.frameId || "unknown"}]`,
        feature: "cross-origin-frame-scroll",
        detail: record.diagnostic,
        status: "unavailable",
      });
    }
    return sealCapturedFrameScrollState({
      source: "chromium-cdp-frame-scroll-v1",
      captureId,
      topFrameId,
      allowlist: { canonical: allowlistCanonical, sha256: allowlistSha256 },
      frames: records,
    });
  };

  return {
    propertyKey,
    captureId,
    topFrameId,
    allowlistCanonical,
    allowlistSha256,
    frames,
    warnings,
    snapshot,
    dispose: async () => {
      await Promise.all(initialFrames.map(async (frame) => {
        await frame.evaluate((key) => {
          delete (globalThis as typeof globalThis & Record<string, unknown>)[key];
        }, propertyKey).catch(() => undefined);
        if (frame === page.mainFrame()) return;
        const owner = await frame.frameElement().catch(() => null);
        if (owner == null) return;
        try {
          await owner.evaluate((element, key) => {
            delete (element as Element & Record<string, unknown>)[key];
          }, propertyKey).catch(() => undefined);
        } finally {
          await owner.dispose();
        }
      }));
    },
  };
}

import { createHash, randomUUID } from "node:crypto";
import type { CDPSession, Page } from "@playwright/test";

export const AUTHENTICATED_ANIMATED_IMAGE_BYTE_PROTOCOL =
  "domotion-animated-image-bytes-v1" as const;

export const AUTHENTICATED_ANIMATED_IMAGE_LIMITS = Object.freeze({
  maximumOwners: 128,
  maximumResourceBytes: 64 * 1024 * 1024,
  maximumTotalBytes: 256 * 1024 * 1024,
  maximumRedirects: 20,
});

export type AnimatedImageByteFailureCode =
  | "strict-owner-not-found" | "ambiguous-owner" | "unsupported-owner"
  | "stale-document" | "candidate-drift" | "missing-request-ledger"
  | "ambiguous-resource" | "redirect-limit-exceeded" | "response-drift"
  | "cache-entry-unsupported" | "service-worker-unsupported"
  | "body-evicted" | "body-limit-exceeded" | "body-length-mismatch"
  | "body-digest-mismatch" | "cors-denied" | "credential-mode-mismatch"
  | "unsupported-mime" | "multipart-response" | "unsupported-scheme"
  | "data-url-parse-failed" | "blob-unavailable";

export class AnimatedImageByteCollectorError extends Error {
  constructor(readonly code: AnimatedImageByteFailureCode) {
    super(code);
    this.name = "AnimatedImageByteCollectorError";
  }
}

export interface StrictAnimatedImageFrameRequest {
  selector: string;
  frameIndex: number;
  /** Omit for the legacy <img>/<picture>/<input type=image> owner. */
  slot?: "svg-href" | "background-image" | "border-image-source" | "mask-image" | "list-style-image";
  /** Required for CSS slots; identifies the top-level computed-value item. */
  index?: number;
}

export type AnimatedImageOwnerKind = "html-image" | "input-image" | "svg-image" | "css-image";
export type AnimatedImageOwnerSlot = "html-current" | "input-src" | "svg-href" |
  "background-image" | "border-image-source" | "mask-image" | "list-style-image";

interface LedgerEntry {
  requestId: string;
  requestUrl: string;
  requestedUrls: string[];
  frameId: string;
  loaderId: string;
  requestMode: string;
  credentialsMode: string;
  redirects: Array<{ url: string; status: number; mimeType: string }>;
  response?: {
    url: string; status: number; mimeType: string; rawContentType: string;
    fromDiskCache: boolean; fromServiceWorker: boolean;
  };
  completed: boolean;
  failed: boolean;
  servedFromCache: boolean;
}

export interface AuthenticatedAnimatedImageByteRecord {
  protocol: typeof AUTHENTICATED_ANIMATED_IMAGE_BYTE_PROTOCOL;
  selector: string;
  requestedFrameIndex: number;
  ownerKind: AnimatedImageOwnerKind;
  ownerSlot: AnimatedImageOwnerSlot;
  ownerSlotIndex: number | null;
  ownerSerializedValue: string;
  backendNodeId: number;
  frameId: string;
  documentLoaderId: string;
  documentNonce: string;
  selectedUrl: string;
  currentSrc: string;
  devicePixelRatio: number;
  viewport: { width: number; height: number };
  requestId: string | null;
  redirectHops: Array<{ url: string; status: number; mimeType: string }>;
  responseUrl: string;
  responseStatus: number;
  mimeType: string;
  rawContentType: string;
  requestMode: string;
  credentialsMode: string;
  transport: "network-get-response-body" | "data-url" | "blob-read";
  byteLength: number;
  sha256: string;
  epochDigest: string;
}

export interface AuthenticatedAnimatedImageBytes {
  record: AuthenticatedAnimatedImageByteRecord;
  /** Returns a fresh immutable-copy boundary for DM-2579. */
  copyBytes(): Uint8Array;
}

export function authenticatedAnimatedImageRecordDigest(
  record: Omit<AuthenticatedAnimatedImageByteRecord, "epochDigest">,
): string {
  return sha256(canonical(record));
}

export function verifyAuthenticatedAnimatedImageBytes(
  record: AuthenticatedAnimatedImageByteRecord,
  bytes: Uint8Array,
): void {
  const { epochDigest, ...logical } = record;
  if (authenticatedAnimatedImageRecordDigest(logical) !== epochDigest) fail("response-drift");
  if (bytes.byteLength !== record.byteLength) fail("body-length-mismatch");
  if (sha256(bytes) !== record.sha256) fail("body-digest-mismatch");
}

interface OwnerSnapshot {
  ownerKind: AnimatedImageOwnerKind;
  ownerSlot: AnimatedImageOwnerSlot;
  ownerSlotIndex: number | null;
  ownerSerializedValue: string;
  backendNodeId: number;
  frameId: string;
  documentLoaderId: string;
  documentNonce: string;
  selectedUrl: string;
  currentSrc: string;
  devicePixelRatio: number;
  viewport: { width: number; height: number };
}

const MIME = new Set(["image/gif", "image/png", "image/apng", "image/webp"]);
const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value != null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fail(code: AnimatedImageByteFailureCode): never {
  throw new AnimatedImageByteCollectorError(code);
}

function dataUrlBytes(url: string): Uint8Array {
  const match = /^data:([^,]*?),(.*)$/s.exec(url);
  if (match == null) fail("data-url-parse-failed");
  try {
    const metadata = match[1];
    return metadata.split(";").some((part) => part.toLowerCase() === "base64")
      ? Buffer.from(match[2], "base64")
      : Buffer.from(decodeURIComponent(match[2]), "utf8");
  } catch { return fail("data-url-parse-failed"); }
}

async function snapshotOwner(
  page: Page, cdp: CDPSession, request: StrictAnimatedImageFrameRequest,
): Promise<OwnerSnapshot> {
  const { selector } = request;
  const evaluated = await cdp.send("Runtime.evaluate", {
    expression: `document.querySelectorAll(${JSON.stringify(selector)}).length`, returnByValue: true,
  });
  const count = evaluated.result.value as number;
  if (count === 0) fail("strict-owner-not-found");
  if (count !== 1) fail("ambiguous-owner");
  const handle = await page.$(selector);
  if (handle == null) fail("strict-owner-not-found");
  const domDocument = await cdp.send("DOM.getDocument", { depth: 0, pierce: false });
  const queried = await cdp.send("DOM.querySelector", { nodeId: domDocument.root.nodeId, selector });
  const described = await cdp.send("DOM.describeNode", { nodeId: queried.nodeId });
  const backendNodeId = described.node.backendNodeId;
  const facts = await handle.evaluate((node, requested) => {
    const nonce = (globalThis as typeof globalThis & { __domotionAnimatedImageDocumentNonce?: string })
      .__domotionAnimatedImageDocumentNonce ?? "";
    if (requested.slot == null && node instanceof HTMLImageElement) return {
      ownerKind: "html-image" as const, ownerSlot: "html-current" as const,
      ownerSlotIndex: null, ownerSerializedValue: node.currentSrc || node.src,
      selectedUrl: node.currentSrc || node.src, currentSrc: node.currentSrc,
      nonce, dpr: devicePixelRatio, viewport: { width: innerWidth, height: innerHeight },
    };
    if (requested.slot == null && node instanceof HTMLInputElement && node.type === "image") return {
      ownerKind: "input-image" as const, ownerSlot: "input-src" as const,
      ownerSlotIndex: null, ownerSerializedValue: node.src,
      selectedUrl: node.src, currentSrc: "", nonce, dpr: devicePixelRatio,
      viewport: { width: innerWidth, height: innerHeight },
    };
    const splitTopLevel = (value: string): string[] => {
      const output: string[] = []; let start = 0; let depth = 0; let quote = "";
      for (let index = 0; index < value.length; index++) {
        const ch = value[index];
        if (quote !== "") { if (ch === "\\") index++; else if (ch === quote) quote = ""; continue; }
        if (ch === "\"" || ch === "'") quote = ch;
        else if (ch === "(") depth++;
        else if (ch === ")") depth--;
        else if (ch === "," && depth === 0) { output.push(value.slice(start, index).trim()); start = index + 1; }
      }
      output.push(value.slice(start).trim()); return output;
    };
    const plainUrl = (value: string): string | null => {
      const match = /^url\(\s*(["']?)(.*?)\1\s*\)$/i.exec(value);
      return match == null || /[\\\r\n]/.test(match[2]) ? null : match[2];
    };
    if (requested.slot === "svg-href" && node instanceof SVGImageElement && requested.index == null) {
      const raw = node.href.baseVal; if (raw === "") return null;
      return { ownerKind: "svg-image" as const, ownerSlot: "svg-href" as const,
        ownerSlotIndex: null, ownerSerializedValue: raw,
        selectedUrl: new URL(raw, document.baseURI).href, currentSrc: "", nonce,
        dpr: devicePixelRatio, viewport: { width: innerWidth, height: innerHeight } };
    }
    const cssSlots = new Set(["background-image", "border-image-source", "mask-image", "list-style-image"]);
    if (requested.slot != null && cssSlots.has(requested.slot) &&
        Number.isInteger(requested.index) && (requested.index ?? -1) >= 0) {
      const serialized = getComputedStyle(node).getPropertyValue(requested.slot);
      const item = splitTopLevel(serialized)[requested.index!]; const raw = item == null ? null : plainUrl(item);
      if (raw == null) return null;
      return { ownerKind: "css-image" as const, ownerSlot: requested.slot,
        ownerSlotIndex: requested.index!, ownerSerializedValue: serialized,
        selectedUrl: new URL(raw, document.baseURI).href, currentSrc: "", nonce,
        dpr: devicePixelRatio, viewport: { width: innerWidth, height: innerHeight } };
    }
    return null;
  }, request);
  await handle.dispose();
  if (facts == null) fail("unsupported-owner");
  const tree = await cdp.send("Page.getFrameTree");
  return {
    ownerKind: facts.ownerKind, ownerSlot: facts.ownerSlot, ownerSlotIndex: facts.ownerSlotIndex,
    ownerSerializedValue: facts.ownerSerializedValue, backendNodeId,
    frameId: tree.frameTree.frame.id, documentLoaderId: tree.frameTree.frame.loaderId,
    documentNonce: facts.nonce, selectedUrl: facts.selectedUrl, currentSrc: facts.currentSrc,
    devicePixelRatio: facts.dpr, viewport: facts.viewport,
  };
}

export class AuthenticatedAnimatedImageByteCollector {
  private readonly ledger = new Map<string, LedgerEntry>();
  private readonly nonce = randomUUID();
  private totalBytes = 0;
  private constructor(private readonly page: Page, private readonly cdp: CDPSession) {}

  static async install(page: Page): Promise<AuthenticatedAnimatedImageByteCollector> {
    const collector = new AuthenticatedAnimatedImageByteCollector(
      page, await page.context().newCDPSession(page),
    );
    await page.context().addInitScript((nonce) => {
      Object.defineProperty(globalThis, "__domotionAnimatedImageDocumentNonce", {
        value: nonce, configurable: false, enumerable: false, writable: false,
      });
    }, collector.nonce);
    collector.cdp.on("Network.requestWillBeSent", (event) => {
      const prior = collector.ledger.get(event.requestId);
      const redirects = prior?.redirects ?? [];
      const requestedUrls = prior?.requestedUrls ?? [];
      if (event.redirectResponse != null) redirects.push({
        url: event.redirectResponse.url, status: event.redirectResponse.status,
        mimeType: event.redirectResponse.mimeType,
      });
      collector.ledger.set(event.requestId, {
        requestId: event.requestId, requestUrl: event.request.url,
        requestedUrls: [...requestedUrls, event.request.url],
        frameId: event.frameId ?? "", loaderId: event.loaderId,
        requestMode: "no-cors", credentialsMode: "include",
        redirects, completed: false, failed: false,
        servedFromCache: prior?.servedFromCache ?? false,
      });
    });
    collector.cdp.on("Network.responseReceived", (event) => {
      const entry = collector.ledger.get(event.requestId); if (entry == null) return;
      entry.response = {
        url: event.response.url, status: event.response.status, mimeType: event.response.mimeType,
        rawContentType: String(event.response.headers["content-type"] ?? event.response.headers["Content-Type"] ?? ""),
        fromDiskCache: (event.response.fromDiskCache ?? false) || entry.servedFromCache,
        fromServiceWorker: event.response.fromServiceWorker ?? false,
      };
    });
    collector.cdp.on("Network.loadingFinished", (event) => {
      const entry = collector.ledger.get(event.requestId); if (entry != null) entry.completed = true;
    });
    collector.cdp.on("Network.requestServedFromCache", (event) => {
      const entry = collector.ledger.get(event.requestId);
      if (entry != null) {
        entry.servedFromCache = true;
        if (entry.response != null) entry.response.fromDiskCache = true;
      }
    });
    collector.cdp.on("Network.loadingFailed", (event) => {
      const entry = collector.ledger.get(event.requestId); if (entry != null) entry.failed = true;
    });
    await Promise.all([
      collector.cdp.send("DOM.enable"), collector.cdp.send("Runtime.enable"), collector.cdp.send("Page.enable"),
      collector.cdp.send("Network.enable", {
        maxTotalBufferSize: AUTHENTICATED_ANIMATED_IMAGE_LIMITS.maximumTotalBytes,
        maxResourceBufferSize: AUTHENTICATED_ANIMATED_IMAGE_LIMITS.maximumResourceBytes,
        maxPostDataSize: 0,
      }),
    ]);
    return collector;
  }

  async collect(requests: readonly StrictAnimatedImageFrameRequest[]): Promise<AuthenticatedAnimatedImageBytes[]> {
    if (requests.length > AUTHENTICATED_ANIMATED_IMAGE_LIMITS.maximumOwners) fail("body-limit-exceeded");
    const results: AuthenticatedAnimatedImageBytes[] = [];
    const usedRequestIds = new Set<string>();
    const usedSelectedUrls = new Set<string>();
    for (const request of requests) {
      if (!Number.isInteger(request.frameIndex) || request.frameIndex < 0) fail("unsupported-owner");
      const result = await this.collectOne(request);
      if (usedSelectedUrls.has(result.record.selectedUrl)) fail("ambiguous-resource");
      usedSelectedUrls.add(result.record.selectedUrl);
      if (result.record.requestId != null && usedRequestIds.has(result.record.requestId)) {
        fail("ambiguous-resource");
      }
      if (result.record.requestId != null) usedRequestIds.add(result.record.requestId);
      results.push(result);
    }
    return results;
  }

  private async collectOne(request: StrictAnimatedImageFrameRequest): Promise<AuthenticatedAnimatedImageBytes> {
    const before = await snapshotOwner(this.page, this.cdp, request);
    if (before.documentNonce !== this.nonce) fail("stale-document");
    const url = new URL(before.selectedUrl, this.page.url());
    let bytes: Uint8Array; let entry: LedgerEntry | undefined; let transportMime = "";
    let ledgerDigestBefore: string | null = null;
    let transport: AuthenticatedAnimatedImageByteRecord["transport"];
    if (url.protocol === "http:" || url.protocol === "https:") {
      if (url.origin !== new URL(this.page.url()).origin) fail("cors-denied");
      const candidates = [...this.ledger.values()].filter((item) =>
        item.requestedUrls.includes(before.selectedUrl) && item.frameId === before.frameId &&
        item.loaderId === before.documentLoaderId && item.completed && !item.failed);
      if (candidates.length === 0) fail("missing-request-ledger");
      if (candidates.length !== 1) fail("ambiguous-resource");
      entry = candidates[0];
      ledgerDigestBefore = sha256(canonical(entry));
      if (entry.redirects.length > AUTHENTICATED_ANIMATED_IMAGE_LIMITS.maximumRedirects) fail("redirect-limit-exceeded");
      if (entry.response?.fromDiskCache) fail("cache-entry-unsupported");
      if (entry.response?.fromServiceWorker) fail("service-worker-unsupported");
      let response: Awaited<ReturnType<CDPSession["send"]>>;
      try { response = await this.cdp.send("Network.getResponseBody", { requestId: entry.requestId }); }
      catch { return fail("body-evicted"); }
      const body = response as { body: string; base64Encoded: boolean };
      bytes = Buffer.from(body.body, body.base64Encoded ? "base64" : "utf8");
      transport = "network-get-response-body";
    } else if (url.protocol === "data:") {
      bytes = dataUrlBytes(before.selectedUrl);
      transportMime = /^data:([^;,]+)/.exec(before.selectedUrl)?.[1] ?? "";
      transport = "data-url";
    } else if (url.protocol === "blob:") {
      if (url.origin !== new URL(this.page.url()).origin) fail("blob-unavailable");
      const read = async (): Promise<{ bytes: Uint8Array; mimeType: string }> => {
        const result = await this.page.evaluate(async (selectedUrl) => {
        const response = await fetch(selectedUrl); if (!response.ok) throw new Error();
        const data = new Uint8Array(await response.arrayBuffer());
        let binary = ""; for (const byte of data) binary += String.fromCharCode(byte);
        return { base64: btoa(binary), mimeType: response.headers.get("content-type") ?? "" };
        }, before.selectedUrl);
        return { bytes: Buffer.from(result.base64, "base64"), mimeType: result.mimeType };
      };
      try {
        const first = await read(); const repeated = await read(); bytes = first.bytes;
        if (sha256(bytes) !== sha256(repeated.bytes) || first.mimeType !== repeated.mimeType) fail("body-digest-mismatch");
        transportMime = first.mimeType;
      }
      catch (error) { if (error instanceof AnimatedImageByteCollectorError) throw error; return fail("blob-unavailable"); }
      transport = "blob-read";
    } else fail("unsupported-scheme");
    if (bytes.byteLength === 0 || bytes.byteLength > AUTHENTICATED_ANIMATED_IMAGE_LIMITS.maximumResourceBytes) fail("body-limit-exceeded");
    this.totalBytes += bytes.byteLength;
    if (this.totalBytes > AUTHENTICATED_ANIMATED_IMAGE_LIMITS.maximumTotalBytes) fail("body-limit-exceeded");
    const responseMime = (entry?.response?.mimeType ?? transportMime).toLowerCase();
    if (entry?.response?.rawContentType.toLowerCase().startsWith("multipart/")) fail("multipart-response");
    if (!MIME.has(responseMime)) fail("unsupported-mime");
    const logical = {
      protocol: AUTHENTICATED_ANIMATED_IMAGE_BYTE_PROTOCOL, selector: request.selector,
      requestedFrameIndex: request.frameIndex, ...before,
      requestId: entry?.requestId ?? null, redirectHops: entry?.redirects ?? [],
      responseUrl: entry?.response?.url ?? before.selectedUrl,
      responseStatus: entry?.response?.status ?? 200, mimeType: responseMime,
      rawContentType: entry?.response?.rawContentType ?? responseMime,
      requestMode: entry?.requestMode ?? "same-origin", credentialsMode: entry?.credentialsMode ?? "include",
      transport, byteLength: bytes.byteLength, sha256: sha256(bytes),
    };
    const record: AuthenticatedAnimatedImageByteRecord = {
      ...logical, epochDigest: authenticatedAnimatedImageRecordDigest(logical),
    };
    const after = await snapshotOwner(this.page, this.cdp, request);
    if (canonical(before) !== canonical(after)) fail("candidate-drift");
    if (entry != null && sha256(canonical(entry)) !== ledgerDigestBefore) fail("response-drift");
    verifyAuthenticatedAnimatedImageBytes(record, bytes);
    const retained = Uint8Array.from(bytes); bytes.fill(0);
    return { record, copyBytes: () => Uint8Array.from(retained) };
  }

  async dispose(): Promise<void> { await this.cdp.detach().catch(() => undefined); }
}

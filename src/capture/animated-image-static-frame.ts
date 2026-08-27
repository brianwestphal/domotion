import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import {
  AnimatedImageByteCollectorError,
  verifyAuthenticatedAnimatedImageBytes,
  type AuthenticatedAnimatedImageBytes,
} from "./authenticated-animated-image-bytes.js";

export const ANIMATED_IMAGE_STATIC_FRAME_MAX_COUNT = 4096;
export const ANIMATED_IMAGE_STATIC_FRAME_CHROMIUM_SOURCE_REVISION =
  "7d859f271cbda744098ac69f44978d4edfa62be3" as const;

export type AnimatedImageStaticFrameFailureCode =
  | "decoder-unavailable" | "insecure-decoder-context" | "unsupported-type"
  | "unselected-animation-track" | "static-image-track" | "unbounded-frame-count"
  | "frame-index-out-of-range" | "partial-frame" | "decoder-facts-mismatch"
  | "source-record-drift" | "replacement-missing";

export class AnimatedImageStaticFrameError extends Error {
  constructor(readonly code: AnimatedImageStaticFrameFailureCode) {
    super(code); this.name = "AnimatedImageStaticFrameError";
  }
}

export interface AnimatedImageFrameObservation {
  complete: boolean;
  rgbaSha256: string;
  pngSha256: string;
  codedWidth: number;
  codedHeight: number;
  displayWidth: number;
  displayHeight: number;
  visibleRect: { x: number; y: number; width: number; height: number } | null;
  timestamp: number;
  duration: number | null;
  format: string | null;
  colorSpace: {
    primaries: string | null; transfer: string | null; matrix: string | null;
    fullRange: boolean | null;
  };
}

export interface AnimatedImageStaticFrameRecord {
  selector: string;
  requestedFrameIndex: number;
  sourceEpochDigest: string;
  sourceSha256: string;
  mimeType: string;
  browser: { sourceRevision: typeof ANIMATED_IMAGE_STATIC_FRAME_CHROMIUM_SOURCE_REVISION; productVersion: string; userAgent: string; platform: string; secureContext: true };
  track: { selectedIndex: number; frameCount: number; animated: boolean; repetitionCount: string };
  observation: AnimatedImageFrameObservation;
  pngDataUrl: string;
  transactionDigest: string;
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value != null && typeof value === "object") return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
};
const fail = (code: AnimatedImageStaticFrameFailureCode): never => { throw new AnimatedImageStaticFrameError(code); };

export function verifyAnimatedImageStaticFrameRecord(record: AnimatedImageStaticFrameRecord): void {
  const { transactionDigest, ...logical } = record;
  if (digest(stable(logical)) !== transactionDigest) fail("decoder-facts-mismatch");
  if (!record.observation.complete) fail("partial-frame");
  if (!Number.isInteger(record.track.frameCount) || record.track.frameCount < 2 ||
      record.track.frameCount > ANIMATED_IMAGE_STATIC_FRAME_MAX_COUNT) fail("unbounded-frame-count");
  if (record.requestedFrameIndex < 0 || record.requestedFrameIndex >= record.track.frameCount) fail("frame-index-out-of-range");
}

export async function freezeAuthenticatedAnimatedImageFrames(
  page: Page,
  inputs: readonly AuthenticatedAnimatedImageBytes[],
): Promise<AnimatedImageStaticFrameRecord[]> {
  const records: AnimatedImageStaticFrameRecord[] = [];
  for (const input of inputs) {
    const sourceBytes = input.copyBytes();
    try { verifyAuthenticatedAnimatedImageBytes(input.record, sourceBytes); }
    catch (error) {
      if (error instanceof AnimatedImageByteCollectorError) fail("source-record-drift");
      throw error;
    }
    const browserVersion = page.context().browser()?.version() ?? "unknown";
    const output = await page.evaluate(async ({ selector, frameIndex, mimeType, base64, expected }) => {
      type Track = { frameCount: number; animated: boolean; repetitionCount: number };
      type DecodeResult = { image: VideoFrame; complete: boolean };
      type Decoder = { tracks: { ready: Promise<unknown>; selectedIndex: number; selectedTrack: Track | null };
        decode(value: { frameIndex: number; completeFramesOnly: boolean }): Promise<DecodeResult>; close(): void };
      type Constructor = { new(value: { data: Uint8Array; type: string; colorSpaceConversion: "default"; preferAnimation: boolean }): Decoder;
        isTypeSupported(type: string): Promise<boolean> };
      const ImageDecoderCtor = (globalThis as unknown as { ImageDecoder?: Constructor }).ImageDecoder;
      const hash = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest(
        "SHA-256", Uint8Array.from(bytes).buffer,
      ))]
        .map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      if (!isSecureContext) return { failure: "insecure-decoder-context" as const };
      if (ImageDecoderCtor == null) return { failure: "decoder-unavailable" as const };
      if (!await ImageDecoderCtor.isTypeSupported(mimeType)) return { failure: "unsupported-type" as const };
      const observe = async (decoder: Decoder, index: number) => {
        const result = await decoder.decode({ frameIndex: index, completeFramesOnly: true });
        const frame = result.image;
        try {
          const canvas = document.createElement("canvas"); canvas.width = frame.displayWidth; canvas.height = frame.displayHeight;
          const context = canvas.getContext("2d", { willReadFrequently: true }); if (context == null) throw new Error();
          context.drawImage(frame, 0, 0);
          const rgba = new Uint8Array(context.getImageData(0, 0, canvas.width, canvas.height).data);
          const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
          if (blob == null) throw new Error();
          const png = new Uint8Array(await blob.arrayBuffer());
          const pngBase64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader(); reader.onerror = () => reject(new Error());
            reader.onload = () => resolve(String(reader.result).split(",")[1] ?? ""); reader.readAsDataURL(blob);
          });
          const rect = frame.visibleRect;
          return { pngBase64, observation: {
            complete: result.complete, rgbaSha256: await hash(rgba), pngSha256: await hash(png),
            codedWidth: frame.codedWidth, codedHeight: frame.codedHeight,
            displayWidth: frame.displayWidth, displayHeight: frame.displayHeight,
            visibleRect: rect == null ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            timestamp: frame.timestamp, duration: frame.duration, format: frame.format,
            colorSpace: { primaries: frame.colorSpace.primaries, transfer: frame.colorSpace.transfer,
              matrix: frame.colorSpace.matrix, fullRange: frame.colorSpace.fullRange },
          } };
        } finally { frame.close(); }
      };
      const create = () => new ImageDecoderCtor({ data: bytes, type: mimeType, colorSpaceConversion: "default", preferAnimation: true });
      const proposal = create(); await proposal.tracks.ready; const selected = proposal.tracks.selectedTrack;
      if (selected == null) { proposal.close(); return { failure: "unselected-animation-track" as const }; }
      const track = { selectedIndex: proposal.tracks.selectedIndex, frameCount: selected.frameCount,
        animated: selected.animated, repetitionCount: Number.isFinite(selected.repetitionCount) ? String(selected.repetitionCount) : "Infinity" };
      if (!track.animated) { proposal.close(); return { failure: "static-image-track" as const }; }
      if (!Number.isInteger(track.frameCount) || track.frameCount < 2 || track.frameCount > 4096) {
        proposal.close(); return { failure: "unbounded-frame-count" as const };
      }
      if (frameIndex < 0 || frameIndex >= track.frameCount) { proposal.close(); return { failure: "frame-index-out-of-range" as const }; }
      const first = await observe(proposal, frameIndex); proposal.close();
      const validation = create(); await validation.tracks.ready;
      for (let index = track.frameCount - 1; index > frameIndex; index--) {
        const control = await validation.decode({ frameIndex: index, completeFramesOnly: true }); control.image.close();
      }
      const second = await observe(validation, frameIndex); validation.close();
      if (!first.observation.complete || !second.observation.complete) return { failure: "partial-frame" as const };
      if (JSON.stringify(first.observation) !== JSON.stringify(second.observation) || first.pngBase64 !== second.pngBase64) {
        return { failure: "decoder-facts-mismatch" as const };
      }
      const owner = document.querySelector(selector);
      if (owner == null) return { failure: "replacement-missing" as const };
      const current = owner instanceof HTMLImageElement ? owner.currentSrc || owner.src
        : owner instanceof HTMLInputElement && owner.type === "image" ? owner.src : "";
      const nonce = (globalThis as typeof globalThis & { __domotionAnimatedImageDocumentNonce?: string })
        .__domotionAnimatedImageDocumentNonce ?? "";
      if (current !== expected.selectedUrl || nonce !== expected.documentNonce) return { failure: "source-record-drift" as const };
      const pngDataUrl = `data:image/png;base64,${first.pngBase64}`;
      if (owner instanceof HTMLImageElement) {
        owner.closest("picture")?.querySelectorAll("source").forEach((source) => source.removeAttribute("srcset"));
        owner.removeAttribute("srcset"); owner.src = pngDataUrl;
      } else if (owner instanceof HTMLInputElement && owner.type === "image") owner.src = pngDataUrl;
      else return { failure: "replacement-missing" as const };
      await new Promise<void>((resolve, reject) => {
        const image = owner as HTMLImageElement; if (image.complete) resolve();
        else { image.addEventListener("load", () => resolve(), { once: true }); image.addEventListener("error", () => reject(new Error()), { once: true }); }
      });
      return { track, observation: first.observation, pngDataUrl,
        environment: { userAgent: navigator.userAgent, platform: navigator.platform, secureContext: isSecureContext } };
    }, {
      selector: input.record.selector, frameIndex: input.record.requestedFrameIndex,
      mimeType: input.record.mimeType, base64: Buffer.from(sourceBytes).toString("base64"),
      expected: { selectedUrl: input.record.selectedUrl, documentNonce: input.record.documentNonce },
    });
    sourceBytes.fill(0);
    if ("failure" in output && output.failure != null) fail(output.failure);
    if (output.track == null || output.observation == null || output.pngDataUrl == null) {
      fail("decoder-facts-mismatch");
    }
    const track = output.track!;
    const observation = output.observation!;
    const pngDataUrl = output.pngDataUrl!;
    const environment = output.environment!;
    const logical = {
      selector: input.record.selector, requestedFrameIndex: input.record.requestedFrameIndex,
      sourceEpochDigest: input.record.epochDigest, sourceSha256: input.record.sha256,
      mimeType: input.record.mimeType,
      browser: { sourceRevision: ANIMATED_IMAGE_STATIC_FRAME_CHROMIUM_SOURCE_REVISION,
        productVersion: browserVersion, userAgent: environment.userAgent,
        platform: environment.platform, secureContext: true as const },
      track, observation, pngDataUrl,
    };
    const record = { ...logical, transactionDigest: digest(stable(logical)) };
    verifyAnimatedImageStaticFrameRecord(record); records.push(record);
  }
  return records;
}

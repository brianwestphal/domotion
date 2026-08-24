#!/usr/bin/env tsx
/**
 * Source-owned animated-image frame selection discriminator.
 *
 * This is an investigation oracle only. It does not change capture behavior.
 * Every browser launch is explicitly headless.
 */
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chromium, type Page } from "@playwright/test";

export const ANIMATED_IMAGE_CHROMIUM_REVISION =
  "7d859f271cbda744098ac69f44978d4edfa62be3";

export const ANIMATED_IMAGE_FIXTURES = [
  {
    format: "gif",
    mimeType: "image/gif",
    sourcePath: "third_party/blink/web_tests/external/wpt/images/red-green-animated.gif",
    sourceSha256: "693360ccc02b5142695873c6f8e849000548c808d6baf5ad89071cd504fa5c1b",
    base64:
      "R0lGODlhMgAyAIAAAP8AAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QSACgAAACwAAAAAMgAyAAACM4SPqcvtD6OctNqLs968+w+G4kiW5omm6sq27gvH8kzX9o3n+s73/g8MCofEovGITConBQAh+QSAyAAAACwAAAAAMgAyAIAAmQAAAAACM4SPqcvtD6OctNqLs968+w+G4kiW5omm6sq27gvH8kzX9o3n+s73/g8MCofEovGITConBQAh/ip3aGlybGdpZiAzLjA0IChjKSBkaW5vQGRhbmJicy5kaw0KMiBpbWFnZXMAOw==",
  },
  {
    format: "apng",
    mimeType: "image/png",
    sourcePath: "third_party/blink/web_tests/external/wpt/images/apng.png",
    sourceSha256: "76c3568f8dbf0adcdf15d8a42acd96815ccf317d566118d569c218725167d0a0",
    base64:
      "iVBORw0KGgoAAAANSUhEUgAAAGQAAAAyCAMAAACd646MAAAABlBMVEUA/wD/AADRm0quAAAACGFjVEwAAAACAAAAAYSKo+YAAAAaZmNUTAAAAAAAAABkAAAAMgAAAAAAAAAAAAsD6AAAIMBffwAAACxJREFUWIXtzTEBAAAMAiDtX9oMe3ZBAdIHkUgkEolEIpFIJBKJRCKRSCQ3A8NiE4mJlBuzAAAAGmZjVEwAAAABAAAAZAAAADIAAAAAAAAAAAALA+gAALuztasAAAAgZmRBVAAAAAJYhe3BMQEAAADCoPVPbQ0PoAAAAACAPwMTugAB1UHFNwAAAABJRU5ErkJggg==",
  },
  {
    format: "webp",
    mimeType: "image/webp",
    sourcePath: "third_party/blink/web_tests/external/wpt/images/webp-animated.webp",
    sourceSha256: "292753f066add623af1e30bbeeca58f15b3d6d1052e12b13e30f21f8d3c14505",
    base64:
      "UklGRkwBAABXRUJQVlA4WAoAAAASAAAACgAAHAAAQU5JTQYAAAAAAP//AABBTk1GWgAAAAAAAAAAAAoAABwAAOgDAABWUDhMQgAAAC8KAAcAFyAWTOb/hJzGOI7j/AeOBkWxrVRXO1CCFETw24corsn5ViaI6L+AoMgBO9CcLF51lQXOjyUjLuM2FRcMDUFOTUZaAAAAAQAABQAABgAAEAAA9AEAAFZQOExCAAAALwYABAAXIBBIUl5kfoFAkvIiMwsEkpgHmXn+A38VKIpsp0mj3jGBmu4vxwwyiYmI/k8AgJLV151VJfgHnnCbO2EgQU5NRlwAAAABAAABAAAGAAAPAADoAwAAVlA4TEQAAAAvBsADABcgEEhiHmR+gUCS8iIzCwSSmAeZef4DfxUoahvJud7+Q2LQXOW3z9XCPBQR/U8JOoxGow4J7k9/88PDw83TAw==",
  },
] as const;

export interface AnimatedImageFrameObservation {
  requestedIndex: number;
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
    primaries: string | null;
    transfer: string | null;
    matrix: string | null;
    fullRange: boolean | null;
  };
}

export interface AnimatedImageDecodeArm {
  role: "proposal" | "validation";
  order: number[];
  observations: AnimatedImageFrameObservation[];
}

export interface AnimatedImageFormatEvidence {
  format: "gif" | "apng" | "webp";
  mimeType: string;
  sourcePath: string;
  sourceSha256: string;
  sourceByteLength: number;
  typeSupported: boolean;
  track: {
    frameCount: number;
    animated: boolean;
    repetitionCount: string;
    selectedIndex: number;
  };
  arms: [AnimatedImageDecodeArm, AnimatedImageDecodeArm];
  outOfRange: { name: string; message: string };
}

export interface AnimatedImageFrameSelectionReport {
  schemaVersion: 1;
  sourceRevision: `chromium:${string}`;
  browser: {
    productVersion: string;
    userAgent: string;
    platform: string;
    secureContext: boolean;
    imageDecoderType: string;
    headless: true;
  };
  formats: AnimatedImageFormatEvidence[];
  errors: string[];
  verdict: "decoder-frame-exact" | "source-drift";
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function observationIdentity(observation: AnimatedImageFrameObservation): string {
  return JSON.stringify({
    complete: observation.complete,
    rgbaSha256: observation.rgbaSha256,
    pngSha256: observation.pngSha256,
    codedWidth: observation.codedWidth,
    codedHeight: observation.codedHeight,
    displayWidth: observation.displayWidth,
    displayHeight: observation.displayHeight,
    visibleRect: observation.visibleRect,
    timestamp: observation.timestamp,
    duration: observation.duration,
    format: observation.format,
    colorSpace: observation.colorSpace,
  });
}

export function adjudicateAnimatedImageFormat(
  evidence: AnimatedImageFormatEvidence,
): string[] {
  const errors: string[] = [];
  const prefix = evidence.format;
  const expectedMimeTypes = { gif: "image/gif", apng: "image/png", webp: "image/webp" } as const;
  const expectedSourcePaths = {
    gif: "third_party/blink/web_tests/external/wpt/images/red-green-animated.gif",
    apng: "third_party/blink/web_tests/external/wpt/images/apng.png",
    webp: "third_party/blink/web_tests/external/wpt/images/webp-animated.webp",
  } as const;
  if (evidence.mimeType !== expectedMimeTypes[evidence.format]) {
    errors.push(`${prefix}: MIME type ${evidence.mimeType} does not match the format`);
  }
  if (evidence.sourcePath !== expectedSourcePaths[evidence.format]) {
    errors.push(`${prefix}: pinned source path does not match the format`);
  }
  if (evidence.sourceByteLength <= 0 || !/^[0-9a-f]{64}$/.test(evidence.sourceSha256)) {
    errors.push(`${prefix}: encoded source identity is incomplete`);
  }
  if (!evidence.typeSupported) errors.push(`${prefix}: ImageDecoder type unsupported`);
  if (!evidence.track.animated) errors.push(`${prefix}: selected track is not animated`);
  if (!Number.isInteger(evidence.track.frameCount) || evidence.track.frameCount < 2 || evidence.track.frameCount > 8) {
    errors.push(`${prefix}: frameCount ${evidence.track.frameCount} is outside bounded 2..8 corpus`);
  }
  if (evidence.track.selectedIndex !== 0) {
    errors.push(`${prefix}: preferAnimation selected unexpected track ${evidence.track.selectedIndex}`);
  }
  if (evidence.arms.length !== 2 || evidence.arms[0]?.role !== "proposal" || evidence.arms[1]?.role !== "validation") {
    errors.push(`${prefix}: proposal/validation roles missing or reordered`);
    return errors;
  }

  const expectedForward = Array.from({ length: evidence.track.frameCount }, (_, index) => index)
    .flatMap((index) => [index, index]);
  const expectedReverse = [...expectedForward].reverse();
  if (JSON.stringify(evidence.arms[0].order) !== JSON.stringify(expectedForward)) {
    errors.push(`${prefix}: proposal order is not forward same-frame pairs`);
  }
  if (JSON.stringify(evidence.arms[1].order) !== JSON.stringify(expectedReverse)) {
    errors.push(`${prefix}: validation order is not reverse same-frame pairs`);
  }

  const identitiesByIndex = new Map<number, Set<string>>();
  for (const arm of evidence.arms) {
    if (arm.observations.length !== arm.order.length) {
      errors.push(`${prefix}/${arm.role}: observation count does not match order`);
    }
    arm.observations.forEach((observation, position) => {
      if (observation.requestedIndex !== arm.order[position]) {
        errors.push(`${prefix}/${arm.role}: requested index moved at position ${position}`);
      }
      if (
        !Number.isInteger(observation.requestedIndex) || observation.requestedIndex < 0 ||
        observation.requestedIndex >= evidence.track.frameCount
      ) {
        errors.push(`${prefix}/${arm.role}: requested frame index is outside the selected track`);
      }
      if (!observation.complete) {
        errors.push(`${prefix}/${arm.role}: frame ${observation.requestedIndex} was partial`);
      }
      if (
        observation.codedWidth <= 0 || observation.codedHeight <= 0 ||
        observation.displayWidth <= 0 || observation.displayHeight <= 0
      ) {
        errors.push(`${prefix}/${arm.role}: frame ${observation.requestedIndex} has invalid dimensions`);
      }
      if (!/^[0-9a-f]{64}$/.test(observation.rgbaSha256) || !/^[0-9a-f]{64}$/.test(observation.pngSha256)) {
        errors.push(`${prefix}/${arm.role}: frame ${observation.requestedIndex} has invalid pixel identity`);
      }
      if (
        !Number.isFinite(observation.timestamp) || observation.timestamp < 0 ||
        (observation.duration != null && (!Number.isFinite(observation.duration) || observation.duration < 0))
      ) {
        errors.push(`${prefix}/${arm.role}: frame ${observation.requestedIndex} has invalid timing metadata`);
      }
      const rect = observation.visibleRect;
      if (
        rect == null || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 ||
        rect.x + rect.width > observation.codedWidth || rect.y + rect.height > observation.codedHeight
      ) {
        errors.push(`${prefix}/${arm.role}: frame ${observation.requestedIndex} has invalid visible rect`);
      }
      const identities = identitiesByIndex.get(observation.requestedIndex) ?? new Set<string>();
      identities.add(observationIdentity(observation));
      identitiesByIndex.set(observation.requestedIndex, identities);
    });
  }

  const distinctFramePixels = new Set<string>();
  for (let index = 0; index < evidence.track.frameCount; index++) {
    const identities = identitiesByIndex.get(index);
    if (identities == null) {
      errors.push(`${prefix}: frame ${index} was not decoded`);
      continue;
    }
    if (identities.size !== 1) {
      errors.push(`${prefix}: frame ${index} changed across same-frame/reverse-order controls`);
    }
    for (const observation of evidence.arms.flatMap((arm) => arm.observations)) {
      if (observation.requestedIndex === index) distinctFramePixels.add(observation.rgbaSha256);
    }
  }
  if (distinctFramePixels.size < 2) errors.push(`${prefix}: frame-index activation control was inert`);
  if (evidence.outOfRange.name !== "RangeError") {
    errors.push(`${prefix}: out-of-range frame index did not reject with RangeError`);
  }
  return errors;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("loopback server has no TCP address");
  return `http://127.0.0.1:${address.port}/`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error == null ? resolve() : reject(error)));
}

function evaluateHeadlessPage<Argument, Result>(
  page: Page,
  callback: (argument: Argument) => Result | Promise<Result>,
  argument: Argument,
): Promise<Result> {
  const serializedArgument = JSON.stringify(argument);
  if (serializedArgument == null) return Promise.reject(new Error("page argument is not JSON-serializable"));
  const expression = `((__name, argument) => (${callback.toString()})(argument))(function(target, value) { try { Object.defineProperty(target, "name", { value: value, configurable: true }); } catch {} return target; }, ${serializedArgument})`;
  return page.evaluate(expression) as Promise<Result>;
}

export async function runAnimatedImageFrameSelectionAudit(): Promise<AnimatedImageFrameSelectionReport> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><title>animated image decoder ownership</title>");
  });
  const origin = await listen(server);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 160, height: 100 } });
    await page.goto(origin, { waitUntil: "load" });
    const pageEvidence = await evaluateHeadlessPage(page, async (fixtureInputs) => {
      interface DecoderTrack {
        frameCount: number;
        animated: boolean;
        repetitionCount: number;
      }
      interface DecoderResult {
        image: VideoFrame;
        complete: boolean;
      }
      interface DecoderInstance {
        tracks: {
          ready: Promise<unknown>;
          selectedIndex: number;
          selectedTrack: DecoderTrack | null;
        };
        decode(options: { frameIndex: number; completeFramesOnly: boolean }): Promise<DecoderResult>;
        close(): void;
      }
      interface DecoderConstructor {
        new(init: {
          data: Uint8Array;
          type: string;
          colorSpaceConversion: "default";
          preferAnimation: boolean;
        }): DecoderInstance;
        isTypeSupported(type: string): Promise<boolean>;
      }

      const Decoder = (globalThis as unknown as { ImageDecoder: DecoderConstructor }).ImageDecoder;
      const toBytes = (base64: string) => Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const digest = async (bytes: Uint8Array) => {
        const stableBytes = new Uint8Array(bytes);
        const value = await crypto.subtle.digest("SHA-256", stableBytes);
        return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      };
      const pngBytes = (canvas: HTMLCanvasElement) => new Promise<Uint8Array>((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob == null) {
            reject(new Error("canvas PNG encoding failed"));
            return;
          }
          blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
        }, "image/png");
      });

      const decodeObservation = async (decoder: DecoderInstance, frameIndex: number) => {
        const result = await decoder.decode({ frameIndex, completeFramesOnly: true });
        const frame = result.image;
        try {
          const canvas = document.createElement("canvas");
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (context == null) throw new Error("2D canvas unavailable");
          context.drawImage(frame, 0, 0);
          const rgba = new Uint8Array(context.getImageData(0, 0, canvas.width, canvas.height).data);
          const encodedPng = await pngBytes(canvas);
          const rect = frame.visibleRect;
          return {
            requestedIndex: frameIndex,
            complete: result.complete,
            rgbaSha256: await digest(rgba),
            pngSha256: await digest(encodedPng),
            codedWidth: frame.codedWidth,
            codedHeight: frame.codedHeight,
            displayWidth: frame.displayWidth,
            displayHeight: frame.displayHeight,
            visibleRect: rect == null ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            timestamp: frame.timestamp,
            duration: frame.duration,
            format: frame.format,
            colorSpace: {
              primaries: frame.colorSpace.primaries,
              transfer: frame.colorSpace.transfer,
              matrix: frame.colorSpace.matrix,
              fullRange: frame.colorSpace.fullRange,
            },
          };
        } finally {
          frame.close();
        }
      };

      const formats = [];
      for (const fixture of fixtureInputs) {
        const bytes = toBytes(fixture.base64);
        const typeSupported = await Decoder.isTypeSupported(fixture.mimeType);
        const inspectDecoder = new Decoder({
          data: bytes,
          type: fixture.mimeType,
          colorSpaceConversion: "default",
          preferAnimation: true,
        });
        await inspectDecoder.tracks.ready;
        const inspectTrack = inspectDecoder.tracks.selectedTrack;
        if (inspectTrack == null) throw new Error(`${fixture.format}: no selected animation track`);
        const track = {
          frameCount: inspectTrack.frameCount,
          animated: inspectTrack.animated,
          repetitionCount: Number.isFinite(inspectTrack.repetitionCount)
            ? String(inspectTrack.repetitionCount)
            : "Infinity",
          selectedIndex: inspectDecoder.tracks.selectedIndex,
        };
        inspectDecoder.close();
        const frameCount = track.frameCount;
        if (frameCount < 2 || frameCount > 8) {
          throw new Error(`${fixture.format}: frameCount ${frameCount} outside bounded 2..8 corpus`);
        }

        const runArm = async (role: "proposal" | "validation", order: number[]) => {
          const decoder = new Decoder({
            data: bytes,
            type: fixture.mimeType,
            colorSpaceConversion: "default",
            preferAnimation: true,
          });
          try {
            await decoder.tracks.ready;
            const observations = [];
            for (const frameIndex of order) observations.push(await decodeObservation(decoder, frameIndex));
            return { role, order, observations };
          } finally {
            decoder.close();
          }
        };
        const proposalOrder = Array.from({ length: frameCount }, (_, index) => index)
          .flatMap((index) => [index, index]);
        const validationOrder = [...proposalOrder].reverse();
        const proposal = await runArm("proposal", proposalOrder);
        const validation = await runArm("validation", validationOrder);

        const rangeDecoder = new Decoder({
          data: bytes,
          type: fixture.mimeType,
          colorSpaceConversion: "default",
          preferAnimation: true,
        });
        let outOfRange = { name: "none", message: "no error" };
        try {
          await rangeDecoder.tracks.ready;
          await rangeDecoder.decode({ frameIndex: frameCount, completeFramesOnly: true });
        } catch (error) {
          outOfRange = error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: typeof error, message: String(error) };
        } finally {
          rangeDecoder.close();
        }

        formats.push({
          format: fixture.format,
          mimeType: fixture.mimeType,
          typeSupported,
          track,
          arms: [proposal, validation],
          outOfRange,
        });
      }
      return {
        environment: {
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          secureContext: isSecureContext,
          imageDecoderType: typeof Decoder,
        },
        formats,
      };
    }, ANIMATED_IMAGE_FIXTURES.map(({ format, mimeType, base64 }) => ({ format, mimeType, base64 })));

    const formats: AnimatedImageFormatEvidence[] = pageEvidence.formats.map((formatEvidence, index) => {
      const fixture = ANIMATED_IMAGE_FIXTURES[index];
      const bytes = Buffer.from(fixture.base64, "base64");
      const actualSourceSha256 = sha256(bytes);
      return {
        ...formatEvidence,
        format: fixture.format,
        sourcePath: fixture.sourcePath,
        sourceSha256: actualSourceSha256,
        sourceByteLength: bytes.length,
      } as AnimatedImageFormatEvidence;
    });
    const errors = formats.flatMap(adjudicateAnimatedImageFormat);
    for (const [index, fixture] of ANIMATED_IMAGE_FIXTURES.entries()) {
      if (formats[index]?.sourceSha256 !== fixture.sourceSha256) {
        errors.push(`${fixture.format}: source fixture digest does not match pinned Chromium asset`);
      }
    }
    if (!pageEvidence.environment.secureContext) errors.push("loopback page was not a secure context");
    if (pageEvidence.environment.imageDecoderType !== "function") errors.push("ImageDecoder constructor unavailable");

    return {
      schemaVersion: 1,
      sourceRevision: `chromium:${ANIMATED_IMAGE_CHROMIUM_REVISION}`,
      browser: {
        productVersion: browser.version(),
        ...pageEvidence.environment,
        headless: true,
      },
      formats,
      errors,
      verdict: errors.length === 0 ? "decoder-frame-exact" : "source-drift",
    };
  } finally {
    await browser.close();
    await closeServer(server);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await runAnimatedImageFrameSelectionAudit();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.verdict !== "decoder-frame-exact") process.exitCode = 1;
}

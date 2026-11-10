import { randomUUID } from "node:crypto";
import type { Frame, Page } from "@playwright/test";
import { evaluateInFrame } from "./evaluate-in-frame.js";
import { probeFailureWarning } from "./probe-failure.js";
import type { CaptureWarning } from "./types.js";

async function withNodeDeadline<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms Node deadline`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Internal selected-resource ratio probe. DOM natural dimensions truncate density
 * correction; ImageBitmap reads ImageElementBase::CachedImage instead (Chromium
 * 6b5a1b80, image_bitmap.cc). Only ratio-safe contain/cover consume these facts. */
export async function primeDecodedImageRatios(
  page: Page,
  timeoutMs = 3000,
): Promise<{
  warnings: CaptureWarning[];
  dispose(): Promise<void>;
}> {
  const token = randomUUID();
  const frames = page.frames();
  const warnings: CaptureWarning[] = [];
  const cleanup = async (frame: Frame): Promise<void> => {
    await withNodeDeadline(
      evaluateInFrame(
        frame,
        (owner) => {
          const host = window as Window & { __domotionDecodedImageRatios?: { token: string; active: boolean } };
          const state = host.__domotionDecodedImageRatios;
          if (state?.token !== owner) return;
          state.active = false;
          delete host.__domotionDecodedImageRatios;
        },
        token,
      ),
      timeoutMs,
      "decoded ratio cleanup",
    );
  };
  await Promise.all(
    frames.map(async (frame) => {
      try {
        const failures = await withNodeDeadline(
          evaluateInFrame(
            frame,
            async (owner) => {
              interface Fact {
                source: string;
                naturalWidth: number;
                naturalHeight: number;
                orientation: string;
                width: number;
                height: number;
              }
              const host = window as Window & {
                __domotionDecodedImageRatios?: { token: string; active: boolean; facts: WeakMap<Element, Fact> };
              };
              if (host.__domotionDecodedImageRatios != null) throw new Error("decoded ratio probe already owned");
              const state = { token: owner, active: true, facts: new WeakMap<Element, Fact>() };
              host.__domotionDecodedImageRatios = state;
              const errors: string[] = [];
              const images: HTMLImageElement[] = [];
              const collect = (root: Document | ShadowRoot): void => {
                images.push(...root.querySelectorAll<HTMLImageElement>("img"));
                for (const element of root.querySelectorAll("*")) {
                  if (element.shadowRoot != null) collect(element.shadowRoot);
                }
              };
              collect(document);
              // Release each selected bitmap before allocating the next one.
              for (const image of images) {
                if (!state.active) break;
                const style = getComputedStyle(image);
                if (
                  (style.objectFit !== "contain" && style.objectFit !== "cover") ||
                  !image.complete ||
                  image.naturalWidth <= 0 ||
                  image.naturalHeight <= 0
                )
                  continue;
                // Orientation-none is feature-gated for ImageBitmap in supported
                // Chromium builds. Never guess that it matches CSS image-orientation.
                if (style.imageOrientation !== "from-image") {
                  errors.push("CSS image-orientation has no authenticated decoded-ratio authority");
                  continue;
                }
                const orientation = style.imageOrientation;
                const source = image.currentSrc || image.src;
                const naturalWidth = image.naturalWidth;
                const naturalHeight = image.naturalHeight;
                let bitmap: ImageBitmap | undefined;
                try {
                  bitmap = await createImageBitmap(image);
                  if (bitmap.width <= 0 || bitmap.height <= 0) throw new Error("empty decoded image");
                  if (
                    state.active &&
                    image.complete &&
                    (image.currentSrc || image.src) === source &&
                    image.naturalWidth === naturalWidth &&
                    image.naturalHeight === naturalHeight &&
                    getComputedStyle(image).imageOrientation === orientation
                  ) {
                    state.facts.set(image, {
                      source,
                      naturalWidth,
                      naturalHeight,
                      orientation,
                      width: bitmap.width,
                      height: bitmap.height,
                    });
                  } else if (state.active) {
                    errors.push("selected image changed during decoded ratio probe");
                  }
                } catch (error) {
                  errors.push(error instanceof Error ? error.message : String(error));
                } finally {
                  // Also closes bitmaps resolving after the Node deadline/disposal.
                  bitmap?.close();
                }
              }
              return errors;
            },
            token,
          ),
          timeoutMs,
          "decoded ratio probe",
        );
        for (const failure of new Set(failures))
          warnings.push(
            probeFailureWarning({
              selector: "img",
              feature: "raster-intrinsic-ratio",
              probe: "selected decoded image sizing",
              cause: failure,
              effect: "contain/cover retains legacy DOM integer intrinsic sizing",
            }),
          );
      } catch (error) {
        if (error instanceof Error && error.message.includes("decoded ratio probe already owned")) throw error;
        // Invalidate before capture: late promises can close resources but cannot
        // publish facts after the authoritative walk starts.
        await cleanup(frame);
        warnings.push(
          probeFailureWarning({
            selector: "img",
            feature: "raster-intrinsic-ratio",
            probe: "selected decoded image sizing",
            cause: error,
            effect: "contain/cover retains legacy DOM integer intrinsic sizing",
          }),
        );
      }
    }),
  ).catch(async (error) => {
    await Promise.all(frames.map(cleanup));
    throw error;
  });
  return {
    warnings,
    async dispose() {
      await Promise.all(frames.map(cleanup));
    },
  };
}

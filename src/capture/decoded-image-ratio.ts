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

/** Which measurement a probe failure invalidated, so the warning names the fallback. */
type ProbeFailureKind = "decoded" | "natural";
const PROBE_EFFECTS: Record<ProbeFailureKind, { probe: string; effect: string }> = {
  decoded: {
    probe: "selected decoded image sizing",
    effect: "contain/cover/scale-down retains legacy DOM integer intrinsic sizing",
  },
  natural: {
    probe: "selected responsive candidate natural size",
    effect: "object-fit:none retains legacy DOM integer intrinsic sizing",
  },
};

/** Internal selected-resource sizing probe.
 *
 * Decoded size: DOM natural dimensions truncate density correction; ImageBitmap
 * reads ImageElementBase::CachedImage instead (Chromium 6b5a1b80,
 * image_bitmap.cc). Contain/cover consume only its ratio. Scale-down consumes
 * the size too: `LayoutReplaced::ComputeObjectFitAndPositionRect` reverts a
 * srcset image's density for scale-down ("they need to use the underlying image
 * src's size", `core/layout/layout_replaced.cc:444-450`, Chromium 7d859f27).
 *
 * Responsive natural size: `object-fit: none` paints at Blink's natural size,
 * `LayoutImageResource::GetNaturalDimensions` — the decoded size scaled by
 * `1 / candidate.Density()` (`core/layout/layout_image_resource.cc:145-170`,
 * `core/html/html_image_element.cc:281-301`, Chromium 7d859f27) — and only its
 * truncated integers reach the DOM (`DensityCorrectedIntrinsicDimensions`,
 * `html_image_element.cc:675-694`). No page or protocol API exposes the
 * density. When the current source came from a `srcset` candidate, a hidden
 * closed-shadow probe `<img>` carrying exactly that ONE candidate (its raw URL
 * and raw descriptor) and the same raw `sizes` is laid out: with a single
 * candidate Blink selects nothing, evaluates `sizes` and the density itself,
 * and the probe's auto-sized box is that natural size. The source element is
 * never touched and its candidate is never reselected. */
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
                /** Selected decoded resource size, orientation applied. */
                width?: number;
                height?: number;
                /** Blink natural size (density applied, unit zoom, LayoutUnit). */
                layoutNaturalWidth?: number;
                layoutNaturalHeight?: number;
              }
              const host = window as Window & {
                __domotionDecodedImageRatios?: { token: string; active: boolean; facts: WeakMap<Element, Fact> };
              };
              if (host.__domotionDecodedImageRatios != null) throw new Error("decoded ratio probe already owned");
              const state = { token: owner, active: true, facts: new WeakMap<Element, Fact>() };
              host.__domotionDecodedImageRatios = state;
              const errors: Array<{ kind: "decoded" | "natural"; cause: string }> = [];
              const images: HTMLImageElement[] = [];
              const collect = (root: Document | ShadowRoot): void => {
                images.push(...root.querySelectorAll<HTMLImageElement>("img"));
                for (const element of root.querySelectorAll("*")) {
                  if (element.shadowRoot != null) collect(element.shadowRoot);
                }
              };
              collect(document);
              // HTML "parse a srcset attribute" candidate splitting: a URL is a
              // run of non-whitespace (trailing commas end the candidate), and a
              // descriptor list runs to the next comma outside parentheses. Only
              // the raw URL and raw descriptor text are kept — Blink re-parses
              // the descriptor itself in the probe.
              const splitSrcset = (text: string): Array<{ url: string; descriptor: string }> => {
                const out: Array<{ url: string; descriptor: string }> = [];
                const isSpace = (ch: string) => ch === " " || ch === "\t" || ch === "\n" || ch === "\f" || ch === "\r";
                let pos = 0;
                while (pos < text.length) {
                  while (pos < text.length && (isSpace(text[pos]) || text[pos] === ",")) pos++;
                  if (pos >= text.length) break;
                  const urlStart = pos;
                  while (pos < text.length && !isSpace(text[pos])) pos++;
                  let url = text.slice(urlStart, pos);
                  let descriptor = "";
                  if (url.endsWith(",")) {
                    url = url.replace(/,+$/, "");
                  } else {
                    const descStart = pos;
                    let depth = 0;
                    while (pos < text.length) {
                      const ch = text[pos];
                      if (ch === "(") depth++;
                      else if (ch === ")" && depth > 0) depth--;
                      else if (ch === "," && depth === 0) break;
                      pos++;
                    }
                    descriptor = text.slice(descStart, pos).trim();
                  }
                  if (url !== "") out.push({ url, descriptor });
                }
                return out;
              };
              const resolve = (url: string, base: string): string | null => {
                try {
                  return new URL(url, base).href;
                } catch {
                  return null;
                }
              };
              // Every (URL, descriptor, sizes) that could have produced
              // `source`: the img's own srcset, each <picture> <source>'s, and
              // the src attribute as Blink's implicit 1x candidate.
              const candidatesFor = (
                image: HTMLImageElement,
                source: string,
              ): Array<{ url: string; descriptor: string; sizes: string; srcset: boolean }> => {
                const owners: Element[] = [];
                const parent = image.parentElement;
                if (parent != null && parent.localName === "picture") {
                  for (const child of Array.from(parent.children)) {
                    if (child === image) break;
                    if (child.localName === "source") owners.push(child);
                  }
                }
                owners.push(image);
                const found: Array<{ url: string; descriptor: string; sizes: string; srcset: boolean }> = [];
                for (const owner of owners) {
                  const srcset = owner.getAttribute("srcset");
                  if (srcset == null) continue;
                  for (const candidate of splitSrcset(srcset)) {
                    if (resolve(candidate.url, image.baseURI) === source)
                      found.push({ ...candidate, sizes: owner.getAttribute("sizes") ?? "", srcset: true });
                  }
                }
                const src = image.getAttribute("src");
                if (src != null && src !== "" && resolve(src, image.baseURI) === source)
                  found.push({ url: src, descriptor: "1x", sizes: "", srcset: false });
                return found;
              };
              const measureNatural = async (image: HTMLImageElement, source: string): Promise<void> => {
                const candidates = candidatesFor(image, source);
                // A source with no srcset candidate is the src's density-1
                // candidate: its DOM natural dimensions are already exact.
                if (!candidates.some((candidate) => candidate.srcset)) return;
                const distinct = new Set(candidates.map((candidate) => `${candidate.descriptor}\n${candidate.sizes}`));
                if (distinct.size !== 1) {
                  errors.push({
                    kind: "natural",
                    cause: "selected source matches candidates with different descriptors",
                  });
                  return;
                }
                const selected = candidates[0];
                if (/(^|[\s,(])auto([\s,)]|$)/i.test(selected.sizes)) {
                  errors.push({ kind: "natural", cause: "sizes=auto depends on the source element's own layout" });
                  return;
                }
                const probeHost = document.createElement("div");
                probeHost.setAttribute("aria-hidden", "true");
                probeHost.style.setProperty("all", "initial", "important");
                probeHost.style.setProperty("position", "fixed", "important");
                probeHost.style.setProperty("left", "-100000px", "important");
                probeHost.style.setProperty("top", "-100000px", "important");
                probeHost.style.setProperty("visibility", "hidden", "important");
                try {
                  const root = probeHost.attachShadow({ mode: "closed" });
                  const reference = document.createElement("div");
                  reference.style.cssText = "all:initial;display:block;width:64px;height:64px";
                  const probe = document.createElement("img");
                  probe.style.cssText = "all:initial;display:block";
                  probe.style.setProperty("image-orientation", getComputedStyle(image).imageOrientation);
                  if (selected.sizes !== "") probe.setAttribute("sizes", selected.sizes);
                  probe.setAttribute(
                    "srcset",
                    selected.descriptor === "" ? selected.url : `${selected.url} ${selected.descriptor}`,
                  );
                  root.append(reference, probe);
                  document.documentElement.appendChild(probeHost);
                  await probe.decode();
                  const referenceRect = reference.getBoundingClientRect();
                  if (referenceRect.width !== 64 || referenceRect.height !== 64) {
                    errors.push({ kind: "natural", cause: "the probe host is zoomed" });
                    return;
                  }
                  if (
                    !state.active ||
                    probe.currentSrc !== source ||
                    probe.naturalWidth !== image.naturalWidth ||
                    probe.naturalHeight !== image.naturalHeight ||
                    (image.currentSrc || image.src) !== source
                  ) {
                    if (state.active)
                      errors.push({ kind: "natural", cause: "probe candidate did not reproduce the selected source" });
                    return;
                  }
                  const rect = probe.getBoundingClientRect();
                  if (!(rect.width > 0 && rect.height > 0)) {
                    errors.push({ kind: "natural", cause: "probe produced an empty natural size" });
                    return;
                  }
                  const prior = state.facts.get(image);
                  state.facts.set(image, {
                    ...(prior ?? {
                      source,
                      naturalWidth: image.naturalWidth,
                      naturalHeight: image.naturalHeight,
                      orientation: getComputedStyle(image).imageOrientation,
                    }),
                    layoutNaturalWidth: rect.width,
                    layoutNaturalHeight: rect.height,
                  });
                } catch (error) {
                  errors.push({ kind: "natural", cause: error instanceof Error ? error.message : String(error) });
                } finally {
                  probeHost.remove();
                }
              };
              // Release each selected bitmap before allocating the next one.
              for (const image of images) {
                if (!state.active) break;
                const style = getComputedStyle(image);
                const fit = style.objectFit;
                if (
                  (fit !== "contain" && fit !== "cover" && fit !== "scale-down" && fit !== "none") ||
                  !image.complete ||
                  image.naturalWidth <= 0 ||
                  image.naturalHeight <= 0
                )
                  continue;
                const source = image.currentSrc || image.src;
                if (fit === "none") {
                  await measureNatural(image, source);
                  continue;
                }
                // Orientation-none is feature-gated for ImageBitmap in supported
                // Chromium builds. Never guess that it matches CSS image-orientation.
                if (style.imageOrientation !== "from-image") {
                  errors.push({
                    kind: "decoded",
                    cause: "CSS image-orientation has no authenticated decoded-ratio authority",
                  });
                  continue;
                }
                const orientation = style.imageOrientation;
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
                    errors.push({ kind: "decoded", cause: "selected image changed during decoded ratio probe" });
                  }
                } catch (error) {
                  errors.push({ kind: "decoded", cause: error instanceof Error ? error.message : String(error) });
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
        const seen = new Set<string>();
        for (const failure of failures) {
          const key = `${failure.kind}\n${failure.cause}`;
          if (seen.has(key)) continue;
          seen.add(key);
          warnings.push(
            probeFailureWarning({
              selector: "img",
              feature: "raster-intrinsic-ratio",
              probe: PROBE_EFFECTS[failure.kind].probe,
              cause: failure.cause,
              effect: PROBE_EFFECTS[failure.kind].effect,
            }),
          );
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("decoded ratio probe already owned")) throw error;
        // Invalidate before capture: late promises can close resources but cannot
        // publish facts after the authoritative walk starts.
        await cleanup(frame);
        warnings.push(
          probeFailureWarning({
            selector: "img",
            feature: "raster-intrinsic-ratio",
            probe: "selected image sizing",
            cause: error,
            effect: "contain/cover/scale-down/none retain legacy DOM integer intrinsic sizing",
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

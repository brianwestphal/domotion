/**
 * Authored descriptors for webfont faces that no `@font-face` rule declares,
 * taken from the DevTools protocol event `CSS.fontsUpdated`.
 *
 * A face found only as a fetched font resource, typically one a script built
 * with `new FontFace(family, "url(...)", descriptors)` and added to
 * `document.fonts`, used to be registered under the file's internal family
 * name with weight and italic inferred from its OS/2 table. Blink matches it
 * by the AUTHORED family and descriptors instead. Chromium reports exactly
 * those (Chromium 7d859f27):
 *
 * - `RemoteFontFaceSource::NotifyFinished`
 *   (core/css/remote_font_face_source.cc:255-261) fires
 *   `probe::FontsUpdated(context, face, resource->Url(), custom_font_data)`
 *   once the face's source has loaded and decoded.
 * - `InspectorCSSAgent::FontsUpdated`
 *   (core/inspector/inspector_css_agent.cc:989-1033) turns that into the
 *   event payload: `familyNameUnquoted()` and the `FontFace` descriptor
 *   getters `style()`, `weight()`, `stretch()` and `unicodeRange()`, plus the
 *   source URL as `src`.
 * - Those getters (core/css/font_face.cc:298-312) return the descriptor's CSS
 *   text, or the defaults `normal` and `U+0-10FFFF` when it is absent. A
 *   script-constructed face never has an absent descriptor: the
 *   `FontFaceDescriptors` IDL defaults are `"normal"` and `"U+0-10FFFF"`, and
 *   the constructor (font_face.cc:256-289) stores them as explicit values.
 *
 * The event has two limits that this module handles explicitly:
 *
 * - It fires for a face that was loaded but never added to `document.fonts`,
 *   or added and then deleted. Blink does not match such a face, so an event
 *   counts only when `document.fonts` holds a loaded face with the same
 *   family and descriptors (`joinFontsUpdatedFaces`). A descriptor tuple with
 *   more events than matching loaded faces cannot be attributed to a URL, so
 *   none of its events count; those URLs keep the resource inference.
 * - It is replayed on `CSS.enable` only for CSS-connected faces
 *   (`InspectorCSSAgent::CompleteEnabled` → `TriggerFontsUpdatedForDocument`,
 *   inspector_css_agent.cc:935-963). Script-constructed faces are reported
 *   only live, so the listener must be enabled before navigation
 *   (`attachWebfontTracker`).
 */
import type { CDPSession, Frame, Page } from "@playwright/test";
import type { FaceRule } from "./cross-origin-font-face.js";
import { evaluateInFrame } from "./evaluate-in-frame.js";
import { parseUnicodeRangeDescriptor } from "./unicode-range.js";
import { parseCssFontFamilyName } from "../font-family-stack.js";

/** The fields of one `CSS.fontsUpdated` `font` payload that discovery uses. */
export type FontsUpdatedFace = {
  fontFamily: string;
  fontStyle: string;
  fontWeight: string;
  fontStretch: string;
  unicodeRange: string;
  /** The loaded source's URL; empty for an `ArrayBuffer` source. */
  src: string;
};

/** One face of `document.fonts`, as its `FontFace` getters serialize it. */
export type DocumentFontFace = {
  family: string;
  style: string;
  weight: string;
  stretch: string;
  unicodeRange: string;
  status: string;
};

/** Live `CSS.fontsUpdated` faces collected from a page. */
export type FontsUpdatedObserver = {
  faces: FontsUpdatedFace[];
  /** Resolves once the listener is enabled. Navigate only after it resolves. */
  ready: Promise<void>;
  detach: () => void;
};

/**
 * Enable the DOM and CSS domains on a fresh session and collect every
 * `CSS.fontsUpdated` face. A target that refuses the session (a non-Chromium
 * page) leaves `faces` empty, which keeps the resource inference.
 */
export function observeFontsUpdated(page: Page): FontsUpdatedObserver {
  const faces: FontsUpdatedFace[] = [];
  let session: CDPSession | null = null;
  let detached = false;
  const onFontsUpdated = (event: { font?: Partial<FontsUpdatedFace> }): void => {
    const face = fontsUpdatedFaceFromPayload(event.font);
    if (face != null) faces.push(face);
  };
  const ready = (async (): Promise<void> => {
    try {
      const opened = await page.context().newCDPSession(page);
      if (detached) {
        await opened.detach().catch(() => undefined);
        return;
      }
      session = opened;
      opened.on("CSS.fontsUpdated", onFontsUpdated);
      await opened.send("DOM.enable");
      await opened.send("CSS.enable");
    } catch {
      // No protocol session: discovery falls back to the resource inference.
    }
  })();
  return {
    faces,
    ready,
    detach: () => {
      detached = true;
      const open = session;
      session = null;
      if (open == null) return;
      open.off("CSS.fontsUpdated", onFontsUpdated);
      open.detach().catch(() => undefined);
    },
  };
}

/** Validate one event payload. A font-less event (a style-engine refresh) yields null. */
export function fontsUpdatedFaceFromPayload(font: Partial<FontsUpdatedFace> | undefined): FontsUpdatedFace | null {
  if (font == null) return null;
  const { fontFamily, fontStyle, fontWeight, fontStretch, unicodeRange, src } = font;
  if (
    typeof fontFamily !== "string" ||
    typeof fontStyle !== "string" ||
    typeof fontWeight !== "string" ||
    typeof fontStretch !== "string" ||
    typeof unicodeRange !== "string" ||
    typeof src !== "string"
  ) {
    return null;
  }
  return { fontFamily, fontStyle, fontWeight, fontStretch, unicodeRange, src };
}

/** Read `document.fonts` in iteration order with each face's descriptor getters. */
export function readDocumentFontFaces(frame: Page | Frame): Promise<DocumentFontFace[]> {
  return evaluateInFrame(frame, () =>
    Array.from(document.fonts).map((face) => ({
      family: face.family,
      style: face.style,
      weight: face.weight,
      stretch: face.stretch,
      unicodeRange: face.unicodeRange,
      status: face.status,
    })),
  );
}

/**
 * `FontFace.family` serializes a family that needs quoting as a CSS string
 * (`"Js Fam"`), while the event carries the unquoted name. Decode a quoted
 * value; an unquoted one is already the name.
 */
function documentFamilyName(family: string): string {
  const trimmed = family.trim();
  if (!trimmed.startsWith('"') && !trimmed.startsWith("'")) return family;
  return parseCssFontFamilyName(trimmed) ?? family;
}

function descriptorKey(family: string, style: string, weight: string, stretch: string, unicodeRange: string): string {
  return JSON.stringify([family, style, weight, stretch, unicodeRange]);
}

/** The outcome of joining the events with `document.fonts`. */
export type FontsUpdatedJoin = {
  /** Events attributable to a loaded face Blink can match, in event order. */
  matched: FontsUpdatedFace[];
  /** Events with no loaded `document.fonts` face (never added, deleted, or another frame's). */
  unmatched: FontsUpdatedFace[];
  /** Events whose descriptor tuple has more events than loaded faces. */
  ambiguous: FontsUpdatedFace[];
};

/**
 * Keep the events whose face Blink can match. Joined on the family and the
 * four descriptor strings, which both sides serialize with the same
 * `FontFace` getters. Repeated events for one URL and tuple are one face (a
 * page that navigates again reloads it). A tuple counts only when its loaded
 * `document.fonts` faces are at least as many as its distinct faces;
 * otherwise which URLs belong to the matchable faces is unknown and the whole
 * tuple is ambiguous. Events without a URL (`ArrayBuffer` sources) are never
 * merged, since nothing identifies them.
 */
export function joinFontsUpdatedFaces(
  events: readonly FontsUpdatedFace[],
  documentFaces: readonly DocumentFontFace[],
): FontsUpdatedJoin {
  const loaded = new Map<string, number>();
  for (const face of documentFaces) {
    if (face.status !== "loaded") continue;
    const key = descriptorKey(
      documentFamilyName(face.family),
      face.style,
      face.weight,
      face.stretch,
      face.unicodeRange,
    );
    loaded.set(key, (loaded.get(key) ?? 0) + 1);
  }
  const keyOf = (event: FontsUpdatedFace): string =>
    descriptorKey(event.fontFamily, event.fontStyle, event.fontWeight, event.fontStretch, event.unicodeRange);
  const faces: FontsUpdatedFace[] = [];
  const seenSources = new Set<string>();
  for (const event of events) {
    if (event.src !== "") {
      const identity = JSON.stringify([event.src, keyOf(event)]);
      if (seenSources.has(identity)) continue;
      seenSources.add(identity);
    }
    faces.push(event);
  }
  const facesByKey = new Map<string, number>();
  for (const face of faces) facesByKey.set(keyOf(face), (facesByKey.get(keyOf(face)) ?? 0) + 1);
  const join: FontsUpdatedJoin = { matched: [], unmatched: [], ambiguous: [] };
  for (const face of faces) {
    const key = keyOf(face);
    const available = loaded.get(key) ?? 0;
    if (available === 0) join.unmatched.push(face);
    else if ((facesByKey.get(key) ?? 0) > available) join.ambiguous.push(face);
    else join.matched.push(face);
  }
  return join;
}

/**
 * The registration item for one matched event: the authored family and the
 * descriptor text, registered like an `@font-face` rule. Null for an event
 * without a URL (an `ArrayBuffer` source has no bytes discovery can fetch).
 */
export function faceRuleFromFontsUpdatedFace(face: FontsUpdatedFace): FaceRule | null {
  if (face.src === "") return null;
  return {
    kind: "font-face",
    family: face.fontFamily,
    weight: face.fontWeight,
    style: face.fontStyle,
    styleDesc: face.fontStyle,
    url: face.src,
    urls: [face.src],
    source: "fonts-updated",
    unicodeRange: parseUnicodeRangeDescriptor(face.unicodeRange),
    stretch: face.fontStretch,
  };
}

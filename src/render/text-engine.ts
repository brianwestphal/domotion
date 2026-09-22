/**
 * Deliberate facade for Domotion's browser-faithful text engine.
 *
 * This module is the package seam: consumers describe an engine session, a
 * synchronous document render, and individual text runs without coordinating
 * font-resolution.ts or text-to-path.ts module globals themselves. The
 * underlying registries remain in those modules until the workspace move, but
 * their ownership and lifetime are explicit here.
 */

import {
  beginCharacterFallbackDocument,
  clearWebfonts,
  createFontRendererSession,
  emptyFontRegistrations,
  getEmbeddedFontFaceCss,
  getGlyphDefs,
  getRenderTextMode,
  registerLocalFontAlias,
  registerWebfont,
  resetGeneration,
  restoreFontRegistrations,
  restoreGeneration,
  snapshotFontRegistrations,
  snapshotGeneration,
  withFontRendererSession,
  withRenderTextMode,
  withSessionGenericFamilyOverrides,
  endCharacterFallbackDocument,
  type FontRegistrationSnapshot,
  type FontRendererSession,
  type GenerationSnapshot,
  type RenderTextMode,
  type SessionGenericFamilyOverrides,
} from "./font-resolution.js";
import { getEmbeddedFontBuildDiagnostics, type EmbeddedFontBuildDiagnostic } from "./embedded-font-builder.js";
import {
  popBaselineSnapSuppression,
  pushBaselineSnapSuppression,
  renderTextAsPath,
  restoreBaselineSnapSuppression,
  snapshotBaselineSnapSuppression,
  type RenderTextOptions,
} from "./text-to-path.js";
import { invokeSynchronousCallback, type SynchronousCallback } from "./synchronous-scope.js";

declare const textEngineSessionBrand: unique symbol;

/** One reusable renderer lifetime. Font registrations and generated artifacts
 * are isolated from every other session even while the implementation still
 * uses synchronous module-local registries. */
export interface TextEngineSession {
  readonly [textEngineSessionBrand]: true;
}

export interface TextEngineSessionOptions {
  /** Mode used when a document request does not provide an override. */
  defaultRenderTextMode?: RenderTextMode;
}

interface TextEngineSessionState {
  renderer: FontRendererSession;
  registrations: FontRegistrationSnapshot;
  generation: GenerationSnapshot | null;
  defaultRenderTextMode?: RenderTextMode;
}

const sessionStates = new WeakMap<TextEngineSession, TextEngineSessionState>();

function stateFor(session: TextEngineSession): TextEngineSessionState {
  const state = sessionStates.get(session);
  if (state == null) throw new TypeError("Unknown text-engine session");
  return state;
}

export function createTextEngineSession(options: TextEngineSessionOptions = {}): TextEngineSession {
  const session = Object.freeze({}) as TextEngineSession;
  sessionStates.set(session, {
    renderer: createFontRendererSession(),
    registrations: emptyFontRegistrations(),
    generation: null,
    defaultRenderTextMode: options.defaultRenderTextMode,
  });
  return session;
}

export interface TextEngineDocumentRequest {
  /** Reuse a renderer lifetime across related documents. Omit for an isolated
   * one-shot render, or inside an existing text-engine document. */
  session?: TextEngineSession;
  /** Reset generated glyph/font artifacts, or continue the session generation. */
  generation?: "reset" | "continue";
  /** Scoped text emitter selection. */
  renderTextMode?: RenderTextMode;
  /** Captured browser generic-family preferences for this document. */
  genericFamilies?: SessionGenericFamilyOverrides | null;
  /** Suppress local baseline rounding for the whole callback. */
  baselinePolicy?: "snap" | "suppress";
}

export interface TextEngineArtifacts {
  glyphDefs: string;
  embeddedFontFaceCss: string;
  embeddedFontDiagnostics: EmbeddedFontBuildDiagnostic[];
}

export interface TextEngineRunRequest extends RenderTextOptions {
  text: string;
  x: number;
  y: number;
}

export interface TextEngineRunResult {
  markup: string;
}

export interface TextEngineDocument {
  readonly session: TextEngineSession;
  readonly renderTextMode: RenderTextMode;
  renderRun(request: TextEngineRunRequest): TextEngineRunResult;
  enterBaselineSnappingSuppressed(): () => void;
  withBaselineSnappingSuppressed<F extends () => unknown>(render: SynchronousCallback<F>): ReturnType<F>;
  snapshotGeneration(): GenerationSnapshot;
  restoreGeneration(snapshot: GenerationSnapshot): void;
  artifacts(): TextEngineArtifacts;
}

export interface TextEngineDocumentResult<T> {
  value: T;
  artifacts: TextEngineArtifacts;
}

type SynchronousDocumentResult<T> = [T] extends [never]
  ? unknown
  : [Extract<T, PromiseLike<unknown>>] extends [never]
    ? unknown
    : never;
export type TextEngineDocumentCallback<T> = ((document: TextEngineDocument) => T) & SynchronousDocumentResult<T>;

let activeDocument: TextEngineDocument | null = null;

/** Internal adapter seam for tree renderers already executing in a document. */
export function activeTextEngineDocument(): TextEngineDocument | null {
  return activeDocument;
}

function collectArtifacts(): TextEngineArtifacts {
  return {
    glyphDefs: getGlyphDefs(),
    embeddedFontFaceCss: getEmbeddedFontFaceCss(),
    embeddedFontDiagnostics: getEmbeddedFontBuildDiagnostics(),
  };
}

function createDocument(session: TextEngineSession, renderTextMode: RenderTextMode): TextEngineDocument {
  let document!: TextEngineDocument;
  document = {
    session,
    renderTextMode,
    renderRun(request): TextEngineRunResult {
      if (activeDocument !== document) throw new Error("Text-engine runs must execute inside their owning document");
      const { text, x, y, ...options } = request;
      return { markup: renderTextAsPath(text, x, y, options) };
    },
    enterBaselineSnappingSuppressed(): () => void {
      if (activeDocument !== document) throw new Error("Baseline policy must execute inside its owning document");
      pushBaselineSnapSuppression();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        popBaselineSnapSuppression();
      };
    },
    withBaselineSnappingSuppressed<F extends () => unknown>(render: SynchronousCallback<F>): ReturnType<F> {
      if (activeDocument !== document) throw new Error("Baseline policy must execute inside its owning document");
      const release = document.enterBaselineSnappingSuppressed();
      try {
        return invokeSynchronousCallback("TextEngineDocument.withBaselineSnappingSuppressed", render);
      } finally {
        release();
      }
    },
    snapshotGeneration,
    restoreGeneration,
    artifacts: collectArtifacts,
  };
  return document;
}

function runScoped<T>(
  document: TextEngineDocument,
  request: TextEngineDocumentRequest,
  render: TextEngineDocumentCallback<T>,
): T {
  const invoke = (): T =>
    invokeSynchronousCallback("withTextEngineDocument", (() => render(document)) as unknown as SynchronousCallback<
      () => T
    >);
  const withFamilies = (): T =>
    request.genericFamilies == null
      ? invoke()
      : withSessionGenericFamilyOverrides(request.genericFamilies, invoke as unknown as SynchronousCallback<() => T>);
  const withBaseline = (): T =>
    request.baselinePolicy === "suppress"
      ? document.withBaselineSnappingSuppressed(withFamilies as unknown as SynchronousCallback<() => T>)
      : withFamilies();
  return withRenderTextMode(document.renderTextMode, withBaseline as unknown as SynchronousCallback<() => T>);
}

/**
 * Run one synchronous text-engine document and return both its value and all
 * generated artifacts. Nested adapters join the active document; an explicit
 * attempt to switch sessions or reset its generation fails loudly.
 */
export function withTextEngineDocument<T>(
  request: TextEngineDocumentRequest,
  render: TextEngineDocumentCallback<T>,
): TextEngineDocumentResult<T> {
  if (activeDocument != null) {
    if (request.session != null && request.session !== activeDocument.session) {
      throw new Error("Cannot switch text-engine sessions inside an active document");
    }
    if (request.generation === "reset") throw new Error("Cannot reset a nested text-engine document generation");
    const value = runScoped(activeDocument, request, render);
    return { value, artifacts: collectArtifacts() };
  }

  const implicitSession = request.session == null;
  const session = request.session ?? createTextEngineSession();
  const state = stateFor(session);
  const outerRegistrations = snapshotFontRegistrations();
  const outerGeneration = snapshotGeneration();
  const outerBaselineDepth = snapshotBaselineSnapSuppression();
  // Compatibility bridge for existing one-shot producers: registrations made
  // through the legacy public functions become the implicit document's owned
  // starting state. Explicit sessions always start isolated and use the
  // registerTextEngine* methods instead.
  if (implicitSession) state.registrations = outerRegistrations;
  restoreFontRegistrations(state.registrations);
  if (request.generation === "continue" && implicitSession) restoreGeneration(outerGeneration);
  else if (request.generation === "continue" && state.generation != null) restoreGeneration(state.generation);
  else resetGeneration();

  const mode = request.renderTextMode ?? state.defaultRenderTextMode ?? getRenderTextMode();
  const document = createDocument(session, mode);
  let artifacts: TextEngineArtifacts | null = null;
  try {
    const value = withFontRendererSession(state.renderer, () => {
      beginCharacterFallbackDocument();
      activeDocument = document;
      try {
        return runScoped(document, request, render);
      } finally {
        activeDocument = null;
        endCharacterFallbackDocument();
      }
    });
    artifacts = collectArtifacts();
    return { value, artifacts };
  } finally {
    state.registrations = snapshotFontRegistrations();
    state.generation = snapshotGeneration();
    restoreBaselineSnapSuppression(outerBaselineDepth);
    restoreGeneration(outerGeneration);
    restoreFontRegistrations(outerRegistrations);
  }
}

function mutateSessionRegistrations(session: TextEngineSession, mutate: () => void): void {
  const state = stateFor(session);
  if (activeDocument != null) {
    if (activeDocument.session !== session)
      throw new Error("Cannot mutate another text-engine session while rendering");
    mutate();
    state.registrations = snapshotFontRegistrations();
    return;
  }
  const outer = snapshotFontRegistrations();
  restoreFontRegistrations(state.registrations);
  try {
    mutate();
    state.registrations = snapshotFontRegistrations();
  } finally {
    restoreFontRegistrations(outer);
  }
}

export function clearTextEngineFonts(session: TextEngineSession): void {
  mutateSessionRegistrations(session, clearWebfonts);
}

export function registerTextEngineWebfont(
  session: TextEngineSession,
  family: string,
  weight: number,
  style: string,
  buffer: Buffer,
  unicodeRange?: Array<[number, number]>,
  stretch?: string,
  weightDesc?: string,
  styleDesc?: string,
): void {
  mutateSessionRegistrations(session, () =>
    registerWebfont(family, weight, style, buffer, unicodeRange, stretch, weightDesc, styleDesc),
  );
}

export function registerTextEngineLocalFontAlias(
  session: TextEngineSession,
  family: string,
  resolvedKey: string,
  weight: number = 400,
  italic: boolean = false,
): void {
  mutateSessionRegistrations(session, () => registerLocalFontAlias(family, resolvedKey, weight, italic));
}

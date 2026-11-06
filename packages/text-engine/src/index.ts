/**
 * `@domotion/text-engine` — the supported session/document/run API.
 *
 * Callers render text through a `TextEngineSession` and a synchronous
 * `withTextEngineDocument` transaction (docs/262-text-engine-session-boundary.md).
 * The focused subpaths (`./font-resolution`, `./text`, `./capture`, `./helpers`,
 * `./format`, `./diagnostics`, `./testing`) expose the integration seams Domotion's root
 * adapters consume; there is deliberately no deep-import subpath.
 */
export {
  activeTextEngineDocument,
  clearTextEngineFonts,
  createTextEngineSession,
  registerTextEngineLocalFontAlias,
  registerTextEngineWebfont,
  type TextEngineArtifacts,
  type TextEngineDocument,
  type TextEngineDocumentCallback,
  type TextEngineDocumentRequest,
  type TextEngineDocumentResult,
  type TextEngineRunRequest,
  type TextEngineRunResult,
  type TextEngineSession,
  type TextEngineSessionOptions,
  withTextEngineDocument,
} from "./render/text-engine.js";
// The synchronous-scope contract every engine `with*` guard enforces (DM-2637).
// Root adapters that own their own process-global scopes reuse it so the async
// rejection rule lives in one place.
export { invokeSynchronousCallback, type SynchronousCallback } from "./render/synchronous-scope.js";

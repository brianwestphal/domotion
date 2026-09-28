/**
 * `@domotion/text-engine/diagnostics` — opt-in text-run provenance recording and
 * render-phase profiling counters. Recording is off by default and never changes
 * emitted SVG.
 */
export { profAccum, profNow, profReset, profSnapshot } from "./render/render-profile.js";
export {
  type FixtureTextRunProvenance,
  getFixtureTextRunProvenance,
  getTextRunProvenance,
  recordTextEmitterTransition,
  resetTextRunProvenance,
  setTextRunProvenanceEnabled,
  type TextEmitterTransitionDiagnostic,
  type TextRunProvenanceDiagnostic,
  textRunProvenanceEnabled,
} from "./render/text-run-provenance.js";

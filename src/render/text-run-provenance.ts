// Root adapter over the text-engine workspace's public entry points (packages/text-engine/README.md).
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
} from "@domotion/text-engine/diagnostics";

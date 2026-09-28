// Root adapter over the text-engine workspace's public entry points (packages/text-engine/README.md).
export {
  appendGlyphCopy,
  compactGlyphIds,
  compactRetainedGlyphIds,
  getHbSubsetAttemptDiagnostics,
  hbSubsetRetainGids,
  injectPuaCmap,
  resetHbSubsetAttemptDiagnostics,
  resetHbSubsetWasmInstance,
  sfntHasSubsettableOutlines,
} from "@domotion/text-engine/text";

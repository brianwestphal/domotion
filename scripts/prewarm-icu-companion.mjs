import { acquireIcuCompanion } from "@domotion/text-engine/helpers";

// DM-T9Z4HF: acquire serially before Vitest's cold worker processes compete
// for the same release assets. Runtime consumers still retain degraded mode.
const executable = await acquireIcuCompanion();
if (executable == null) throw new Error("Could not prewarm the Chromium-matched ICU companion");
process.env.DOMOTION_ICU_HELPER_PATH = executable;
const { ICU_COMPANION_VERSION, queryIcuCodepoints, resolveIcuCompanionTarget } =
  await import("@domotion/text-engine/testing");
if (executable !== resolveIcuCompanionTarget()?.executablePath) {
  throw new Error(`Preferred ICU companion ${ICU_COMPANION_VERSION} unavailable; acquired ${executable}`);
}
if (queryIcuCodepoints([0x41]).get(0x41)?.scriptLongName !== "Latin") {
  throw new Error("Acquired ICU companion did not validate its versioned protocol and Latin probe");
}
console.log(`ICU companion ${ICU_COMPANION_VERSION} prewarmed and validated: ${executable}`);

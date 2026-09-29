/**
 * `@domotion/text-engine/diagnostics` — the render-phase profiling counters and
 * text-emitter transition recording the root renderer calls. Recording is off by
 * default and never changes emitted SVG; enabling, reading, and resetting it is
 * a harness concern on `./testing`.
 */
export { profAccum, profNow } from "./render/render-profile.js";
export { type FixtureTextRunProvenance, recordTextEmitterTransition } from "./render/text-run-provenance.js";

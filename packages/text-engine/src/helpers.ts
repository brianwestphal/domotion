/**
 * `@domotion/text-engine/helpers` — native glyph-helper and ICU companion
 * acquisition (the download-and-verify path Domotion exposes publicly). The
 * helper queries and availability probes the root oracles use live on
 * `./testing`.
 */
export { acquireGlyphHelper } from "./render/helper-acquire.js";
export { acquireIcuCompanion } from "./render/icu-helper-acquire.js";

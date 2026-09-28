/**
 * `@domotion/text-engine/capture` — page-context-safe helpers shared with the
 * in-page capture script: CSS `font-family` stack parsing/serialization and the
 * emoji-presentation detector. This entry and everything it imports must stay
 * free of Node built-ins, because the capture script is bundled for the browser
 * and `evaluate()`d in the captured page.
 */
export { createEmojiDetect, scanEmojiPresentation } from "./capture/script/emoji-detect.js";
export {
  blinkGenericFamilyFromEntries,
  capturedFontFamilyCss,
  type CapturedFontFamilyStack,
  captureFontFamilyStack,
  parseCssFontFamilyEntries,
  serializeCapturedFontFamilyStack,
} from "./font-family-stack.js";

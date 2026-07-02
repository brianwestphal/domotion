/**
 * Template subsystem barrel (DM-1276, doc 70).
 *
 * Public surface for building, loading, and rendering Domotion templates —
 * parameterized generators that produce a self-contained SVG by driving the
 * existing capture → compose pipeline. See `./types.ts` for the contract.
 */

export type { Template, TemplateOutput, TemplateRenderContext } from "./types.js";
export { isTemplate } from "./types.js";
export {
  listBuiltinTemplates,
  getBuiltinTemplate,
  loadTemplate,
  templatePackageName,
} from "./registry.js";
export {
  renderTemplateToSvg,
  validateTemplateParams,
  type RenderTemplateOptions,
} from "./render.js";
export {
  templateParamsJsonSchema,
  describeTemplateParams,
  type ParamInfo,
} from "./json-schema.js";
export {
  FORMATS,
  resolveFormat,
  applyFormatSize,
  safeAreaPadding,
  formatNames,
  type FormatPreset,
  type ResolvedFormat,
  type SafeInset,
  type EdgeInset,
} from "./formats.js";
export {
  brandSchema,
  loadBrand,
  brandParams,
  brandSeriesColors,
  brandBackground,
  type Brand,
} from "./brand.js";
export { applyBrandDefaults } from "./render.js";

// Built-in templates (also reachable via the registry by name).
export { lowerThirdTemplate, type LowerThirdParams } from "./builtin/lower-third.js";
export { deviceMockupTemplate, type DeviceMockupParams } from "./builtin/device-mockup.js";
export {
  backgroundLoopTemplate,
  type BackgroundLoopParams,
  type BackgroundVariant,
} from "./builtin/background-loop.js";
export {
  kineticTextTemplate,
  type KineticTextParams,
  type KineticVariant,
} from "./builtin/kinetic-text.js";
export {
  chartTemplate,
  type ChartParams,
  type ChartType,
} from "./builtin/chart.js";
export {
  chatTemplate,
  type ChatParams,
  type ChatMessage,
} from "./builtin/chat.js";
export {
  subscribeTemplate,
  type SubscribeParams,
} from "./builtin/subscribe.js";
// Creative pack — Batch A text cards (DM-1531).
export { titleCardTemplate, type TitleCardParams } from "./builtin/title-card.js";
export { quoteTemplate, type QuoteParams } from "./builtin/quote.js";
export { captionTemplate, type CaptionParams } from "./builtin/caption.js";
export { ctaTemplate, type CtaParams } from "./builtin/cta.js";
// Creative pack — Batch B number animation (DM-1532).
export { counterTemplate, type CounterParams } from "./builtin/counter.js";
export { statTemplate, type StatParams } from "./builtin/stat.js";
// Creative pack — Batch C before/after compare (DM-1533).
export { compareTemplate, type CompareParams } from "./builtin/compare.js";

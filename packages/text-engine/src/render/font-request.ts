import type { FontInstance } from "./font-instance.js";
import type { FontVariantEmojiOverride } from "./emoji-presentation.js";
import type { FontFallbackSemanticContext } from "./fallback-chain.js";

/** One fallback ask, carried unchanged through the ordered resolver stages. */
export interface FontRequest {
  cp: number;
  primaryFont: FontInstance;
  primaryFontKey: string;
  weight: number;
  fontSize: number;
  slant: number;
  variationSettings: Record<string, number> | undefined;
  lang: string | undefined;
  fontKeyChain: string[];
  systemUiPrimary: boolean;
  stretch: number;
  fontVariantEmoji: FontVariantEmojiOverride | undefined;
  declaredFamily: string | undefined;
  rawSlope: number;
  orientation: number;
  semanticContext: FontFallbackSemanticContext;
}

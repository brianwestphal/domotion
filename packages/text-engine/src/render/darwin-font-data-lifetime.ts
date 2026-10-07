import { hostPlatform } from "./host-platform.js";

// Chromium 147 FontDataCache keeps 64 SimpleFontData values strongly. Its
// platform-data map and the other FontData cache values are weak. A document's
// FontFallbackList is another strong owner; when that document goes away, GC
// can expire a platform family match that has fallen out of this LRU.
export const DARWIN_FONT_DATA_STRONG_LRU_SIZE = 64;

export function darwinFontDataIdentity(
  face: string,
  weight: number,
  size: number,
  slant: number,
  stretch: number,
  variationSettings?: Record<string, number>,
): string {
  return `${face}|${weight}|${size}|${slant}|${stretch}|${darwinVariationKey(variationSettings)}`;
}

function darwinVariationKey(settings?: Record<string, number>): string {
  return settings == null
    ? ""
    : Object.entries(settings)
        .filter(([axis, value]) => axis.length === 4 && Number.isFinite(value))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([axis, value]) => `${axis}:${value}`)
        .join(",");
}

export interface DarwinFontDescription {
  weight: number;
  size: number;
  slant: number;
  stretch: number;
  variationSettings?: Record<string, number>;
  /** Blink FontDescription::CacheKey inputs that do not select a font instance. */
  cacheOptions?: DarwinFontCacheOptions;
}

export interface DarwinFontCacheOptions {
  sizeAdjust?: string;
  palette?: string;
  variantAlternates?: string;
  variantEmoji?: string;
  opticalSizing?: string;
  synthesisWeight?: string;
  synthesisStyle?: string;
  textRendering?: string;
  orientation?: number;
}

export const DARWIN_INITIAL_FONT_DESCRIPTION: DarwinFontDescription = {
  weight: 400,
  size: 16,
  slant: 0,
  stretch: 100,
};

export function darwinFontDescriptionKey(description: DarwinFontDescription): string {
  const options = description.cacheOptions;
  return JSON.stringify([
    description.weight,
    description.size,
    description.slant,
    description.stretch,
    darwinVariationKey(description.variationSettings),
    options?.sizeAdjust ?? "none",
    options?.palette ?? "normal",
    options?.variantAlternates ?? "normal",
    options?.variantEmoji ?? "normal",
    options?.opticalSizing ?? "auto",
    options?.synthesisWeight ?? "auto",
    options?.synthesisStyle ?? "auto",
    options?.textRendering ?? "auto",
    options?.orientation ?? 0,
  ]);
}

function systemUiFontDataIdentity(description: DarwinFontDescription): string {
  return darwinFontDataIdentity(
    "sf-pro",
    description.weight,
    description.size,
    description.slant,
    description.stretch,
    description.variationSettings,
  );
}

interface FontDataLifetime {
  strongLru: Map<string, true>;
  systemUiAliases: Map<string, string>;
}

function newLifetime(): FontDataLifetime {
  return { strongLru: new Map(), systemUiAliases: new Map() };
}

let active: FontDataLifetime | null = null;
let rendererStates = new WeakMap<object, FontDataLifetime>();

export function beginDarwinFontDataDocument(session: object | null): void {
  if (hostPlatform() !== "darwin") return;
  if (session == null) {
    active = newLifetime();
  } else {
    let state = rendererStates.get(session);
    if (state == null) {
      state = newLifetime();
      rendererStates.set(session, state);
    }
    active = state;
  }
}

export function endDarwinFontDataDocument(): void {
  active = null;
}

export function resetDarwinFontDataRendererStates(): void {
  rendererStates = new WeakMap();
  active = null;
}

/** Blink's exact-name system-ui dispatch inserts one platform-cache entry for
 * this FontDescription. A differently sized or styled literal cannot reuse it. */
export function warmDarwinSystemUiAlias(description: DarwinFontDescription): void {
  if (hostPlatform() !== "darwin" || active == null) return;
  active.systemUiAliases.set(darwinFontDescriptionKey(description), systemUiFontDataIdentity(description));
}

export function hasWarmDarwinSystemUiAlias(description: DarwinFontDescription): boolean {
  return active?.systemUiAliases.has(darwinFontDescriptionKey(description)) ?? false;
}

/** Called only after the old document is torn down and Chromium GC runs. */
export function collectDarwinSystemUiAliasesAfterGc(): void {
  if (hostPlatform() !== "darwin" || active == null) return;
  for (const [description, identity] of active.systemUiAliases) {
    if (!active.strongLru.has(identity)) active.systemUiAliases.delete(description);
  }
}

/** An explicit FontData acquisition. A repeated acquisition moves the same
 * SimpleFontData to the LRU front, as in FontDataCache::Get. */
export function recordDarwinFontDataUse(identity: string): void {
  if (hostPlatform() !== "darwin" || active == null) return;
  active.strongLru.delete(identity);
  active.strongLru.set(identity, true);
  while (active.strongLru.size > DARWIN_FONT_DATA_STRONG_LRU_SIZE) {
    const oldest = active.strongLru.keys().next().value;
    if (oldest == null) break;
    active.strongLru.delete(oldest);
  }
}

export function darwinFontDataLruForTest(): string[] {
  return [...(active?.strongLru.keys() ?? [])];
}

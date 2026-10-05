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
): string {
  return `${face}|${weight}|${size}|${slant}|${stretch}`;
}

interface FontDataLifetime {
  strongLru: Map<string, true>;
}

let active: FontDataLifetime | null = null;
let rendererStates = new WeakMap<object, FontDataLifetime>();

export function beginDarwinFontDataDocument(session: object | null): void {
  if (hostPlatform() !== "darwin") return;
  if (session == null) {
    active = { strongLru: new Map() };
  } else {
    let state = rendererStates.get(session);
    if (state == null) {
      state = { strongLru: new Map() };
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

/** Mirrors a deliberate browser document teardown followed by GC. The caller
 * decides which weak family entries to forget from the retained FontData. */
export function darwinFontDataSurvivesDocumentGc(identity: string): boolean {
  return active?.strongLru.has(identity) ?? false;
}

export function darwinFontDataLruForTest(): string[] {
  return [...(active?.strongLru.keys() ?? [])];
}

export const SCRUBBER_EMBED_CHANNEL = "domotion-svg-scrubber/v1" as const;

export interface ScrubberEmbedViewState {
  playheadMs: number;
  rangeStartMs: number;
  rangeEndMs: number;
  zoom: number;
  panX: number;
  panY: number;
  speed: number;
  loop: boolean;
}

export type ScrubberEmbedCommand = {
  channel: typeof SCRUBBER_EMBED_CHANNEL;
  type: "load";
  sourceKey: string;
  svg: string;
  name: string;
  durationMs: number;
  restoreState?: ScrubberEmbedViewState;
} | {
  channel: typeof SCRUBBER_EMBED_CHANNEL;
  type: "request-state";
} | {
  channel: typeof SCRUBBER_EMBED_CHANNEL;
  type: "seek";
  sourceKey: string;
  playheadMs: number;
};

export type ScrubberEmbedEvent = {
  channel: typeof SCRUBBER_EMBED_CHANNEL;
  type: "ready";
} | {
  channel: typeof SCRUBBER_EMBED_CHANNEL;
  type: "loaded" | "state";
  sourceKey: string;
  durationMs: number;
  state: ScrubberEmbedViewState;
} | {
  channel: typeof SCRUBBER_EMBED_CHANNEL;
  type: "error";
  sourceKey?: string;
  message: string;
};

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isViewState(value: unknown): value is ScrubberEmbedViewState {
  if (value == null || typeof value !== "object") return false;
  const state = value as Partial<ScrubberEmbedViewState>;
  return [state.playheadMs, state.rangeStartMs, state.rangeEndMs, state.zoom, state.panX, state.panY, state.speed]
    .every((item) => typeof item === "number" && Number.isFinite(item))
    && typeof state.loop === "boolean";
}

/** Clamp persisted UI context to a regenerated SVG's current duration. */
export function normalizeScrubberEmbedViewState(
  value: Partial<ScrubberEmbedViewState> | undefined,
  durationMs: number,
): ScrubberEmbedViewState {
  const duration = Math.max(1, finite(durationMs, 1000));
  const clampTime = (candidate: unknown, fallback: number): number => Math.max(0, Math.min(duration, finite(candidate, fallback)));
  const start = clampTime(value?.rangeStartMs, 0);
  const end = Math.max(start, clampTime(value?.rangeEndMs, duration));
  return {
    playheadMs: clampTime(value?.playheadMs, start),
    rangeStartMs: start,
    rangeEndMs: end,
    zoom: Math.max(0.02, Math.min(16, finite(value?.zoom, 1))),
    panX: finite(value?.panX, 0),
    panY: finite(value?.panY, 0),
    speed: Math.max(0.1, Math.min(4, finite(value?.speed, 1))),
    loop: value?.loop ?? true,
  };
}

export function isScrubberEmbedCommand(value: unknown): value is ScrubberEmbedCommand {
  if (value == null || typeof value !== "object") return false;
  const command = value as Partial<ScrubberEmbedCommand> & Record<string, unknown>;
  if (command.channel !== SCRUBBER_EMBED_CHANNEL) return false;
  if (command.type === "request-state") return true;
  if (command.type === "seek") {
    return typeof command.sourceKey === "string"
      && command.sourceKey.trim() !== ""
      && typeof command.playheadMs === "number"
      && Number.isFinite(command.playheadMs)
      && command.playheadMs >= 0;
  }
  return command.type === "load"
    && typeof command.sourceKey === "string"
    && command.sourceKey.trim() !== ""
    && typeof command.svg === "string"
    && command.svg.includes("<svg")
    && typeof command.name === "string"
    && typeof command.durationMs === "number"
    && Number.isFinite(command.durationMs)
    && command.durationMs > 0
    && (command.restoreState == null || isViewState(command.restoreState));
}

export function isScrubberEmbedEvent(value: unknown): value is ScrubberEmbedEvent {
  if (value == null || typeof value !== "object") return false;
  const event = value as Partial<ScrubberEmbedEvent> & Record<string, unknown>;
  if (event.channel !== SCRUBBER_EMBED_CHANNEL) return false;
  if (event.type === "ready") return true;
  if (event.type === "error") return typeof event.message === "string";
  return (event.type === "loaded" || event.type === "state")
    && typeof event.sourceKey === "string"
    && typeof event.durationMs === "number"
    && Number.isFinite(event.durationMs)
    && isViewState(event.state);
}

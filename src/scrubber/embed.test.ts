import { describe, expect, it } from "vitest";
import {
  SCRUBBER_EMBED_CHANNEL,
  isScrubberEmbedCommand,
  isScrubberEmbedEvent,
  normalizeScrubberEmbedViewState,
} from "./embed.js";

describe("SVG Scrubber embed protocol (DM-2689)", () => {
  it("clamps retained playhead, range, zoom, pan, and speed to regenerated media", () => {
    expect(normalizeScrubberEmbedViewState({
      playheadMs: 1800,
      rangeStartMs: 200,
      rangeEndMs: 1900,
      zoom: 99,
      panX: 24,
      panY: -8,
      speed: 8,
      loop: false,
    }, 1200)).toEqual({
      playheadMs: 1200,
      rangeStartMs: 200,
      rangeEndMs: 1200,
      zoom: 16,
      panX: 24,
      panY: -8,
      speed: 4,
      loop: false,
    });
  });

  it("accepts only bounded version-one commands and recognizable events", () => {
    expect(isScrubberEmbedCommand({
      channel: SCRUBBER_EMBED_CHANNEL,
      type: "load",
      sourceKey: "scene:opening",
      svg: "<svg/>",
      name: "opening",
      durationMs: 1000,
    })).toBe(true);
    expect(isScrubberEmbedCommand({ channel: SCRUBBER_EMBED_CHANNEL, type: "seek", sourceKey: "scene:opening", playheadMs: 250 })).toBe(true);
    expect(isScrubberEmbedCommand({ channel: SCRUBBER_EMBED_CHANNEL, type: "seek", sourceKey: "scene:opening", playheadMs: -1 })).toBe(false);
    expect(isScrubberEmbedCommand({ channel: "domotion-svg-scrubber/v2", type: "request-state" })).toBe(false);
    expect(isScrubberEmbedCommand({ channel: SCRUBBER_EMBED_CHANNEL, type: "load", sourceKey: "x", svg: "oops", name: "x", durationMs: 0 })).toBe(false);
    expect(isScrubberEmbedEvent({ channel: SCRUBBER_EMBED_CHANNEL, type: "ready" })).toBe(true);
    expect(isScrubberEmbedEvent({ channel: SCRUBBER_EMBED_CHANNEL, type: "state", sourceKey: "scene:x", durationMs: 1000, state: {} })).toBe(false);
    expect(isScrubberEmbedEvent({ channel: SCRUBBER_EMBED_CHANNEL, type: "unknown" })).toBe(false);
  });
});

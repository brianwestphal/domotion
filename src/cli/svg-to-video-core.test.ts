import { describe, expect, it } from "vitest";
import {
  buildFfmpegArgs,
  fitContain,
  parseSvgIntrinsicSize,
  resolveDurationMs,
  resolveFormat,
  type AnimTiming,
  type ResolvedFormat,
} from "./svg-to-video-core.js";

describe("fitContain", () => {
  it("returns the natural size (rounded to even) when no bounds are given", () => {
    expect(fitContain(800, 500)).toEqual({ width: 800, height: 500 });
    expect(fitContain(801, 501)).toEqual({ width: 802, height: 502 }); // forced even
  });

  it("contains within a max box preserving aspect ratio", () => {
    // 800×500 into width 400 → 400×250
    expect(fitContain(800, 500, 400, undefined)).toEqual({ width: 400, height: 250 });
    // height-bound: 800×500 into height 250 → 400×250
    expect(fitContain(800, 500, undefined, 250)).toEqual({ width: 400, height: 250 });
    // both bounds: pick the smaller scale (height wins here) → 320×200
    expect(fitContain(800, 500, 1000, 200)).toEqual({ width: 320, height: 200 });
  });

  it("never upscales past the smaller bound and keeps dims even", () => {
    const { width, height } = fitContain(1920, 1080, 1280, undefined);
    expect(width).toBe(1280);
    expect(height).toBe(720);
    expect(width % 2).toBe(0);
    expect(height % 2).toBe(0);
  });

  it("throws on a zero-size SVG", () => {
    expect(() => fitContain(0, 0)).toThrow(/intrinsic size/);
  });
});

describe("parseSvgIntrinsicSize", () => {
  it("prefers viewBox", () => {
    expect(parseSvgIntrinsicSize('<svg viewBox="0 0 800 500" width="100" height="60">')).toEqual({ w: 800, h: 500 });
  });
  it("falls back to width/height attributes (units stripped)", () => {
    expect(parseSvgIntrinsicSize('<svg width="640px" height="360px">')).toEqual({ w: 640, h: 360 });
  });
  it("returns null when unsized", () => {
    expect(parseSvgIntrinsicSize("<svg xmlns='http://www.w3.org/2000/svg'>")).toBeNull();
  });
});

describe("resolveDurationMs", () => {
  const inf = (duration: number): AnimTiming => ({ duration, iterations: Infinity, endTime: Infinity });
  const fin = (endTime: number, duration = endTime): AnimTiming => ({ duration, iterations: 1, endTime });

  it("honors an explicit override (seconds → ms)", () => {
    expect(resolveDurationMs([inf(3000)], 5)).toBe(5000);
  });

  it("uses one loop period for a uniform infinite loop (domotion case)", () => {
    expect(resolveDurationMs([inf(4000), inf(4000), inf(4000)])).toBe(4000);
  });

  it("takes the LCM of distinct infinite periods (one full cycle)", () => {
    expect(resolveDurationMs([inf(2000), inf(3000)])).toBe(6000);
  });

  it("uses the max finite end time when nothing loops", () => {
    expect(resolveDurationMs([fin(1500), fin(2200)])).toBe(2200);
  });

  it("throws when there are no animations and no override", () => {
    expect(() => resolveDurationMs([])).toThrow(/no --duration/i);
  });

  it("throws when incommensurate infinite periods exceed the auto cap", () => {
    // lcm(7000, 9999) is huge → over the (small) cap here
    expect(() => resolveDurationMs([inf(7000), inf(9999)], undefined, 60_000)).toThrow(/--duration/);
  });

  it("rejects a non-positive override", () => {
    expect(() => resolveDurationMs([inf(1000)], 0)).toThrow(/positive/);
  });
});

describe("resolveFormat", () => {
  it("maps known formats to codec + default container + pix_fmt", () => {
    expect(resolveFormat("h264")).toEqual({ videoCodec: "libx264", container: "mp4", pixFmt: "yuv420p" });
    expect(resolveFormat("vp9")).toEqual({ videoCodec: "libvpx-vp9", container: "webm", pixFmt: "yuv420p" });
    expect(resolveFormat("hevc")).toEqual({ videoCodec: "libx265", container: "mp4", pixFmt: "yuv420p" });
  });
  it("honors a container override", () => {
    expect(resolveFormat("h264", "mov").container).toBe("mov");
  });
  it("throws on an unknown format", () => {
    expect(() => resolveFormat("xyz")).toThrow(/Unsupported --format/);
  });
});

describe("buildFfmpegArgs", () => {
  const h264: ResolvedFormat = { videoCodec: "libx264", container: "mp4", pixFmt: "yuv420p" };
  const base = {
    fps: 30,
    frameWidth: 800,
    frameHeight: 500,
    outWidth: 800,
    outHeight: 500,
    fmt: h264,
    output: "out.mp4",
    burnCaptions: false,
  };

  it("builds a video-only pipe command", () => {
    const a = buildFfmpegArgs(base);
    expect(a).toContain("-f");
    expect(a).toContain("image2pipe");
    expect(a.join(" ")).toContain("-i -"); // frames from stdin
    expect(a).toContain("libx264");
    expect(a).toContain("yuv420p");
    expect(a.join(" ")).toContain("-map 0:v:0");
    expect(a.join(" ")).not.toContain("-c:a"); // no audio track
    expect(a.join(" ")).toContain("-movflags +faststart");
    expect(a[a.length - 1]).toBe("out.mp4");
  });

  it("adds a lanczos downscale only when supersampled", () => {
    expect(buildFfmpegArgs(base).join(" ")).not.toContain("scale=");
    const ss = buildFfmpegArgs({ ...base, frameWidth: 1600, frameHeight: 1000 });
    expect(ss.join(" ")).toContain("scale=800:500:flags=lanczos");
  });

  it("loops + trims background music and adds an audio codec", () => {
    const a = buildFfmpegArgs({ ...base, music: "bed.mp3" });
    expect(a.join(" ")).toContain("-stream_loop -1 -i bed.mp3");
    expect(a.join(" ")).toContain("-map 1:a:0");
    expect(a).toContain("-shortest");
    expect(a.join(" ")).toContain("-c:a aac");
  });

  it("mixes music + foreground audio with amix", () => {
    const a = buildFfmpegArgs({ ...base, music: "bed.mp3", audio: "vo.m4a" }).join(" ");
    expect(a).toContain("amix=inputs=2");
    expect(a).toContain("[aout]");
    expect(a).toContain("-map [aout]");
  });

  it("soft-muxes captions (mov_text for mp4) by default", () => {
    const a = buildFfmpegArgs({ ...base, captions: "cap.srt" }).join(" ");
    expect(a).toContain("-i cap.srt");
    expect(a).toContain("-c:s mov_text");
    expect(a).not.toContain("subtitles=");
  });

  it("burns captions into the video filter when --burn-captions", () => {
    const a = buildFfmpegArgs({ ...base, captions: "cap.srt", burnCaptions: true }).join(" ");
    expect(a).toContain("subtitles=cap.srt");
    expect(a).not.toContain("-c:s");
  });

  it("uses webm audio/subtitle codecs for a webm container", () => {
    const vp9: ResolvedFormat = { videoCodec: "libvpx-vp9", container: "webm", pixFmt: "yuv420p" };
    const a = buildFfmpegArgs({ ...base, fmt: vp9, output: "out.webm", music: "bed.mp3", captions: "cap.vtt" }).join(" ");
    expect(a).toContain("-c:a libopus");
    expect(a).toContain("-c:s webvtt");
    expect(a).not.toContain("faststart");
  });
});

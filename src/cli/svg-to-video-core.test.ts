import { describe, expect, it } from "vitest";
import {
  buildFfmpegArgs,
  findDuplicateIds,
  fitContain,
  frameSampleTimeMs,
  isAnimatedImageContainer,
  isTransparentBackground,
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
    expect(resolveFormat("h264")).toEqual({ videoCodec: "libx264", container: "mp4", pixFmt: "yuv420p", extraArgs: [], alpha: false, alphaCapable: false });
    expect(resolveFormat("vp9")).toEqual({ videoCodec: "libvpx-vp9", container: "webm", pixFmt: "yuv420p", extraArgs: [], alpha: false, alphaCapable: true });
    expect(resolveFormat("hevc")).toEqual({ videoCodec: "libx265", container: "mp4", pixFmt: "yuv420p", extraArgs: [], alpha: false, alphaCapable: false });
  });
  it("honors a container override", () => {
    expect(resolveFormat("h264", "mov").container).toBe("mov");
  });
  it("throws on an unknown format", () => {
    expect(() => resolveFormat("xyz")).toThrow(/Unsupported --format/);
  });
  it("maps the animated-image formats and ignores a container override for them", () => {
    expect(resolveFormat("gif")).toEqual({ videoCodec: "gif", container: "gif", pixFmt: "pal8", extraArgs: [], alpha: false, alphaCapable: true });
    expect(resolveFormat("apng")).toEqual({ videoCodec: "apng", container: "apng", pixFmt: "rgba", extraArgs: [], alpha: false, alphaCapable: true });
    // a nonsensical override can't desync the format from its container
    expect(resolveFormat("gif", "mp4").container).toBe("gif");
    expect(resolveFormat("apng", "webm").container).toBe("apng");
  });
  it("classifies animated-image containers", () => {
    expect(isAnimatedImageContainer("gif")).toBe(true);
    expect(isAnimatedImageContainer("apng")).toBe(true);
    expect(isAnimatedImageContainer("mp4")).toBe(false);
    expect(isAnimatedImageContainer("webm")).toBe(false);
  });

  // DM-1142: transparency-aware resolution.
  it("switches alpha-capable formats to their alpha pix_fmt when transparent", () => {
    expect(resolveFormat("vp9", undefined, true)).toMatchObject({ pixFmt: "yuva420p", alpha: true, alphaCapable: true });
    // ProRes 4444: alpha pix_fmt + the 4444 profile arg.
    expect(resolveFormat("prores", undefined, true)).toMatchObject({
      videoCodec: "prores_ks", container: "mov", pixFmt: "yuva444p10le", extraArgs: ["-profile:v", "4"], alpha: true, alphaCapable: true,
    });
    // gif/apng are alpha-capable and emit alpha when transparent.
    expect(resolveFormat("gif", undefined, true)).toMatchObject({ alpha: true, alphaCapable: true });
    expect(resolveFormat("apng", undefined, true)).toMatchObject({ pixFmt: "rgba", alpha: true });
  });

  it("keeps non-alpha formats opaque even when transparent is requested", () => {
    // h264/hevc/av1/vp8 can't carry alpha → alpha:false (caller composites + warns).
    // VP8 is excluded because ffmpeg's libvpx VP8 encoder can't open with yuva420p.
    for (const f of ["h264", "hevc", "av1", "vp8"]) {
      const r = resolveFormat(f, undefined, true);
      expect(r.pixFmt).toBe("yuv420p");
      expect(r.alpha).toBe(false);
      expect(r.alphaCapable).toBe(false);
    }
  });

  it("uses ProRes HQ profile (opaque) by default", () => {
    expect(resolveFormat("prores")).toMatchObject({ videoCodec: "prores_ks", container: "mov", pixFmt: "yuv422p10le", extraArgs: ["-profile:v", "3"], alpha: false });
  });
});

describe("findDuplicateIds (DM-1149)", () => {
  it("returns ids that appear more than once, de-duplicated", () => {
    expect(findDuplicateIds(`<a id="x"/><b id="y"/><c id="x"/>`)).toEqual(["x"]);
    expect(findDuplicateIds(`<a id="p"/><b id="p"/><c id="q"/><d id="q"/>`).sort()).toEqual(["p", "q"]);
  });
  it("returns empty when all ids are unique", () => {
    expect(findDuplicateIds(`<a id="x"/><b id="y"/><c id="z"/>`)).toEqual([]);
    expect(findDuplicateIds(`<svg><rect/></svg>`)).toEqual([]);
  });
});

describe("frameSampleTimeMs (DM-1144)", () => {
  it("samples the CENTER of each frame interval, not the start (avoids keyframe-boundary ghosting)", () => {
    // (i + 0.5) / fps, in ms. At 24fps a frame is 1000/24 ≈ 41.667ms.
    expect(frameSampleTimeMs(0, 24)).toBeCloseTo(20.833, 2);
    expect(frameSampleTimeMs(1, 24)).toBeCloseTo(62.5, 2);
    expect(frameSampleTimeMs(6, 24)).toBeCloseTo(270.833, 2); // 6.77% of 4s — INSIDE a frame's window, not the 6.25% boundary
    // Never lands on a start boundary i/fps (where two cut frames overlap at opacity 1).
    for (const fps of [24, 25, 30, 60]) {
      for (let i = 0; i < 5; i++) {
        const center = frameSampleTimeMs(i, fps);
        expect(center).toBeGreaterThan((i * 1000) / fps);
        expect(center).toBeLessThan(((i + 1) * 1000) / fps);
        // exactly the midpoint
        expect(center).toBeCloseTo(((i + 0.5) * 1000) / fps, 6);
      }
    }
  });
});

describe("isTransparentBackground (DM-1142)", () => {
  it("treats keyword / zero-alpha values as transparent", () => {
    for (const v of ["transparent", "none", "  Transparent ", "rgba(0,0,0,0)", "rgba(255, 0, 0, 0)", "hsla(0,0%,0%,0)", "#0000", "#abc0", "#11223300"]) {
      expect(isTransparentBackground(v), v).toBe(true);
    }
  });
  it("treats opaque values as not transparent", () => {
    for (const v of ["#ffffff", "white", "#000", "rgb(0,0,0)", "rgba(0,0,0,1)", "rgba(0,0,0,0.5)", "#000000ff", "#abcf"]) {
      expect(isTransparentBackground(v), v).toBe(false);
    }
  });
});

describe("buildFfmpegArgs", () => {
  const h264: ResolvedFormat = { videoCodec: "libx264", container: "mp4", pixFmt: "yuv420p", extraArgs: [], alpha: false, alphaCapable: false };
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
    // DM-1146: a non-supersampled yuv420p render still carries a `scale=iw:ih`
    // color-conversion pass, but NO lanczos downscale to a target size.
    expect(buildFfmpegArgs(base).join(" ")).not.toContain("flags=lanczos");
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
    const vp9: ResolvedFormat = { videoCodec: "libvpx-vp9", container: "webm", pixFmt: "yuv420p", extraArgs: [], alpha: false, alphaCapable: true };
    const a = buildFfmpegArgs({ ...base, fmt: vp9, output: "out.webm", music: "bed.mp3", captions: "cap.vtt" }).join(" ");
    expect(a).toContain("-c:a libopus");
    expect(a).toContain("-c:s webvtt");
    expect(a).not.toContain("faststart");
  });

  const gif: ResolvedFormat = { videoCodec: "gif", container: "gif", pixFmt: "pal8", extraArgs: [], alpha: false, alphaCapable: true };
  const apng: ResolvedFormat = { videoCodec: "apng", container: "apng", pixFmt: "rgba", extraArgs: [], alpha: false, alphaCapable: true };

  it("builds a GIF via the palettegen/paletteuse filtergraph", () => {
    const a = buildFfmpegArgs({ ...base, fmt: gif, output: "out.gif" });
    const s = a.join(" ");
    expect(s).toContain("image2pipe");
    expect(s).toContain("split[s0][s1]");
    expect(s).toContain("palettegen");
    expect(s).toContain("paletteuse");
    expect(s).toContain("-map [v]");
    expect(s).toContain("-f gif");
    expect(a[a.length - 1]).toBe("out.gif");
  });

  it("downscales inside the GIF graph when supersampled, not as a separate -vf", () => {
    const ss = buildFfmpegArgs({ ...base, fmt: gif, output: "out.gif", frameWidth: 1600, frameHeight: 1000 }).join(" ");
    expect(ss).toContain("scale=800:500:flags=lanczos,split");
    expect(ss).not.toContain("-vf "); // folded into -filter_complex
  });

  // DM-1142: transparent-output ffmpeg args.
  it("reserves a transparent palette index for a transparent GIF", () => {
    const opaque = buildFfmpegArgs({ ...base, fmt: gif, output: "out.gif" }).join(" ");
    expect(opaque).not.toContain("reserve_transparent");
    expect(opaque).not.toContain("alpha_threshold");
    const alphaGif: ResolvedFormat = { ...gif, alpha: true };
    const s = buildFfmpegArgs({ ...base, fmt: alphaGif, output: "out.gif" }).join(" ");
    expect(s).toContain("palettegen=reserve_transparent=1");
    expect(s).toContain("alpha_threshold=128");
  });

  // DM-1146: color metadata for the yuv420p formats.
  it("tags bt709 + converts to limited range by default for yuv420p (h264)", () => {
    const s = buildFfmpegArgs(base).join(" ");
    expect(s).toContain("out_color_matrix=bt709");
    expect(s).toContain("in_range=full:out_range=tv");
    expect(s).toContain("-colorspace bt709");
    expect(s).toContain("-color_primaries bt709");
    expect(s).toContain("-color_range tv");
  });

  it("uses full range when colorRange=pc", () => {
    const s = buildFfmpegArgs({ ...base, colorRange: "pc" }).join(" ");
    expect(s).toContain("out_range=pc");
    expect(s).toContain("-color_range pc");
  });

  it("folds the color conversion into the lanczos downscale (no extra scale pass)", () => {
    const s = buildFfmpegArgs({ ...base, frameWidth: 1600, frameHeight: 1000 }).join(" ");
    expect(s).toContain("scale=800:500:flags=lanczos:in_range=full:out_range=tv:out_color_matrix=bt709");
  });

  it("does NOT color-manage non-yuv420p formats (prores 4:4:4 handles its own color)", () => {
    const prores: ResolvedFormat = { videoCodec: "prores_ks", container: "mov", pixFmt: "yuv422p10le", extraArgs: ["-profile:v", "3"], alpha: false, alphaCapable: true };
    const s = buildFfmpegArgs({ ...base, fmt: prores, output: "out.mov" }).join(" ");
    expect(s).not.toContain("out_color_matrix");
    expect(s).not.toContain("-color_range");
  });

  it("emits the ProRes 4444 profile + yuva pix_fmt for a transparent .mov", () => {
    const proresAlpha: ResolvedFormat = { videoCodec: "prores_ks", container: "mov", pixFmt: "yuva444p10le", extraArgs: ["-profile:v", "4"], alpha: true, alphaCapable: true };
    const a = buildFfmpegArgs({ ...base, fmt: proresAlpha, output: "out.mov" });
    const s = a.join(" ");
    expect(s).toContain("-c:v prores_ks -profile:v 4 -pix_fmt yuva444p10le");
    expect(a[a.length - 1]).toBe("out.mov");
  });

  it("builds an APNG with the apng encoder, rgba, and looping", () => {
    const a = buildFfmpegArgs({ ...base, fmt: apng, output: "out.png" });
    const s = a.join(" ");
    expect(s).toContain("-c:v apng");
    expect(s).toContain("-pix_fmt rgba");
    expect(s).toContain("-plays 0");
    expect(s).toContain("-f apng");
    expect(s).not.toContain("palettegen");
    expect(a[a.length - 1]).toBe("out.png");
  });

  it("drops audio + soft captions for animated-image formats (burn-in still applies)", () => {
    // music/audio/soft-captions are ignored; only burn-in subtitles reach the filter.
    const dropped = buildFfmpegArgs({ ...base, fmt: gif, output: "out.gif", music: "bed.mp3", audio: "vo.m4a", captions: "cap.srt" }).join(" ");
    expect(dropped).not.toContain("-c:a");
    expect(dropped).not.toContain("-c:s");
    expect(dropped).not.toContain("amix");
    expect(dropped).not.toContain("subtitles=");

    const burned = buildFfmpegArgs({ ...base, fmt: gif, output: "out.gif", captions: "cap.srt", burnCaptions: true }).join(" ");
    expect(burned).toContain("subtitles=cap.srt");
  });
});

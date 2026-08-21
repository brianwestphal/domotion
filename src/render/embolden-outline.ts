// Synthetic (faux) bold and oblique paint geometry.
//
// Chromium 7d859f27 carries Skia 62efacd37737505732dbe3d8daa62abd679626a1.
// Blink puts its synthetic-bold decision on `SkFont::setEmbolden`; Skia then
// converts that flag to paint geometry in every Chromium desktop backend:
//
//   * FreeType: `src/ports/SkFontHost_FreeType.cpp:821-824`
//   * CoreText: `src/ports/SkTypeface_mac_ct.cpp:887-889`
//   * DirectWrite: `src/ports/SkTypeface_win_dw.cpp:727-729`
//   * Fontations: `src/ports/SkTypeface_fontations.cpp:299`
//
// All three call `SkScalerContextRec::useStrokeForFakeBold`
// (`src/core/SkScalerContext.cpp:1019-1041`). It clears the embolden flag and
// changes the scaler record, never the source outline: a fill becomes
// frame-and-fill at `extra`, and an existing stroke becomes `width + extra`.
// `extra` is the source-owned size interpolation in `SkTextFormatParams.h`.
// Keeping the stages explicit below is important for `paint-order: stroke fill`:
// the author stroke and synthetic fill are two differently colored Skia passes
// and cannot be represented by a calibrated design-space outline dilation.

import type { PathCommand } from "./embedded-font-builder.js";

/** Requested-vs-face weight gap above which Blink's generic Skia path
 * synthesizes a static face (`font_cache_skia.cc:333-339`, Chromium
 * 7d859f27). Platform-specific and webfont predicates live in
 * `synthesis-decision.ts`; this constant is only that Linux/generic branch. */
export const FAUX_BOLD_WEIGHT_DELTA = 200;

/** Synthetic-oblique shear factor, in font-design (y-up) space: `x += .25*y`.
 * Mirrors Blink's `SkFont.setSkewX(-SK_Scalar1/4)`. */
export const OBLIQUE_SHEAR = 0.25;

/** Return a new command list sheared around the baseline. */
export function shearPathCommands(cmds: PathCommand[], factor: number): PathCommand[] {
  if (factor === 0 || cmds.length === 0) return cmds;
  return cmds.map((c) => {
    const args = c.args.slice();
    for (let i = 0; i + 1 < args.length; i += 2) {
      args[i] = Math.round(args[i] + factor * args[i + 1]);
      args[i + 1] = Math.round(args[i + 1]);
    }
    return { command: c.command, args };
  });
}

/**
 * Skia's synthetic-bold frame increment in local CSS px.
 *
 * Direct transcription of `kStdFakeBoldInterpKeys/Values` at pinned Skia
 * `src/core/SkTextFormatParams.h:15-29`: size/24 at <=9px, size/32 at
 * >=36px, and linear interpolation of the scale between the two knees.
 */
export function skiaFakeBoldStrokeExtraPx(fontSizePx: number): number {
  const lowScale = 1 / 24;
  const highScale = 1 / 32;
  const scale = fontSizePx <= 9
    ? lowScale
    : fontSizePx >= 36
      ? highScale
      : lowScale + ((fontSizePx - 9) / 27) * (highScale - lowScale);
  return fontSizePx * scale;
}

/** Scaler-record state after a single Blink text paint pass reaches
 * `useStrokeForFakeBold`. `frameWidthPx === -1` is Skia's unframed fill
 * sentinel. These are logical paint-stage records, independent of raster AA. */
export interface SkiaFakeBoldPaintStage {
  paint: "fill" | "stroke";
  frameWidthPx: number;
  frameAndFill: boolean;
  visible: boolean;
}

/** One SVG pass over the unchanged source outline. Roles are resolved to
 * concrete colors by the renderer, so this source-derived module owns geometry
 * without knowing CSS serialization. */
export interface FakeBoldSvgPaintPass {
  kind: "combined" | "author-stroke" | "synthetic-fill";
  fill: "source" | "none";
  stroke: "none" | "author" | "source-fill";
  strokeWidthPx: number;
  paintOrder?: "stroke fill";
}

export interface FakeBoldTextPaintPlan {
  /** Fake bold never mutates or substitutes the glyph outline. */
  outline: "source";
  platform: NodeJS.Platform;
  extraPx: number;
  /** Blink/Skia stages in actual paint order, before safe SVG coalescing. */
  stages: SkiaFakeBoldPaintStage[];
  /** Minimum SVG passes that are paint-equivalent to `stages`. */
  svgPasses: FakeBoldSvgPaintPass[];
}

/**
 * Transcribe Skia's fake-bold scaler records and lower them to SVG paint passes.
 *
 * The source mechanism is platform-invariant for Chromium's FreeType,
 * CoreText, DirectWrite, and Fontations backends. `platform` is retained in every record so
 * all-platform oracle rows prove that invariance instead of silently exercising
 * only the host branch.
 *
 * Fill-first can coalesce to one SVG pass: the later author stroke at
 * `w + extra` completely covers the earlier fill-color frame at `extra`.
 * Stroke-first with a visible fill cannot: emit the widened author-stroke ring,
 * then the source fill with its own fill-color `extra` frame. This exactly
 * preserves both Skia passes and their colors over the unchanged outline.
 */
export function resolveFakeBoldTextPaint(opts: {
  strokeWidthPx: number;
  strokeFirst: boolean;
  fillIsTransparent: boolean;
  faceLacksWeight: boolean;
  fontSizePx: number;
  platform?: NodeJS.Platform;
}): FakeBoldTextPaintPlan {
  const platform = opts.platform ?? process.platform;
  const strokeActive = opts.strokeWidthPx > 0;
  const extraPx = opts.faceLacksWeight
    ? skiaFakeBoldStrokeExtraPx(opts.fontSizePx)
    : 0;

  const fillStage: SkiaFakeBoldPaintStage = extraPx > 0
    ? {
        paint: "fill",
        frameWidthPx: extraPx,
        frameAndFill: true,
        visible: !opts.fillIsTransparent,
      }
    : {
        paint: "fill",
        frameWidthPx: -1,
        frameAndFill: false,
        visible: !opts.fillIsTransparent,
      };
  const strokeStage: SkiaFakeBoldPaintStage | null = strokeActive
    ? {
        paint: "stroke",
        frameWidthPx: opts.strokeWidthPx + extraPx,
        frameAndFill: false,
        visible: true,
      }
    : null;
  const stages = strokeStage == null
    ? [fillStage]
    : opts.strokeFirst
      ? [strokeStage, fillStage]
      : [fillStage, strokeStage];

  let svgPasses: FakeBoldSvgPaintPass[];
  if (strokeStage == null) {
    svgPasses = [{
      kind: "combined",
      fill: "source",
      stroke: extraPx > 0 ? "source-fill" : "none",
      strokeWidthPx: extraPx,
    }];
  } else if (opts.strokeFirst && fillStage.visible && extraPx > 0) {
    // Two colors remain visible, so preserve the two source passes verbatim.
    svgPasses = [
      {
        kind: "author-stroke",
        fill: "none",
        stroke: "author",
        strokeWidthPx: strokeStage.frameWidthPx,
      },
      {
        kind: "synthetic-fill",
        fill: "source",
        stroke: "source-fill",
        strokeWidthPx: extraPx,
      },
    ];
  } else {
    svgPasses = [{
      kind: "combined",
      fill: "source",
      stroke: "author",
      strokeWidthPx: strokeStage.frameWidthPx,
      ...(opts.strokeFirst ? { paintOrder: "stroke fill" as const } : {}),
    }];
  }

  return { outline: "source", platform, extraPx, stages, svgPasses };
}

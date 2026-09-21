import sharp from "sharp";

const RASTER_PATTERN = /data:image\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/gi;

function normalizeStableNondeterminism(svg: string): string {
  return svg
    .replace(/data:font\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "data:font/ttf;base64,__FONT__")
    .replace(/scrl-[a-z0-9]+/g, "scrl-XX");
}

function rasterPayloads(svg: string): Array<{ format: string; base64: string }> {
  return [...svg.matchAll(RASTER_PATTERN)].map((match) => ({
    format: match[1].toLowerCase(),
    base64: match[2],
  }));
}

async function rasterPayloadsEquivalent(
  golden: { format: string; base64: string },
  actual: { format: string; base64: string },
): Promise<boolean> {
  if (golden.format !== actual.format) return false;
  if (golden.base64 === actual.base64) return true;

  const [goldenPixels, actualPixels] = await Promise.all([
    sharp(Buffer.from(golden.base64, "base64")).raw().toBuffer({ resolveWithObject: true }),
    sharp(Buffer.from(actual.base64, "base64")).raw().toBuffer({ resolveWithObject: true }),
  ]);
  const sameShape =
    goldenPixels.info.width === actualPixels.info.width &&
    goldenPixels.info.height === actualPixels.info.height &&
    goldenPixels.info.channels === actualPixels.info.channels;
  if (!sameShape) return false;

  let changedPixels = 0;
  const channels = goldenPixels.info.channels;
  for (let offset = 0; offset < goldenPixels.data.length; offset += channels) {
    let changed = false;
    for (let channel = 0; channel < channels; channel++) {
      const delta = Math.abs(goldenPixels.data[offset + channel] - actualPixels.data[offset + channel]);
      if (delta > 1) return false;
      if (delta !== 0) changed = true;
    }
    if (changed && ++changedPixels > 2) return false;
  }
  return true;
}

/**
 * Preserve byte-exact SVG comparison while tolerating the measured Chromium
 * raster floor: at most two pixels may differ, and by at most one channel step.
 */
export async function animateGoldensEquivalent(goldenSvg: string, actualSvg: string): Promise<boolean> {
  const golden = normalizeStableNondeterminism(goldenSvg);
  const actual = normalizeStableNondeterminism(actualSvg);
  if (golden === actual) return true;

  const goldenRasters = rasterPayloads(golden);
  const actualRasters = rasterPayloads(actual);
  if (goldenRasters.length !== actualRasters.length) return false;
  if (golden.replace(RASTER_PATTERN, "__RASTER__") !== actual.replace(RASTER_PATTERN, "__RASTER__")) return false;

  for (let index = 0; index < goldenRasters.length; index++) {
    if (!(await rasterPayloadsEquivalent(goldenRasters[index], actualRasters[index]))) return false;
  }
  return true;
}
